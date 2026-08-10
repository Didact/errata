import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import {
  startRun,
  getRun,
  listRuns,
  findLiveRun,
  findRunByClientRequestId,
  cancelRun,
  subscribeRun,
  clearRuns,
} from '@/server/runs'
import type { SequencedRunEvent, ServerRunEvent } from '@/server/runs'
import type { StoryMeta } from '@/server/fragments/schema'

const STORY_ID = 'story-runs'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: STORY_ID,
    name: 'Runs Story',
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

/** Read every line a subscriber produces, to completion. */
async function drain(stream: ReadableStream<string>): Promise<SequencedRunEvent[]> {
  const events: SequencedRunEvent[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of value.split('\n')) {
      if (line.trim()) events.push(JSON.parse(line) as SequencedRunEvent)
    }
  }
  return events
}

/** A deferred, so a test can hold a run body open at a known point. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('run registry', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    clearRuns()
    await cleanup()
  })

  it('runs the body to completion and frames it with run-start/run-end', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-1',
      body: async ({ emit }) => {
        emit({ type: 'text', text: 'hello' })
        emit({ type: 'finish', finishReason: 'stop', stepCount: 1 })
      },
    })

    await run.done
    const events = await drain(subscribeRun(run.id, 0)!)

    expect(events[0]).toMatchObject({ type: 'run-start', runId: run.id, kind: 'librarian.chat', seq: 0 })
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'complete' })
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i))
    expect(run.status).toBe('complete')
  })

  // The core regression: a phone backgrounding its tab must not be able to
  // kill the generation or lose the tool calls it already applied.
  it('keeps running after a subscriber disconnects mid-run', async () => {
    const gate = deferred()
    const emitted: string[] = []

    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-1',
      body: async ({ emit }) => {
        emit({ type: 'tool-call', id: 't1', toolName: 'updateFragment', args: { id: 'ch-1' } })
        emitted.push('tool-call')
        await gate.promise
        // Everything below happens *after* the subscriber has gone away.
        emit({ type: 'tool-result', id: 't1', toolName: 'updateFragment', result: { ok: true } })
        emit({ type: 'text', text: 'done editing' })
        emit({ type: 'finish', finishReason: 'stop', stepCount: 2 })
        emitted.push('finished')
      },
    })

    // Attach, read the first events, then abandon the stream like a dropped connection.
    const stream = subscribeRun(run.id, 0)!
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()

    gate.resolve()
    await run.done

    expect(emitted).toEqual(['tool-call', 'finished'])
    expect(run.status).toBe('complete')

    // A fresh subscriber still sees the whole log, tool result included.
    const events = await drain(subscribeRun(run.id, 0)!)
    expect(events.find(e => e.type === 'tool-result')).toMatchObject({ id: 't1', result: { ok: true } })
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'complete' })
  })

  it('replays from a cursor so a reconnecting client resumes where it left off', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'generation',
      body: async ({ emit }) => {
        emit({ type: 'phase', phase: 'writing' })
        emit({ type: 'tool-call', id: 't1', toolName: 'getCharacter', args: {} })
        emit({ type: 'tool-result', id: 't1', toolName: 'getCharacter', result: 'x' })
        emit({ type: 'finish', finishReason: 'stop', stepCount: 1 })
      },
    })
    await run.done

    const all = await drain(subscribeRun(run.id, 0)!)
    const resumed = await drain(subscribeRun(run.id, 3)!)

    expect(resumed[0].seq).toBe(3)
    expect(resumed).toEqual(all.slice(3))
    // No gaps and no duplicates across the split.
    expect([...all.slice(0, 3), ...resumed]).toEqual(all)
  })

  it('coalesces consecutive text deltas but preserves order against tool events', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'generation',
      body: async ({ emit }) => {
        emit({ type: 'text', text: 'a' })
        emit({ type: 'text', text: 'b' })
        emit({ type: 'text', text: 'c' })
        emit({ type: 'tool-call', id: 't1', toolName: 'listCharacters', args: {} })
        emit({ type: 'text', text: 'd' })
        emit({ type: 'reasoning', text: 'hmm' })
      },
    })
    await run.done

    const events = await drain(subscribeRun(run.id, 0)!)
    const body = events.filter(e => e.type !== 'run-start' && e.type !== 'run-end')

    expect(body.map(e => e.type)).toEqual(['text', 'tool-call', 'text', 'reasoning'])
    expect((body[0] as ServerRunEvent & { text: string }).text).toBe('abc')
    expect((body[2] as ServerRunEvent & { text: string }).text).toBe('d')
  })

  it('cancels only on explicit request, and reports status cancelled', async () => {
    const started = deferred()
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'generation',
      body: async ({ emit, signal }) => {
        emit({ type: 'text', text: 'partial' })
        started.resolve()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    })

    await started.promise
    expect(cancelRun(run.id)).toBe(true)
    await run.done

    expect(run.status).toBe('cancelled')
    const events = await drain(subscribeRun(run.id, 0)!)
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'cancelled' })
    // A cancel is not a failure — no error event.
    expect(events.some(e => e.type === 'error')).toBe(false)
  })

  it('records a failing body as an error run with a terminal error event', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-err',
      body: async ({ emit }) => {
        emit({ type: 'text', text: 'partial' })
        throw new Error('provider exploded')
      },
    })
    await run.done

    expect(run.status).toBe('error')
    const events = await drain(subscribeRun(run.id, 0)!)
    expect(events.find(e => e.type === 'error')).toMatchObject({ error: 'provider exploded' })
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'error' })
  })

  it('follows a live run, delivering events as they are emitted', async () => {
    const gate = deferred()
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-live',
      body: async ({ emit }) => {
        emit({ type: 'text', text: 'first' })
        await gate.promise
        emit({ type: 'text', text: 'second' })
      },
    })

    const collected = drain(subscribeRun(run.id, 0)!)
    // Give the subscriber a chance to drain and park on the waiter list.
    await new Promise(r => setTimeout(r, 80))
    gate.resolve()

    const events = await collected
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text)
    expect(text).toEqual(['first', 'second'])
  })

  it('finds live runs by scope and by client request id', async () => {
    const gate = deferred()
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-1',
      clientRequestId: 'req-abc',
      body: async () => { await gate.promise },
    })

    expect(findLiveRun(STORY_ID, 'librarian.chat', 'conv-1')?.id).toBe(run.id)
    expect(findLiveRun(STORY_ID, 'librarian.chat', 'conv-2')).toBeNull()
    expect(findRunByClientRequestId(STORY_ID, 'req-abc')?.id).toBe(run.id)
    expect(listRuns(STORY_ID, { active: true })).toHaveLength(1)

    gate.resolve()
    await run.done

    expect(findLiveRun(STORY_ID, 'librarian.chat', 'conv-1')).toBeNull()
    expect(listRuns(STORY_ID, { active: true })).toHaveLength(0)
    // Still resolvable by idempotency key within the retention window, so a
    // late retry reads the original result instead of re-running the edits.
    expect(findRunByClientRequestId(STORY_ID, 'req-abc')?.id).toBe(run.id)
  })

  /**
   * A generation can go a long time without emitting. Anything between the
   * phone and the server — carrier NAT, a tunnel, a reverse proxy — will drop
   * a connection it thinks is idle, which surfaces to the author as a spurious
   * "reconnecting" mid-generation.
   */
  it('sends keepalive padding so an idle stream is not dropped', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred()
      const run = await startRun({
        dataDir,
        storyId: STORY_ID,
        kind: 'librarian.chat',
        scopeId: 'conv-idle',
        body: async ({ emit }) => {
          emit({ type: 'text', text: 'thinking' })
          await gate.promise
          emit({ type: 'finish', finishReason: 'stop', stepCount: 1 })
        },
      })

      const reader = subscribeRun(run.id, 0)!.getReader()
      const chunks: string[] = []

      // Drain run-start + the first text event.
      await vi.advanceTimersByTimeAsync(100)
      chunks.push((await reader.read()).value!)
      chunks.push((await reader.read()).value!)

      // Now go quiet past the keepalive window.
      const pending = reader.read()
      await vi.advanceTimersByTimeAsync(16_000)
      const keepalive = await pending

      // Padding only — no event, so the cursor is untouched.
      expect(keepalive.value).toBe('\n')
      expect(keepalive.value!.trim()).toBe('')

      gate.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await run.done

      // The real events still arrive, correctly sequenced.
      const rest: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.trim()) rest.push(value)
      }
      const parsed = rest.map(l => JSON.parse(l.trim()))
      expect(parsed.at(-1)).toMatchObject({ type: 'run-end', status: 'complete' })

      const all = [...chunks, ...rest].filter(c => c.trim()).map(l => JSON.parse(l.trim()))
      expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leak a waiter per keepalive tick', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred()
      const run = await startRun({
        dataDir,
        storyId: STORY_ID,
        kind: 'librarian.chat',
        scopeId: 'conv-leak',
        body: async () => { await gate.promise },
      })

      const reader = subscribeRun(run.id, 0)!.getReader()
      await vi.advanceTimersByTimeAsync(100)
      await reader.read() // run-start

      // Several quiet keepalive cycles.
      for (let i = 0; i < 5; i++) {
        const pending = reader.read()
        await vi.advanceTimersByTimeAsync(16_000)
        await pending
      }

      // A timed-out waiter must remove itself rather than pile up.
      expect(run.waiters.length).toBeLessThanOrEqual(1)

      gate.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await run.done
      await reader.cancel()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The event log is capped, but dropping `run-end` would close every
   * subscriber's stream with no terminal event — which the client correctly
   * reads as a disconnect and retries forever. Truncating a pathological run's
   * live view is fine; stranding the client is not.
   */
  it('always emits a terminal event, even past the event-log cap', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'generation',
      body: async ({ emit }) => {
        // Blow well past MAX_EVENTS (20k) with non-batchable events.
        for (let i = 0; i < 20_050; i++) {
          emit({ type: 'tool-call', id: `t${i}`, toolName: 'noop', args: {} })
        }
      },
    })
    await run.done

    const events = await drain(subscribeRun(run.id, 0)!)
    expect(events.length).toBeLessThanOrEqual(20_001)
    // The critical part: the client still learns the run is over.
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'complete' })
    expect(run.truncated).toBe(true)
  })

  it('records a terminal error past the cap too', async () => {
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'generation',
      body: async ({ emit }) => {
        for (let i = 0; i < 20_050; i++) {
          emit({ type: 'tool-call', id: `t${i}`, toolName: 'noop', args: {} })
        }
        throw new Error('exploded after the cap')
      },
    })
    await run.done

    const events = await drain(subscribeRun(run.id, 0)!)
    expect(events.find(e => e.type === 'error')).toMatchObject({ error: 'exploded after the cap' })
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'error' })
  })

  it('stops its subscriber loop when the consumer hangs up', async () => {
    const gate = deferred()
    const run = await startRun({
      dataDir,
      storyId: STORY_ID,
      kind: 'librarian.chat',
      scopeId: 'conv-hangup',
      body: async ({ emit }) => {
        emit({ type: 'text', text: 'hello' })
        await gate.promise
        emit({ type: 'finish', finishReason: 'stop', stepCount: 1 })
      },
    })

    const reader = subscribeRun(run.id, 0)!.getReader()
    await reader.read()
    await reader.cancel()

    // The abandoned subscriber must not keep parking on the waiter list.
    await new Promise(r => setTimeout(r, 30))
    const waitersAfterCancel = run.waiters.length

    gate.resolve()
    await run.done

    expect(waitersAfterCancel).toBe(0)
    expect(run.status).toBe('complete')
  })

  it('returns null for an unknown run', () => {
    expect(getRun('run-nope')).toBeNull()
    expect(subscribeRun('run-nope', 0)).toBeNull()
    expect(cancelRun('run-nope')).toBe(false)
  })
})
