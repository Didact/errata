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

export interface AgentStreamResult {
  eventStream: ReadableStream<string>
  completion: Promise<AgentStreamCompletion>
}

// Backwards-compat aliases
export type ChatStreamEvent = AgentStreamEvent
export type ChatResult = AgentStreamResult
