import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createApp } from '@/server/api'
import { createStory, createFragment, getFragment, getStory, updateStory } from '@/server/fragments/storage'
import { addProseSection } from '@/server/fragments/prose-chain'
import {
  saveAnalysis,
  saveState,
  type LibrarianAnalysis,
} from '@/server/librarian/storage'

// Mock the AI SDK to prevent real LLM calls
vi.mock('ai', () => ({
  stepCountIs: vi.fn((n: number) => n),
  streamText: vi.fn(() => {
    const text = 'Generated text'
    // Create a proper ReadableStream for textStream that supports tee()
    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text)
        controller.close()
      },
    })
    return {
      textStream,
      text: Promise.resolve(text),
      usage: Promise.resolve({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
      finishReason: Promise.resolve('stop' as const),
      steps: Promise.resolve([]),
      toTextStreamResponse: () =>
        new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    }
  }),
  tool: vi.fn((def: unknown) => def),
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

function makeAnalysis(overrides: Partial<LibrarianAnalysis> = {}): LibrarianAnalysis {
  return {
    id: `analysis-${Date.now()}`,
    createdAt: new Date().toISOString(),
    fragmentId: 'pr-0001',
    summaryUpdate: 'Something happened.',
    mentionedCharacters: ['ch-0001'],
    contradictions: [],
    fragmentSuggestions: [],
    timelineEvents: [],
    ...overrides,
  }
}

describe('librarian API routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  const storyId = 'story-lib-api'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)

    await createStory(dataDir, {
      id: storyId,
      name: 'Librarian API Test',
      description: 'Testing librarian routes',
      coverImage: null,
      summary: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      settings: makeTestSettings({ librarianProviderId: null, librarianModelId: null }),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('GET /stories/:storyId/librarian/status', () => {
    it('returns default state for new story', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/status`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toMatchObject({
        lastAnalyzedFragmentId: null,
        recentMentions: {},
        timeline: [],
        runStatus: 'idle',
        pendingFragmentId: null,
        runningFragmentId: null,
        lastError: null,
      })
      expect(typeof data.updatedAt).toBe('string')
    })

    it('returns saved state', async () => {
      // recentMentions/timeline are derived from analyses of currently-active
      // prose, not round-tripped from saveState — seed both.
      await addProseSection(dataDir, storyId, 'pr-0001')
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-pr-0001',
        fragmentId: 'pr-0001',
        mentionedCharacters: ['ch-0001'],
        timelineEvents: [{ event: 'Battle', position: 'during' }],
      }))
      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: null,
        recentMentions: {},
        timeline: [],
      })

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/status`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.lastAnalyzedFragmentId).toBe('pr-0001')
      expect(data.recentMentions['ch-0001']).toEqual(['pr-0001'])
      expect(data.timeline).toHaveLength(1)
    })
  })

  describe('GET /stories/:storyId/librarian/analyses', () => {
    it('returns empty list when no analyses exist', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('returns analyses sorted newest first', async () => {
      // listActiveAnalyses scopes to fragments active in the prose chain, and
      // collapses repeats per fragment to the latest — use two distinct
      // active fragments so this test exercises ordering, not dedup.
      await addProseSection(dataDir, storyId, 'pr-0001')
      await addProseSection(dataDir, storyId, 'pr-0002')
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        fragmentId: 'pr-0002',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toHaveLength(2)
      expect(data[0].id).toBe('analysis-new')
      expect(data[1].id).toBe('analysis-old')
      // Should be summaries
      expect(data[0]).toHaveProperty('contradictionCount')
      expect(data[0]).not.toHaveProperty('summaryUpdate')
    })
  })

  describe('GET /stories/:storyId/librarian/agent-runs', () => {
    it('returns empty list when no agent runs exist', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/agent-runs`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })
  })

  describe('GET /stories/:storyId/librarian/analyses/:analysisId', () => {
    it('returns full analysis by ID', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-detail',
        summaryUpdate: 'The hero entered the cave.',
        mentionedCharacters: ['ch-0001'],
        contradictions: [
          { description: 'Eye color mismatch', fragmentIds: ['pr-0001'] },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-detail`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.id).toBe('analysis-detail')
      expect(data.summaryUpdate).toBe('The hero entered the cave.')
      expect(data.mentionedCharacters).toEqual(['ch-0001'])
      expect(data.contradictions).toHaveLength(1)
    })

    it('returns 404 for non-existent analysis', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/nonexistent`),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /stories/:storyId/librarian/analyses/:analysisId', () => {
    it('updates the saved summary and syncs latest fragment/story summary text', async () => {
      await createFragment(dataDir, storyId, {
        id: 'pr-0001',
        type: 'prose',
        name: 'Scene 1',
        description: 'Opening scene',
        content: 'Original prose.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        order: 0,
        meta: {
          _librarian: {
            summary: 'Something happened.',
            analysisId: 'analysis-edit',
          },
        },
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-edit',
        fragmentId: 'pr-0001',
        summaryUpdate: 'Something happened.',
      }))

      const story = await getStory(dataDir, storyId)
      await updateStory(dataDir, {
        ...story!,
        summary: 'Earlier events. Something happened. Later events.',
      })

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-edit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summaryUpdate: 'Something more precise happened.' }),
        }),
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.summaryUpdate).toBe('Something more precise happened.')

      const updatedAnalysis = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-edit`),
      )
      const updatedAnalysisJson = await updatedAnalysis.json()
      expect(updatedAnalysisJson.summaryUpdate).toBe('Something more precise happened.')

      const updatedFragment = await getFragment(dataDir, storyId, 'pr-0001')
      expect(updatedFragment?.meta?._librarian).toEqual({
        summary: 'Something more precise happened.',
        analysisId: 'analysis-edit',
      })

      const updatedStory = await getStory(dataDir, storyId)
      expect(updatedStory?.summary).toBe('Earlier events. Something more precise happened. Later events.')
    })
  })

  describe('POST /stories/:storyId/librarian/analyses/:analysisId/suggestions/:index/accept', () => {
    it('marks a suggestion as accepted and creates a fragment', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-accept',
        fragmentSuggestions: [
          { type: 'knowledge', name: 'Dragon Lore', description: 'Dragons breathe fire', content: 'Full details about dragons.' },
          { type: 'character', name: 'Hero', description: 'Main character', content: 'Hero backstory.' },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-accept/suggestions/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.analysis.fragmentSuggestions[0].accepted).toBe(true)
      expect(data.analysis.fragmentSuggestions[0].autoApplied).toBe(false)
      expect(data.analysis.fragmentSuggestions[1].accepted).toBeUndefined()
      expect(data.createdFragmentId).toBeTruthy()

      const created = await getFragment(dataDir, storyId, data.createdFragmentId)
      expect(created).toBeTruthy()
      expect(created?.name).toBe('Dragon Lore')
      expect(created?.type).toBe('knowledge')
      expect(created?.refs).toContain('pr-0001')
      expect(created?.meta?.sourceFragmentId).toBe('pr-0001')
    })

    it('updates an existing targeted fragment when suggestion has targetFragmentId', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'kn-0001',
        type: 'knowledge',
        name: 'Valdris',
        description: 'Ancient city',
        content: 'Valdris is an ancient city.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-target-update',
        fragmentSuggestions: [
          {
            type: 'knowledge',
            targetFragmentId: 'kn-0001',
            name: 'Valdris',
            description: 'Ancient defended city',
            content: 'Valdris is an ancient city defended by stone sentinels.',
          },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-target-update/suggestions/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.createdFragmentId).toBe('kn-0001')

      const updated = await getFragment(dataDir, storyId, 'kn-0001')
      expect(updated).toBeTruthy()
      expect(updated?.description).toBe('Ancient defended city')
      expect(updated?.content).toContain('stone sentinels')
    })

    it('returns 404 for non-existent analysis', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/nonexistent/suggestions/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(404)
    })

    it('returns 422 for invalid suggestion index', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-badidx',
        fragmentSuggestions: [
          { type: 'knowledge', name: 'Test', description: 'Test', content: 'Test' },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-badidx/suggestions/5/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(422)
      const data = await res.json()
      expect(data.error).toContain('Invalid suggestion index')
    })

    it('returns 422 for negative index', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-negidx',
        fragmentSuggestions: [
          { type: 'knowledge', name: 'Test', description: 'Test', content: 'Test' },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-negidx/suggestions/-1/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(422)
    })
  })
})
