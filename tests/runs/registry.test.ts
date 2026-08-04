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

  it('returns null for an unknown run', () => {
    expect(getRun('run-nope')).toBeNull()
    expect(subscribeRun('run-nope', 0)).toBeNull()
    expect(cancelRun('run-nope')).toBe(false)
  })
})
