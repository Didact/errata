// NDJSON event types emitted by agent streams
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'tool-error'; id: string; toolName: string; error: string }
  | { type: 'finish'; finishReason: string; stepCount: number }

export interface AgentStreamCompletion {
  text: string
  reasoning: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  stepCount: number
  finishReason: string
}

/**
 * A prepared but not-yet-started agent generation.
 *
 * Streaming agents return this instead of a live ReadableStream so that the
 * caller — the run registry — decides when the generation runs and where its
 * events go. Nothing about an HTTP request's lifetime can reach the generation:
 * disconnecting a client just means nobody is reading the run's event log.
 */
export interface AgentStreamResult {
  /**
   * Drive the generation to completion, pushing events to `onEvent`.
   * Call exactly once. `onEvent` must not throw.
   */
  run(onEvent: (event: AgentStreamEvent) => void): Promise<AgentStreamCompletion>
  /** Abort the underlying LLM call. Explicit user cancel only. */
  cancel(): void
}

// Backwards-compat aliases
export type ChatStreamEvent = AgentStreamEvent
export type ChatResult = AgentStreamResult
