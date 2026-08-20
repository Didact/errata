import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { consumeRun } from '@/lib/api/runs'
import type { ChatEvent, SequencedChatEvent } from '@/lib/api/types'

/**
 * Client-side half of the disconnect contract.
 *
 * `consumeRun` (and `useRunStream`, which shares this logic) treats a stream
 * that ends *without* a terminal run-end/error as a dropped connection and
 * resumes from its cursor. These tests pin that: no lost events, no duplicates,
 * and a clean stop when the run is genuinely over.
 */

function streamOf(events: SequencedChatEvent[]): ReadableStream<SequencedChatEvent> {
  return new ReadableStream<SequencedChatEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e)
      controller.close()
    },
  })
}

const seq = (n: number, e: ChatEvent): SequencedChatEvent => ({ ...e, seq: n } as SequencedChatEvent)

describe('consumeRun', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Run the promise while draining the backoff timers it waits on. */
  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    let settled = false
    void promise.finally(() => { settled = true })
    while (!settled) {
      await vi.advanceTimersByTimeAsync(1000)
    }
    return promise
  }

  it('reads a complete run without reconnecting', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const seen: ChatEvent[] = []
    const result = await consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'text', text: 'hello' }),
      seq(2, { type: 'run-end', status: 'complete' }),
    ]), e => seen.push(e))

    expect(result).toEqual({ runId: 'run-1', status: 'complete' })
    expect(seen.map(e => e.type)).toEqual(['run-start', 'text', 'run-end'])
    // No terminal-less end, so no reattachment request.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The core client-side guarantee: a stream that just stops is a disconnect,
  // and the missing events are fetched from the cursor rather than lost.
  it('reconnects from the cursor when the stream ends without a terminal event', async () => {
    const body = [
      seq(2, { type: 'text', text: 'world' }),
      seq(3, { type: 'run-end', status: 'complete' }),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'

    const fetchSpy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const seen: ChatEvent[] = []
    const result = await runWithTimers(consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'text', text: 'hello ' }),
      // ...and then nothing. The phone went to sleep.
    ]), e => seen.push(e)))

    expect(result).toEqual({ runId: 'run-1', status: 'complete' })
    // Resumed at exactly the next unseen seq.
    expect(fetchSpy).toHaveBeenCalledWith('/api/stories/story-1/runs/run-1/events?cursor=2')
    // Every event, exactly once, in order.
    expect(seen.map(e => e.type)).toEqual(['run-start', 'text', 'text', 'run-end'])
    expect(seen.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join(''))
      .toBe('hello world')
  })

  it('drops replayed events the caller has already seen', async () => {
    // The server replays from the requested cursor, but a defensive overlap
    // must not double-apply anything.
    const body = [
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'text', text: 'hello ' }),
      seq(2, { type: 'text', text: 'world' }),
      seq(3, { type: 'run-end', status: 'complete' }),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const seen: ChatEvent[] = []
    await runWithTimers(consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'text', text: 'hello ' }),
    ]), e => seen.push(e)))

    expect(seen.map(e => e.type)).toEqual(['run-start', 'text', 'text', 'run-end'])
    expect(seen.filter(e => e.type === 'text')).toHaveLength(2)
  })

  it('retries a failed reconnect, then succeeds', async () => {
    const body = [seq(2, { type: 'run-end', status: 'complete' })]
      .map(e => JSON.stringify(e)).join('\n') + '\n'

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await runWithTimers(consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'text', text: 'partial' }),
    ]), () => {}))

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('complete')
  })

  it('stops retrying when the run has aged out of the registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 }),
    ))

    const result = await runWithTimers(consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
    ]), () => {}))

    expect(result).toEqual({
      runId: 'run-1',
      status: 'error',
      error: 'This generation is no longer available',
    })
  })

  it('surfaces a terminal error event as an error result', async () => {
    const result = await consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'librarian.chat', status: 'running' }),
      seq(1, { type: 'error', error: 'provider exploded' }),
    ]), () => {})

    expect(result).toEqual({ runId: 'run-1', status: 'error', error: 'provider exploded' })
  })

  it('reports a cancelled run as cancelled, not as a failure', async () => {
    const result = await consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      seq(1, { type: 'run-end', status: 'cancelled' }),
    ]), () => {})

    expect(result).toEqual({ runId: 'run-1', status: 'cancelled' })
  })

  it('carries the status through so a 409 conflict is distinguishable', async () => {
    // `useRunStream` branches on `status === 409` to attach to the live run
    // instead of erroring, which only works if the stream fetchers throw
    // ApiError rather than a bare Error.
    const { ApiError, fetchEventStream } = await import('@/lib/api/client')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'A chat turn is already running', runId: 'run-live' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const err = await fetchEventStream('/stories/s/librarian/chat', { message: 'hi' })
      .then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as InstanceType<typeof ApiError>).status).toBe(409)
    expect((err as InstanceType<typeof ApiError>).data.runId).toBe('run-live')
  })

  /**
   * The failure behind "spinner forever, but a refresh shows new content": the
   * connection is dead while the socket still looks open, so the reader never
   * resolves and nothing triggers a reconnect. The server keepalives every 5s
   * precisely so this silence is detectable.
   */
  it('treats a silent stream as a disconnect and reattaches from the cursor', async () => {
    // A stream that yields run-start, then never resolves again.
    const stalling = new ReadableStream<SequencedChatEvent>({
      start(controller) {
        controller.enqueue(seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }))
        controller.enqueue(seq(1, { type: 'text', text: 'partial' }))
        // Never closes, never enqueues again.
      },
    })

    const body = [
      seq(2, { type: 'text', text: ' and the rest' }),
      seq(3, { type: 'run-end', status: 'complete' }),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    const fetchSpy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const seen: ChatEvent[] = []
    const result = await runWithTimers(consumeRun('story-1', stalling, e => seen.push(e)))

    expect(result).toEqual({ runId: 'run-1', status: 'complete' })
    // Resumed at exactly the next unseen seq — nothing lost, nothing repeated.
    expect(fetchSpy).toHaveBeenCalledWith('/api/stories/story-1/runs/run-1/events?cursor=2')
    expect(seen.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join(''))
      .toBe('partial and the rest')
  })

  it('treats keepalive padding as liveness, never as content', async () => {
    // Blank server padding is surfaced as a keepalive marker so a reader can
    // tell a quiet model from a dead link. It must not reach onEvent, and must
    // not move the cursor — otherwise a reconnect would resume at the wrong seq.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const seen: ChatEvent[] = []
    const result = await consumeRun('story-1', streamOf([
      seq(0, { type: 'run-start', runId: 'run-1', kind: 'generation', status: 'running' }),
      { type: 'keepalive' } as SequencedChatEvent,
      seq(1, { type: 'text', text: 'hello' }),
      { type: 'keepalive' } as SequencedChatEvent,
      seq(2, { type: 'run-end', status: 'complete' }),
    ]), e => seen.push(e))

    expect(result).toEqual({ runId: 'run-1', status: 'complete' })
    expect(seen.map(e => e.type)).toEqual(['run-start', 'text', 'run-end'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('gives up when the stream dies before a run id is known', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await consumeRun('story-1', streamOf([]), () => {})

    expect(result).toEqual({ runId: null, status: 'error', error: 'Connection lost' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
