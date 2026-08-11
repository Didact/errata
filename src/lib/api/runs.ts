import { apiFetch, fetchGetEventStream } from './client'
import { isTerminalChatEvent, type ChatEvent, type RunStatus, type RunSummary, type SequencedChatEvent } from './types'

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

/**
 * How long to wait for anything before treating the stream as dead. The server
 * keepalives every 5s, so silence this long means the connection is gone even
 * though the socket still looks open — and a reader that never resolves would
 * otherwise hang here forever with no stream end to trigger a reconnect.
 */
const STALL_TIMEOUT_MS = 15_000

class StreamStalled extends Error {
  constructor() {
    super('Stream stalled')
    this.name = 'StreamStalled'
  }
}

async function readWithStallTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalled()), STALL_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface ConsumeRunResult {
  runId: string | null
  status: RunStatus
  error?: string
}

/**
 * Read a run to completion, reconnecting across dropped connections.
 *
 * The imperative counterpart to `useRunStream`, for call sites that just
 * accumulate text inside an async handler. It gives them the important half of
 * the guarantee — a dropped connection or a backgrounded tab resumes from the
 * cursor instead of truncating — without restructuring them around a hook.
 * (Surviving an unmount or a page reload needs the hook, which persists the
 * run id.)
 *
 * `onEvent` sees every event exactly once, deduped by `seq`.
 */
export async function consumeRun(
  storyId: string,
  initial: ReadableStream<SequencedChatEvent>,
  onEvent: (event: ChatEvent) => void,
): Promise<ConsumeRunResult> {
  let runId: string | null = null
  let cursor = 0
  let attempt = 0
  let result: ConsumeRunResult | null = null

  /** Returns true if the run reached a terminal event. */
  async function read(stream: ReadableStream<SequencedChatEvent>): Promise<boolean> {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await readWithStallTimeout(reader)
        if (done) return false

        const event = value
        if (typeof event.seq === 'number') {
          if (event.seq < cursor) continue
          cursor = event.seq + 1
        }
        if (event.type === 'run-start') runId = event.runId

        onEvent(event)

        if (isTerminalChatEvent(event)) {
          result = event.type === 'error'
            ? { runId, status: 'error', error: event.error }
            : { runId, status: event.status }
          return true
        }
      }
    } catch {
      // Stalled or errored mid-stream: not a result, so the caller reconnects.
      return false
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  if (await read(initial)) return result!

  // The stream ended without a terminal event, which means the connection
  // dropped rather than the run finishing.
  while (runId) {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
    await new Promise(r => setTimeout(r, delay))
    try {
      const stream = await runs.events(storyId, runId, cursor)
      attempt = 0
      if (await read(stream)) return result!
    } catch (err) {
      // A 404 means the run aged out; there is nothing left to reattach to.
      if ((err as { status?: number })?.status === 404) {
        return { runId, status: 'error', error: 'This generation is no longer available' }
      }
      attempt += 1
    }
  }

  return { runId, status: 'error', error: 'Connection lost' }
}

export const runs = {
  /** List runs for a story. `active` filters to generations still in flight. */
  list: (storyId: string, opts?: { active?: boolean; scopeId?: string | null }) => {
    const params = new URLSearchParams()
    if (opts?.active) params.set('active', '1')
    if (opts?.scopeId != null) params.set('scopeId', opts.scopeId)
    const query = params.toString()
    return apiFetch<RunSummary[]>(`/stories/${storyId}/runs${query ? `?${query}` : ''}`)
  },

  get: (storyId: string, runId: string) =>
    apiFetch<RunSummary>(`/stories/${storyId}/runs/${runId}`),

  /**
   * Reattach to a run, replaying everything from `cursor` and then following
   * live. This is what turns a dropped connection into a non-event.
   */
  events: (storyId: string, runId: string, cursor = 0) =>
    fetchGetEventStream(
      `/stories/${storyId}/runs/${runId}/events?cursor=${cursor}`,
    ) as Promise<ReadableStream<SequencedChatEvent>>,

  /** Explicit user Stop — the only thing that ends a generation early. */
  cancel: (storyId: string, runId: string) =>
    apiFetch<{ ok: boolean; cancelled: boolean }>(
      `/stories/${storyId}/runs/${runId}/cancel`,
      { method: 'POST' },
    ),
}
