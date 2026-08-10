import type { AgentStreamEvent, AgentStreamCompletion } from './stream-types'

/**
 * Drives an AI SDK v6 fullStream to completion, pushing normalized events to
 * `onEvent` and accumulating the final result.
 *
 * Handles: text-delta, reasoning-delta, tool-call, tool-result, tool-error,
 * finish-step, finish.
 *
 * This is a *push* contract on purpose. The previous implementation wrote into
 * a ReadableStream that the HTTP response consumed directly, so a disconnected
 * client made the next `enqueue` throw — which aborted the loop and rejected
 * the completion, losing the assistant turn along with any tool calls that had
 * already mutated fragments. Here the consumer cannot influence the producer:
 * `onEvent` is expected not to throw, and the loop runs to completion regardless
 * of who is (or is not) listening.
 *
 * @param onEvent - receives each normalized event. Must not throw; the run
 *   registry's `emit` satisfies this.
 */
export async function consumeAgentStream(
  fullStream: AsyncIterable<unknown>,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentStreamCompletion> {
  let fullText = ''
  let fullReasoning = ''
  const toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = []
  // Correlate a tool-result back to the args from its tool-call event.
  const toolCallArgs = new Map<string, Record<string, unknown>>()
  let lastFinishReason = 'unknown'
  let stepCount = 0
  let aborted = false

  for await (const part of fullStream) {
    let event: AgentStreamEvent | null = null
    const p = part as Record<string, unknown>
    const type = (p as { type?: string }).type

    switch (type) {
      // The AI SDK reports a provider/transport failure as a stream *part*,
      // not by rejecting the iterator. Swallowing it records a failed turn as
      // a successful empty one — a blank reply the author can't distinguish
      // from the model choosing to say nothing. Throw so the run ends 'error'
      // with whatever text and tool calls did land.
      case 'error': {
        const raw = p.error
        throw raw instanceof Error ? raw : new Error(String(raw))
      }
      // The underlying call was aborted (an explicit cancel). Stop consuming;
      // the run layer derives the final status from the abort signal.
      case 'abort':
        aborted = true
        break

      case 'text-delta': {
        const text = (p.text ?? '') as string
        fullText += text
        event = { type: 'text', text }
        break
      }
      case 'reasoning-delta': {
        const text = (p.text ?? '') as string
        fullReasoning += text
        event = { type: 'reasoning', text }
        break
      }
      case 'tool-call': {
        const input = (p.input ?? {}) as Record<string, unknown>
        const toolCallId = p.toolCallId as string
        toolCallArgs.set(toolCallId, input)
        event = {
          type: 'tool-call',
          id: toolCallId,
          toolName: p.toolName as string,
          args: input,
        }
        break
      }
      case 'tool-result': {
        const toolCallId = p.toolCallId as string
        const toolName = (p.toolName as string) ?? ''
        toolCalls.push({ toolName, args: toolCallArgs.get(toolCallId) ?? {}, result: p.output })
        event = {
          type: 'tool-result',
          id: toolCallId,
          toolName,
          result: p.output,
        }
        break
      }
      case 'tool-error': {
        const toolCallId = p.toolCallId as string
        const toolName = (p.toolName as string) ?? ''
        const errVal = p.error
        event = {
          type: 'tool-error',
          id: toolCallId,
          toolName,
          error: errVal instanceof Error ? errVal.message : String(errVal),
        }
        break
      }
      // `finish-step` fires once per LLM step; `finish` fires once for the
      // whole generation. Count steps, capture the final reason.
      case 'finish-step':
        stepCount++
        break
      case 'finish':
        lastFinishReason = (p.finishReason as string) ?? 'unknown'
        break
    }

    if (event) {
      onEvent(event)
    }
    if (aborted) break
  }

  onEvent({ type: 'finish', finishReason: lastFinishReason, stepCount })

  return {
    text: fullText,
    reasoning: fullReasoning,
    toolCalls,
    stepCount,
    finishReason: lastFinishReason,
  }
}
