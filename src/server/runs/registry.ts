/**
 * Server-authoritative registry of in-flight LLM runs.
 *
 * Every LLM generation — librarian chat, prose generation, character chat,
 * refine, prose-transform — executes as a *run*: a detached async body that
 * appends events to an in-memory log. HTTP requests are only ever *subscribers*
 * to that log, reading from a cursor.
 *
 * The invariant that makes this work: `emit` never throws and never blocks on a
 * consumer. A client that disconnects (a backgrounded phone tab, a dropped
 * mobile connection) simply stops reading; the run body is unaffected and runs
 * to completion, persisting its result. Only an explicit `cancelRun` aborts.
 *
 * Scope: in-process only, like `withKeyLock` and `active-registry`. The app is a
 * single Bun process, so an in-memory log is sufficient. Durability across a
 * server restart comes from each surface persisting incrementally as it streams,
 * not from journalling this log.
 */

import { withBranch, getActiveBranchId } from '../fragments/branches'
import { createLogger } from '../logging'
import {
  BATCHABLE_EVENT_TYPES,
  type RunKind,
  type RunStatus,
  type RunSummary,
  type SequencedRunEvent,
  type ServerRunEvent,
} from './types'

const logger = createLogger('runs')

/** How long a finished run stays readable, so a phone that wakes up late can still pull the tail. */
const RETENTION_MS = 10 * 60 * 1000

/** How long consecutive text deltas accumulate before being flushed as one event. */
const BATCH_FLUSH_MS = 50

/** Safety cap on a single run's retained event log. */
const MAX_EVENTS = 20_000

/**
 * How long a subscriber may sit silent before a blank keepalive line is sent.
 *
 * A generation routinely goes tens of seconds without emitting — model latency
 * on a large context, a slow tool. Anything between the phone and the server
 * that tracks idleness will drop such a connection: carrier NAT (commonly
 * 30s–2min), Cloudflare tunnels, corporate proxies. The client recovers by
 * reattaching, but the author sees a needless "reconnecting" mid-answer.
 *
 * Measured: our own stack does *not* impose one. Nitro bundles srvx's Node
 * adapter (`.output/server/_libs/srvx.mjs` contains no `Bun.serve`), and Node's
 * http server has no idle timeout for a streaming response — verified by
 * holding a response silent for 20s with keepalives disabled. So this guards
 * the network path, not the runtime.
 *
 * 5s is well under the tightest window we might meet and costs one byte per
 * idle subscriber per interval.
 */
const KEEPALIVE_MS = 5_000

export interface Run {
  id: string
  storyId: string
  kind: RunKind
  /** conversationId | fragmentId | null — identifies which UI surface owns this run. */
  scopeId: string | null
  /** Client-supplied idempotency key, so a retried POST attaches instead of starting a second run. */
  clientRequestId?: string
  /** Branch pinned at start; the body outlives the request, so it can't rely on ambient ALS. */
  branchId: string
  status: RunStatus
  events: SequencedRunEvent[]
  error?: string
  startedAt: string
  finishedAt?: string
  /** Resolves when the run body settles. Never rejects. */
  done: Promise<void>
  /** Woken whenever events are appended or the status changes. */
  waiters: Array<() => void>
  abortController: AbortController
  /** Set once the event log hit its cap, so the warning is logged only once. */
  truncated?: boolean
  /** Pending coalesced text, not yet assigned a seq. */
  pending: { type: string; text: string } | null
  pendingTimer: ReturnType<typeof setTimeout> | null
  gcTimer: ReturnType<typeof setTimeout> | null
}

const runs = new Map<string, Run>()
let counter = 0

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// --- Internals ---

function wake(run: Run): void {
  const waiters = run.waiters.splice(0)
  for (const resolve of waiters) {
    try {
      resolve()
    } catch {
      // A subscriber blowing up must never affect the producer.
    }
  }
}

/** Terminal events tell a client "this run is over" rather than "you disconnected". */
function isTerminal(event: ServerRunEvent): boolean {
  return event.type === 'run-end' || event.type === 'error'
}

/**
 * Append an event to the log with the next seq. Never throws.
 *
 * The {@link MAX_EVENTS} cap never applies to terminal events. Dropping a
 * `run-end` would leave every subscriber reading a stream that closes with no
 * terminal event — which the client, correctly, reads as a dropped connection
 * and retries forever. Truncating the live view of a pathological run is
 * acceptable; stranding the client is not. (The stored turn is unaffected: it
 * comes from the turn tracker, not this log.)
 */
function append(run: Run, event: ServerRunEvent): void {
  if (run.events.length >= MAX_EVENTS && !isTerminal(event)) {
    if (!run.truncated) {
      run.truncated = true
      logger.warn('Run event log hit its cap; live view will truncate', {
        runId: run.id,
        kind: run.kind,
        cap: MAX_EVENTS,
      })
    }
    return
  }
  run.events.push({ ...event, seq: run.events.length } as SequencedRunEvent)
  wake(run)
}

/** Materialize any coalesced text into a real, sequenced event. */
function flushPending(run: Run): void {
  if (run.pendingTimer) {
    clearTimeout(run.pendingTimer)
    run.pendingTimer = null
  }
  const pending = run.pending
  if (!pending) return
  run.pending = null
  append(run, { type: pending.type, text: pending.text } as ServerRunEvent)
}

/**
 * Append an event to a run's log.
 *
 * Consecutive text-ish events are coalesced in a staging buffer for up to
 * {@link BATCH_FLUSH_MS} before being assigned a seq. Coalescing happens *before*
 * sequencing, so a subscriber can never miss text appended to an event it has
 * already delivered — seqs are immutable once emitted.
 *
 * Never throws: a run body must not be able to fail because of the event log.
 */
export function emitRunEvent(run: Run, event: ServerRunEvent): void {
  try {
    if (run.status !== 'running') return

    const text = (event as { text?: string }).text
    if (BATCHABLE_EVENT_TYPES.has(event.type) && typeof text === 'string') {
      // A different batchable type interrupts the current batch (keeps ordering).
      if (run.pending && run.pending.type !== event.type) {
        flushPending(run)
      }
      if (run.pending) {
        run.pending.text += text
      } else {
        run.pending = { type: event.type, text }
      }
      if (!run.pendingTimer) {
        run.pendingTimer = setTimeout(() => {
          run.pendingTimer = null
          flushPending(run)
        }, BATCH_FLUSH_MS)
        // Don't let a pending flush hold the process (or a test runner) open.
        ;(run.pendingTimer as { unref?: () => void }).unref?.()
      }
      return
    }

    // Any non-batchable event flushes pending text first, preserving order
    // between prose and the tool calls interleaved with it.
    flushPending(run)
    append(run, event)
  } catch (err) {
    logger.error('Failed to emit run event', {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function finishRun(run: Run, status: RunStatus, error?: string): void {
  if (run.status !== 'running') return
  flushPending(run)

  if (error) {
    run.error = error
    append(run, { type: 'error', error })
  }

  run.status = status
  run.finishedAt = new Date().toISOString()
  append(run, { type: 'run-end', status })
  wake(run)

  run.gcTimer = setTimeout(() => {
    runs.delete(run.id)
  }, RETENTION_MS)
  ;(run.gcTimer as { unref?: () => void }).unref?.()
}

// --- Public API ---

export interface StartRunOptions {
  dataDir: string
  storyId: string
  kind: RunKind
  scopeId?: string | null
  clientRequestId?: string
  /**
   * The generation itself. Runs detached from any HTTP request, inside the
   * run's pinned branch scope. Throwing marks the run 'error'; returning marks
   * it 'complete'. Aborting `signal` (explicit user cancel) should unwind here.
   *
   * Persist results *inside* the body: the run is not marked finished until the
   * body settles, so a client that sees `run-end` and refetches always reads
   * settled state.
   */
  body: (ctx: {
    runId: string
    emit: (event: ServerRunEvent) => void
    signal: AbortSignal
  }) => Promise<void>
}

/**
 * Register and start a run. Resolves as soon as the run is registered — the
 * body keeps executing in the background.
 */
export async function startRun(opts: StartRunOptions): Promise<Run> {
  // Pin the branch now. The body outlives the request, so it must not rely on
  // the request's AsyncLocalStorage scope, and switching timelines mid-run must
  // not redirect its writes.
  const branchId = await getActiveBranchId(opts.dataDir, opts.storyId)

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const run: Run = {
    id: makeRunId(),
    storyId: opts.storyId,
    kind: opts.kind,
    scopeId: opts.scopeId ?? null,
    ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}),
    branchId,
    status: 'running',
    events: [],
    startedAt: new Date().toISOString(),
    done,
    waiters: [],
    abortController: new AbortController(),
    pending: null,
    pendingTimer: null,
    gcTimer: null,
  }
  runs.set(run.id, run)

  append(run, { type: 'run-start', runId: run.id, kind: run.kind, status: 'running' })

  const emit = (event: ServerRunEvent) => emitRunEvent(run, event)

  // Detached: deliberately not awaited. The HTTP handler returns immediately
  // and the body outlives the request.
  void withBranch(
    opts.dataDir,
    opts.storyId,
    () => opts.body({ runId: run.id, emit, signal: run.abortController.signal }),
    branchId,
  ).then(
    () => {
      finishRun(run, run.abortController.signal.aborted ? 'cancelled' : 'complete')
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err)
      if (run.abortController.signal.aborted) {
        logger.info('Run cancelled', { runId: run.id, kind: run.kind, storyId: run.storyId })
        finishRun(run, 'cancelled')
      } else {
        logger.error('Run failed', { runId: run.id, kind: run.kind, storyId: run.storyId, error: message })
        finishRun(run, 'error', message)
      }
    },
  ).catch(() => {
    // finishRun is defensive; this only guards against an unhandled rejection.
  }).finally(() => resolveDone())

  return run
}

export function getRun(runId: string): Run | null {
  return runs.get(runId) ?? null
}

export function toRunSummary(run: Run): RunSummary {
  return {
    id: run.id,
    storyId: run.storyId,
    kind: run.kind,
    scopeId: run.scopeId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    seq: run.events.length,
  }
}

export interface ListRunsFilter {
  scopeId?: string | null
  kind?: RunKind
  /** Only runs that are still executing. */
  active?: boolean
}

export function listRuns(storyId: string, filter: ListRunsFilter = {}): RunSummary[] {
  const result: RunSummary[] = []
  for (const run of runs.values()) {
    if (run.storyId !== storyId) continue
    if (filter.active && run.status !== 'running') continue
    if (filter.kind && run.kind !== filter.kind) continue
    if (filter.scopeId !== undefined && run.scopeId !== filter.scopeId) continue
    result.push(toRunSummary(run))
  }
  return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/**
 * Find a still-running run for a UI surface, so a reconnecting or retrying
 * client attaches to it instead of starting a competing generation.
 */
export function findLiveRun(storyId: string, kind: RunKind, scopeId: string | null): Run | null {
  for (const run of runs.values()) {
    if (run.status !== 'running') continue
    if (run.storyId !== storyId || run.kind !== kind || run.scopeId !== scopeId) continue
    return run
  }
  return null
}

/**
 * Find a run by the client's idempotency key. Includes finished runs within the
 * retention window, so a retry that arrives after completion still reads the
 * original result instead of re-running the same edits.
 */
export function findRunByClientRequestId(storyId: string, clientRequestId: string): Run | null {
  for (const run of runs.values()) {
    if (run.storyId === storyId && run.clientRequestId === clientRequestId) return run
  }
  return null
}

/** Explicit user cancel — the only thing that aborts a run. */
export function cancelRun(runId: string): boolean {
  const run = runs.get(runId)
  if (!run || run.status !== 'running') return false
  run.abortController.abort()
  wake(run)
  return true
}

/**
 * NDJSON view of a run's log: replays `events[cursor..]`, then follows live,
 * then closes once the run is terminal and the cursor is drained.
 *
 * Cancelling this stream (the client disconnecting) only drops the subscriber —
 * it never touches the run.
 */
export function subscribeRun(runId: string, cursor = 0): ReadableStream<string> | null {
  const run = runs.get(runId)
  if (!run) return null

  // Materialize buffered text so a reattaching client sees current state
  // immediately rather than waiting out the batch window.
  flushPending(run)

  let position = Math.max(0, cursor)
  let closed = false
  /** Unparks an in-flight keepalive wait when the consumer disconnects. */
  let release: (() => void) | null = null

  return new ReadableStream<string>({
    // The consumer went away. Break the loop below so it stops parking on
    // waiters and never enqueues into a dead controller — the run itself is
    // deliberately untouched.
    cancel() {
      closed = true
      release?.()
    },

    async pull(controller) {
      while (!closed) {
        while (!closed && position < run.events.length) {
          controller.enqueue(JSON.stringify(run.events[position++]) + '\n')
        }
        if (closed) return

        if (run.status !== 'running') {
          controller.close()
          return
        }

        // Nothing buffered and still running — wait to be woken, but never sit
        // silent for long. A generation can go a while without emitting (model
        // latency, a slow tool), and anything between the phone and the server
        // — carrier NAT, a Cloudflare tunnel, a reverse proxy — will drop a TCP
        // connection it thinks has gone idle. That surfaces as a spurious
        // "reconnecting" mid-generation. A blank line is valid NDJSON padding
        // that both client parsers already skip, so it keeps the socket warm
        // without touching the cursor or the protocol.
        const woken = await waitForEvent(run, (fn) => { release = fn })
        release = null
        if (closed) return
        if (!woken) controller.enqueue('\n')
      }
    },
  })
}

/**
 * Wait for the run to emit, for the keepalive interval to elapse, or for the
 * subscriber to be released. Resolves true only if woken by an actual event.
 *
 * `registerRelease` hands the caller a function that unparks this wait early —
 * used when the consumer disconnects, so the waiter is dropped immediately
 * instead of lingering on the run's list until the next keepalive tick.
 */
function waitForEvent(run: Run, registerRelease: (release: () => void) => void): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const finish = (woken: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const idx = run.waiters.indexOf(waiter)
      if (idx !== -1) run.waiters.splice(idx, 1)
      resolve(woken)
    }

    const waiter = () => finish(true)

    timer = setTimeout(() => finish(false), KEEPALIVE_MS)
    ;(timer as { unref?: () => void }).unref?.()

    run.waiters.push(waiter)
    registerRelease(() => finish(false))
  })
}

/** Test/shutdown helper: drop all runs and their timers. */
export function clearRuns(): void {
  for (const run of runs.values()) {
    if (run.pendingTimer) clearTimeout(run.pendingTimer)
    if (run.gcTimer) clearTimeout(run.gcTimer)
  }
  runs.clear()
}
