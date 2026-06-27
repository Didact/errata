import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { addProseSection, addProseVariation } from '@/server/fragments/prose-chain'
import { writeJsonAtomic } from '@/server/fs-utils'
import {
  saveAnalysis,
  getAnalysis,
  listAnalyses,
  getState,
  getActiveState,
  saveState,
  getLatestAnalysisIdsByFragment,
  rebuildAnalysisIndex,
  type LibrarianAnalysis,
  type LibrarianState,
} from '@/server/librarian/storage'

function makeAnalysis(overrides: Partial<LibrarianAnalysis> = {}): LibrarianAnalysis {
  return {
    id: `analysis-${Date.now()}`,
    createdAt: new Date().toISOString(),
    fragmentId: 'pr-0001',
    summaryUpdate: 'The hero entered the cave.',
    mentionedCharacters: ['ch-0001'],
    contradictions: [],
    fragmentSuggestions: [],
    timelineEvents: [],
    ...overrides,
  }
}

describe('librarian storage', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-lib-test'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, {
      id: storyId,
      name: 'Test Story',
      description: 'For librarian tests',
    coverImage: null,
      summary: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: makeTestSettings(),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('analysis CRUD', () => {
    it('saves and loads an analysis round-trip', async () => {
      const analysis = makeAnalysis({ id: 'analysis-a' })
      await saveAnalysis(dataDir, storyId, analysis)

      const loaded = await getAnalysis(dataDir, storyId, 'analysis-a')
      expect(loaded).toEqual(analysis)
    })

    it('returns null for non-existent analysis', async () => {
      const loaded = await getAnalysis(dataDir, storyId, 'nonexistent')
      expect(loaded).toBeNull()
    })

    it('lists analyses sorted newest first', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))

      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries).toHaveLength(2)
      expect(summaries[0].id).toBe('analysis-new')
      expect(summaries[1].id).toBe('analysis-old')
    })

    it('list returns summaries with counts', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-counts',
        contradictions: [
          { description: 'Eye color changed', fragmentIds: ['pr-0001', 'pr-0002'] },
        ],
        fragmentSuggestions: [
          { type: 'knowledge' as const, name: 'Cave', description: 'The dark cave', content: 'A cave in the mountains' },
        ],
        timelineEvents: [
          { event: 'Entered cave', position: 'during' },
          { event: 'Found sword', position: 'after' },
        ],
      }))

      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries[0].contradictionCount).toBe(1)
      expect(summaries[0].suggestionCount).toBe(1)
      expect(summaries[0].pendingSuggestionCount).toBe(1)
      expect(summaries[0].timelineEventCount).toBe(2)
    })

    it('returns empty list when no analyses exist', async () => {
      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries).toEqual([])
    })

    it('updates latest-analysis index on save and reanalysis', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-other',
        fragmentId: 'pr-0002',
        createdAt: '2025-01-03T00:00:00.000Z',
      }))

      const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
      expect(latest.get('pr-0001')).toBe('analysis-new')
      expect(latest.get('pr-0002')).toBe('analysis-other')
    })

    it('rebuilds analysis index from analysis files', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-a',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-b',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-05T00:00:00.000Z',
      }))

      const rebuilt = await rebuildAnalysisIndex(dataDir, storyId)
      expect(rebuilt.latestByFragmentId['pr-0001']?.analysisId).toBe('analysis-b')

      const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
      expect(latest.get('pr-0001')).toBe('analysis-b')
    })
  })

  describe('state persistence', () => {
    it('returns default state for new stories', async () => {
      const state = await getState(dataDir, storyId)
      expect(state).toEqual({
        lastAnalyzedFragmentId: null,
        summarizedUpTo: null,
        recentMentions: {},
        timeline: [],
      })
    })

    it('round-trips the scalar watermark fields', async () => {
      const state: LibrarianState = {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: 'pr-0001',
        recentMentions: {},
        timeline: [],
      }
      await saveState(dataDir, storyId, state)

      const loaded = await getState(dataDir, storyId)
      expect(loaded.lastAnalyzedFragmentId).toBe('pr-0001')
      expect(loaded.summarizedUpTo).toBe('pr-0001')
    })

    it('overwrites previous scalar state on save', async () => {
      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: null,
        recentMentions: {},
        timeline: [],
      })

      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0002',
        summarizedUpTo: null,
        recentMentions: {},
        timeline: [],
      })

      const loaded = await getState(dataDir, storyId)
      expect(loaded.lastAnalyzedFragmentId).toBe('pr-0002')
    })

    it('derives recentMentions and timeline from analyses, not from saved state', async () => {
      // Persisting recentMentions/timeline directly should have no effect — they
      // are computed from the analysis index, not round-tripped from state.json.
      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: null,
        recentMentions: { 'ch-0001': ['pr-0001', 'pr-0002'] },
        timeline: [{ event: 'Hero entered cave', fragmentId: 'pr-0001' }],
      })

      const loaded = await getState(dataDir, storyId)
      expect(loaded.recentMentions).toEqual({})
      expect(loaded.timeline).toEqual([])

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-pr1',
        fragmentId: 'pr-0001',
        mentionedCharacters: ['ch-0001'],
        timelineEvents: [{ event: 'Hero entered cave', position: 'during' }],
      }))

      const afterAnalysis = await getState(dataDir, storyId)
      expect(afterAnalysis.recentMentions['ch-0001']).toEqual(['pr-0001'])
      expect(afterAnalysis.timeline).toEqual([{ event: 'Hero entered cave', fragmentId: 'pr-0001' }])
    })

    it('does not duplicate mentions/timeline when a fragment is re-analyzed (in-place edit)', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-v1',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
        mentionedCharacters: ['ch-0001'],
        timelineEvents: [{ event: 'Hero entered cave', position: 'during' }],
      }))

      // Re-analysis after an in-place content edit, same fragment ID, different facts.
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-v2',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-02T00:00:00.000Z',
        mentionedCharacters: ['ch-0002'],
        timelineEvents: [{ event: 'Hero fled the cave', position: 'during' }],
      }))

      const state = await getState(dataDir, storyId)
      // Only the latest analysis's facts should appear — no stale ch-0001/old event.
      expect(state.recentMentions).toEqual({ 'ch-0002': ['pr-0001'] })
      expect(state.timeline).toEqual([{ event: 'Hero fled the cave', fragmentId: 'pr-0001' }])
    })

    it('getActiveState excludes mentions/timeline from inactive prose-chain variations', async () => {
      await addProseSection(dataDir, storyId, 'pr-old')
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        fragmentId: 'pr-old',
        createdAt: '2025-01-01T00:00:00.000Z',
        mentionedCharacters: ['ch-0001'],
        timelineEvents: [{ event: 'Hero entered cave', position: 'during' }],
      }))

      // Regenerate: new variation becomes active, old one stays in the chain but inactive.
      await addProseVariation(dataDir, storyId, 0, 'pr-new')
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        fragmentId: 'pr-new',
        createdAt: '2025-01-02T00:00:00.000Z',
        mentionedCharacters: ['ch-0002'],
        timelineEvents: [{ event: 'Hero fled the cave', position: 'during' }],
      }))

      const active = await getActiveState(dataDir, storyId)
      expect(active.recentMentions).toEqual({ 'ch-0002': ['pr-new'] })
      expect(active.timeline).toEqual([{ event: 'Hero fled the cave', fragmentId: 'pr-new' }])

      // getState (unscoped) still has both — history isn't destroyed.
      const full = await getState(dataDir, storyId)
      expect(full.recentMentions).toEqual({ 'ch-0001': ['pr-old'], 'ch-0002': ['pr-new'] })
      expect(full.timeline).toHaveLength(2)

      // Switching back to the old variation revives it in the active view, with no re-analysis.
      const { switchActiveProse } = await import('@/server/fragments/prose-chain')
      await switchActiveProse(dataDir, storyId, 0, 'pr-old')
      const revived = await getActiveState(dataDir, storyId)
      expect(revived.recentMentions).toEqual({ 'ch-0001': ['pr-old'] })
      expect(revived.timeline).toEqual([{ event: 'Hero entered cave', fragmentId: 'pr-old' }])
    })

    it('self-heals stale recentMentions/timeline written by a pre-fix state.json', async () => {
      // Simulate a story whose state.json was written by the old buggy
      // accumulator before this fix shipped: stale arrays that don't match
      // any current analysis. No migration should be required to clean it up.
      const librarianDir = join(dataDir, 'stories', storyId, 'branches', 'main', 'librarian')
      await mkdir(librarianDir, { recursive: true })
      const statePath = join(librarianDir, 'state.json')
      await writeJsonAtomic(statePath, {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: null,
        recentMentions: { 'ch-9999': ['pr-9999', 'pr-9999'] },
        timeline: [
          { event: 'Stale duplicate event', fragmentId: 'pr-9999' },
          { event: 'Stale duplicate event', fragmentId: 'pr-9999' },
        ],
      })

      const loaded = await getState(dataDir, storyId)
      expect(loaded.recentMentions).toEqual({})
      expect(loaded.timeline).toEqual([])
      expect(loaded.lastAnalyzedFragmentId).toBe('pr-0001')
    })
  })
})
