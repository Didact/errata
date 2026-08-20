/**
 * Accumulates a streaming assistant turn and persists it incrementally.
 *
 * The point is that the stored turn is never behind reality in a way that
 * matters: tool calls are written as soon as they resolve, so a turn that dies
 * mid-flight still shows exactly which edits were applied. That's what stops
 * the next turn from re-applying them.
 *
 * Writes are throttled to avoid a filesystem write per token, but a tool result
 * always forces one through — text can be reconstructed from the event log,
 * whereas a missing tool call is what causes duplicated edits.
 */

import type { AgentStreamEvent } from '../agents/stream-types'
import type { ServerRunEvent } from './types'

export interface TurnToolCall {
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface TurnSnapshot {
  content: string
  reasoning: string
  toolCalls: TurnToolCall[]
}

export interface TurnTracker {
  /** Feed every event the run emits. Never throws. */
  onEvent(event: AgentStreamEvent | ServerRunEvent): void
  /** Current accumulated state. */
  snapshot(): TurnSnapshot
  /** Write pending state and wait for all writes to settle. */
  flush(): Promise<void>
}

const DEFAULT_THROTTLE_MS = 500

export function createTurnTracker(opts: {
  write: (snapshot: TurnSnapshot) => Promise<unknown>
  throttleMs?: number
}): TurnTracker {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS

  let content = ''
  let reasoning = ''
  const order: string[] = []
  const byId = new Map<string, TurnToolCall>()

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<unknown> = Promise.resolve()
  let dirty = false

  function snapshot(): TurnSnapshot {
    return {
      content,
      reasoning,
      toolCalls: order.map(id => ({ ...byId.get(id)! })),
    }
  }

  function doWrite(): void {
    if (!dirty) return
    dirty = false
    const snap = snapshot()
    // Chained so writes land in order; failures are swallowed because a
    // persistence hiccup must not abort the generation.
    inFlight = inFlight.then(() => opts.write(snap)).catch(() => {})
  }

  function schedule(immediate: boolean): void {
    dirty = true
    if (immediate) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      doWrite()
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      doWrite()
    }, throttleMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    onEvent(event) {
      try {
        switch (event.type) {
          case 'text':
            content += event.text
            schedule(false)
            break
          case 'reasoning':
            reasoning += event.text
            schedule(false)
            break
          case 'tool-call': {
            if (!byId.has(event.id)) order.push(event.id)
            byId.set(event.id, { toolName: event.toolName, args: event.args })
            schedule(false)
            break
          }
          case 'tool-result': {
            const existing = byId.get(event.id)
            if (existing) {
              existing.result = event.result
            } else {
              order.push(event.id)
              byId.set(event.id, { toolName: event.toolName, args: {}, result: event.result })
            }
            // Force a write: a tool result is the record that an edit landed.
            schedule(true)
            break
          }
          case 'tool-error': {
            const existing = byId.get(event.id)
            if (existing) {
              existing.error = event.error
            } else {
              order.push(event.id)
              byId.set(event.id, { toolName: event.toolName, args: {}, error: event.error })
            }
            schedule(true)
            break
          }
        }
      } catch {
        // Accumulation must never break the generation.
      }
    },

    snapshot,

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // Loop: a write scheduled while we awaited the previous one still counts.
      do {
        doWrite()
        await inFlight
      } while (dirty)
    },
  }
}
