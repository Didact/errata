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

  it('gives up when the stream dies before a run id is known', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await consumeRun('story-1', streamOf([]), () => {})

    expect(result).toEqual({ runId: null, status: 'error', error: 'Connection lost' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
