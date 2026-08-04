import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { getChatHistory } from '@/server/librarian/storage'
import { clearRuns, listRuns } from '@/server/runs'
import type { StoryMeta } from '@/server/fragments/schema'

// Mock the AI SDK ToolLoopAgent so we control exactly when the stream yields.
const mockAgentStream = vi.fn()

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor() {
        return { stream: mockAgentStream } as unknown as MockToolLoopAgent
      }
    },
  }
})

import { createApp } from '@/server/api'

const STORY_ID = 'story-runs-routes'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: STORY_ID,
    name: 'Test Story',
    description: '',
    coverImage: null,
    summary: 'A hero enters a forest.',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  if (!res.body) return []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, unknown>> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line))
  }
  if (buffer.trim()) events.push(JSON.parse(buffer))
  return events
}

/** Yield `events`, pausing at `gate` so a test can interleave a disconnect. */
function gatedFullStream(
  before: Array<Record<string, unknown>>,
  gate: Promise<void>,
  after: Array<Record<string, unknown>>,
) {
  return (async function* () {
    for (const e of before) yield e
    await gate
    for (const e of after) yield e
  })()
}

describe('run routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    app = createApp(dataDir)
    await createStory(dataDir, makeStory())
    mockAgentStream.mockClear()
  })

  afterEach(async () => {
    clearRuns()
    await new Promise(r => setTimeout(r, 50))
    await cleanup()
  })

  function post(path: string, body: Record<string, unknown>) {
    return app.fetch(new Request(`http://localhost/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  function get(path: string) {
    return app.fetch(new Request(`http://localhost/api${path}`))
  }

  /**
   * The regression this whole feature exists for: the phone drops the
   * connection mid-turn, after a tool call has already edited a fragment.
   * The turn must still complete and must still be recorded — otherwise the
   * next turn re-applies the same edits.
   */
  it('finishes the turn and records its tool calls after the client disconnects', async () => {
    const gate = deferred()
    mockAgentStream.mockResolvedValue({
      fullStream: gatedFullStream(
        [
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'updateFragment', input: { id: 'ch-1' } },
          { type: 'tool-result', toolCallId: 'tc-1', toolName: 'updateFragment', output: { ok: true } },
        ],
        gate.promise,
        [
          { type: 'text-delta', text: 'Updated the character.' },
          { type: 'finish', finishReason: 'stop' },
        ],
      ),
      totalUsage: Promise.resolve(undefined),
    })

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Update Alice' })
    expect(res.status).toBe(200)
    const runId = res.headers.get('x-run-id')!
    expect(runId).toBeTruthy()

    // Read a little, then hang up like a phone going to sleep.
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()

    // The generation continues with nobody listening.
    gate.resolve()
    await new Promise(r => setTimeout(r, 150))

    // Reattach from the top and see the complete turn.
    const replay = await readEvents(await get(`/stories/${STORY_ID}/runs/${runId}/events?cursor=0`))
    expect(replay.find(e => e.type === 'tool-result')).toMatchObject({ toolName: 'updateFragment' })
    expect(replay.at(-1)).toMatchObject({ type: 'run-end', status: 'complete' })

    // And, crucially, history records the assistant turn *with its tool call*.
    const history = await getChatHistory(dataDir, STORY_ID)
    expect(history.messages).toHaveLength(2)
    expect(history.messages[0]).toMatchObject({ role: 'user', content: 'Update Alice' })
    expect(history.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Updated the character.',
      status: 'complete',
    })
    expect(history.messages[1].toolCalls).toEqual([
      expect.objectContaining({ toolName: 'updateFragment' }),
    ])
  })

  it('persists the turn as streaming, with tool calls, while it is still running', async () => {
    const gate = deferred()
    mockAgentStream.mockResolvedValue({
      fullStream: gatedFullStream(
        [
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'editProse', input: {} },
          { type: 'tool-result', toolCallId: 'tc-1', toolName: 'editProse', output: { ok: true } },
        ],
        gate.promise,
        [{ type: 'finish', finishReason: 'stop' }],
      ),
      totalUsage: Promise.resolve(undefined),
    })

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Edit it' })
    const reader = res.body!.getReader()
    await reader.read()

    // Let the tool result land and its forced write settle.
    await new Promise(r => setTimeout(r, 100))

    const mid = await getChatHistory(dataDir, STORY_ID)
    const assistant = mid.messages[1]
    expect(assistant).toMatchObject({ role: 'assistant', status: 'streaming' })
    expect(assistant.runId).toBeTruthy()
    expect(assistant.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'editProse', result: { ok: true } }),
    ])

    gate.resolve()
    await reader.cancel()
    await new Promise(r => setTimeout(r, 100))

    const settled = await getChatHistory(dataDir, STORY_ID)
    expect(settled.messages[1].status).toBe('complete')
  })

  it('replays from a cursor without gaps or duplicates', async () => {
    mockAgentStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'tc-1', toolName: 'listCharacters', input: {} }
        yield { type: 'tool-result', toolCallId: 'tc-1', toolName: 'listCharacters', output: [] }
        yield { type: 'text-delta', text: 'Done.' }
        yield { type: 'finish', finishReason: 'stop' }
      })(),
      totalUsage: Promise.resolve(undefined),
    })

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'List them' })
    const runId = res.headers.get('x-run-id')!
    const all = await readEvents(res)

    const resumed = await readEvents(await get(`/stories/${STORY_ID}/runs/${runId}/events?cursor=2`))
    expect(resumed[0].seq).toBe(2)
    expect([...all.slice(0, 2), ...resumed]).toEqual(all)
  })

  it('lists active runs and stops listing them once finished', async () => {
    const gate = deferred()
    mockAgentStream.mockResolvedValue({
      fullStream: gatedFullStream([], gate.promise, [{ type: 'finish', finishReason: 'stop' }]),
      totalUsage: Promise.resolve(undefined),
    })

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Hello' })
    const runId = res.headers.get('x-run-id')!
    await new Promise(r => setTimeout(r, 20))

    const active = await (await get(`/stories/${STORY_ID}/runs?active=1`)).json()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id: runId, kind: 'librarian.chat', status: 'running' })

    gate.resolve()
    await readEvents(res)
    await new Promise(r => setTimeout(r, 50))

    expect(await (await get(`/stories/${STORY_ID}/runs?active=1`)).json()).toHaveLength(0)
  })

  // A flaky mobile link makes duplicate POSTs likely. Without a key, the
  // duplicate would be a second generation re-applying the same edits.
  it('attaches a retry with the same clientRequestId instead of generating twice', async () => {
    mockAgentStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Hi' }
        yield { type: 'finish', finishReason: 'stop' }
      })(),
      totalUsage: Promise.resolve(undefined),
    })

    const first = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Hello', clientRequestId: 'cr-1' })
    const runId = first.headers.get('x-run-id')
    await readEvents(first)

    const retry = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Hello', clientRequestId: 'cr-1' })
    expect(retry.headers.get('x-run-id')).toBe(runId)
    await readEvents(retry)

    // One generation, and one user turn — not two of each.
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
    expect(listRuns(STORY_ID)).toHaveLength(1)
    const history = await getChatHistory(dataDir, STORY_ID)
    expect(history.messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('rejects a competing turn on the same conversation with 409 and the live run id', async () => {
    const gate = deferred()
    mockAgentStream.mockResolvedValue({
      fullStream: gatedFullStream([], gate.promise, [{ type: 'finish', finishReason: 'stop' }]),
      totalUsage: Promise.resolve(undefined),
    })

    const first = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'One' })
    const runId = first.headers.get('x-run-id')
    await new Promise(r => setTimeout(r, 20))

    const second = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Two' })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ runId })

    gate.resolve()
    await readEvents(first)
  })

  it('cancels a run on request and records the turn as cancelled', async () => {
    const gate = deferred()
    mockAgentStream.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => Promise.resolve({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Partial' }
        await gate.promise
        // A real provider rejects the iterator when the signal aborts.
        if (abortSignal?.aborted) throw new Error('aborted')
        yield { type: 'finish', finishReason: 'stop' }
      })(),
      totalUsage: Promise.resolve(undefined),
    }))

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Go' })
    const runId = res.headers.get('x-run-id')!
    await new Promise(r => setTimeout(r, 20))

    const cancelRes = await post(`/stories/${STORY_ID}/runs/${runId}/cancel`, {})
    expect(cancelRes.status).toBe(200)
    expect(await cancelRes.json()).toMatchObject({ ok: true, cancelled: true })

    gate.resolve()
    const events = await readEvents(res)
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'cancelled' })

    await new Promise(r => setTimeout(r, 50))
    const history = await getChatHistory(dataDir, STORY_ID)
    expect(history.messages[1]).toMatchObject({ role: 'assistant', status: 'cancelled' })
  })

  /**
   * A real provider usually ends the stream *gracefully* when the abort signal
   * fires rather than throwing, so "the run body returned without error" is not
   * proof the turn finished. Only the signal says whether the author stopped it.
   */
  it('records a cancelled turn as cancelled even when the provider ends gracefully', async () => {
    const gate = deferred()
    mockAgentStream.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => Promise.resolve({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Partial' }
        await gate.promise
        // Graceful stop: just stop yielding, no throw.
        if (abortSignal?.aborted) return
        yield { type: 'text-delta', text: ' and the rest' }
        yield { type: 'finish', finishReason: 'stop' }
      })(),
      totalUsage: Promise.resolve(undefined),
    }))

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Go' })
    const runId = res.headers.get('x-run-id')!
    await new Promise(r => setTimeout(r, 20))

    await post(`/stories/${STORY_ID}/runs/${runId}/cancel`, {})
    gate.resolve()

    const events = await readEvents(res)
    expect(events.at(-1)).toMatchObject({ type: 'run-end', status: 'cancelled' })

    await new Promise(r => setTimeout(r, 100))
    const history = await getChatHistory(dataDir, STORY_ID)
    expect(history.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Partial',
      status: 'cancelled',
    })
  })

  it('reports a turn orphaned by a restart as interrupted rather than still streaming', async () => {
    const gate = deferred()
    mockAgentStream.mockResolvedValue({
      fullStream: gatedFullStream(
        [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'updateFragment', input: {} },
         { type: 'tool-result', toolCallId: 'tc-1', toolName: 'updateFragment', output: { ok: true } }],
        gate.promise,
        [{ type: 'finish', finishReason: 'stop' }],
      ),
      totalUsage: Promise.resolve(undefined),
    })

    const res = await post(`/stories/${STORY_ID}/librarian/chat`, { message: 'Edit' })
    const reader = res.body!.getReader()
    await reader.read()
    await new Promise(r => setTimeout(r, 100))
    await reader.cancel()

    // Simulate a server restart: the run registry is gone, the file is not.
    clearRuns()

    const history = await getChatHistory(dataDir, STORY_ID)
    expect(history.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'error',
      error: 'Generation was interrupted',
    })
    // The tool call it managed to apply is still on the record.
    expect(history.messages[1].toolCalls).toEqual([
      expect.objectContaining({ toolName: 'updateFragment' }),
    ])

    gate.resolve()
  })

  it('404s for an unknown run', async () => {
    expect((await get(`/stories/${STORY_ID}/runs/run-nope`)).status).toBe(404)
    expect((await get(`/stories/${STORY_ID}/runs/run-nope/events?cursor=0`)).status).toBe(404)
    expect((await post(`/stories/${STORY_ID}/runs/run-nope/cancel`, {})).status).toBe(404)
  })
})
