/**
 * Event and status vocabulary shared by every server-authoritative LLM run.
 *
 * A run's event log is the authoritative record of what a generation emitted.
 * Clients read it through a cursor, so every delivered line carries a `seq`.
 */

/** Which surface started the run. Used for scoping and reattachment. */
export type RunKind =
  | 'librarian.chat'
  | 'generation'
  | 'character-chat'
  | 'librarian.refine'
  | 'librarian.prose-transform'

export type RunStatus = 'running' | 'complete' | 'error' | 'cancelled'

/** A run is terminal once it leaves 'running'. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status !== 'running'
}

/**
 * Events a run body may emit. This is a superset of the old AgentStreamEvent —
 * the generation route also emits prewriter/phase/clarify events.
 *
 * `run-start`, `run-end`, and `error` are produced by the registry itself, not
 * by run bodies.
 */
export type ServerRunEvent =
  // --- Registry-produced framing ---
  | { type: 'run-start'; runId: string; kind: RunKind; status: RunStatus }
  | { type: 'run-end'; status: RunStatus }
  | { type: 'error'; error: string }
  // --- Agent events ---
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'tool-error'; id: string; toolName: string; error: string }
  | { type: 'finish'; finishReason: string; stepCount: number; stopped?: boolean }
  // --- Generation-specific events ---
  | { type: 'phase'; phase: string }
  | { type: 'prewriter-text'; text: string }
  | { type: 'prewriter-reset' }
  | { type: 'prewriter-directions'; directions: unknown[] }
  | { type: 'clarify-questions'; questions: unknown[]; round: number }

/** An event as delivered to a subscriber: the event plus its cursor position. */
export type SequencedRunEvent = ServerRunEvent & { seq: number }

/**
 * Event types whose consecutive `text` payloads the registry coalesces before
 * assigning a seq. Batching keeps the retained log small on long generations
 * and produces fewer, larger writes — which survive a flaky mobile link better.
 */
export const BATCHABLE_EVENT_TYPES = new Set(['text', 'reasoning', 'prewriter-text'])

/** Public summary of a run, for the "what's still running?" listing. */
export interface RunSummary {
  id: string
  storyId: string
  kind: RunKind
  scopeId: string | null
  status: RunStatus
  startedAt: string
  finishedAt?: string
  error?: string
  /** Number of events emitted so far — a client attaching fresh reads from 0. */
  seq: number
}

/**
 * Abort reason used when the watchdog stops a run, distinguishing it from an
 * explicit user cancel (which aborts with no reason). A run body must tell the
 * two apart: a Stop is the author's choice and records the turn as 'cancelled',
 * whereas a timeout is a failure that needs to say so.
 */
export const RUN_TIMEOUT_REASON = 'errata:run-timeout'

/** True when this signal was aborted by the run watchdog rather than by the author. */
export function abortedByTimeout(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === RUN_TIMEOUT_REASON
}

/** True when the author explicitly stopped the run. */
export function abortedByUser(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== RUN_TIMEOUT_REASON
}
