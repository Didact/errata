import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir } from '../setup'
import {
  listPresets,
  getPreset,
  createPreset,
  updatePresetMeta,
  deletePreset,
  sanitizePresetBundle,
  InvalidPresetBundleError,
} from '@/server/presets/storage'
import { PRESET_LIMITS } from '@/server/presets/schema'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'

function makeBundle(overrides?: Partial<FragmentBundleData>): FragmentBundleData {
  return {
    _errata: 'fragment-bundle',
    version: 1,
    source: 'test-source',
    exportedAt: new Date().toISOString(),
    storyName: 'Source Story',
    fragments: [
      {
        type: 'character',
        name: 'Alice',
        description: 'Protagonist',
        content: 'Alice is the protagonist.',
        tags: ['cast'],
        sticky: true,
      },
      {
        type: 'guideline',
        name: 'Tone',
        description: 'Voice guidance',
        content: 'Keep it noir.',
        tags: [],
        sticky: false,
      },
    ],
    ...overrides,
  }
}

describe('sanitizePresetBundle', () => {
  it('accepts a valid character/guideline/knowledge bundle', () => {
    const bundle = sanitizePresetBundle(makeBundle())
    expect(bundle.fragments).toHaveLength(2)
  })

  it('rejects a bundle carrying blockConfig', () => {
    const bundle = makeBundle({
      blockConfig: { customBlocks: [], overrides: {}, blockOrder: [] } as unknown as FragmentBundleData['blockConfig'],
    })
    expect(() => sanitizePresetBundle(bundle)).toThrow(InvalidPresetBundleError)
  })

  it('rejects a bundle carrying agentBlockConfigs', () => {
    const bundle = makeBundle({
      agentBlockConfigs: { generation: {} } as unknown as FragmentBundleData['agentBlockConfigs'],
    })
    expect(() => sanitizePresetBundle(bundle)).toThrow(InvalidPresetBundleError)
  })

  it('rejects a bundle carrying a prose entry', () => {
    const bundle = makeBundle({
      fragments: [
        ...makeBundle().fragments,
        { type: 'prose', name: 'Chapter 1', description: '', content: 'Once upon a time...', tags: [], sticky: false },
      ],
    })
    expect(() => sanitizePresetBundle(bundle)).toThrow(InvalidPresetBundleError)
    expect(() => sanitizePresetBundle(bundle)).toThrow(/prose/)
  })

  it('rejects an empty or malformed bundle', () => {
    expect(() => sanitizePresetBundle({ _errata: 'fragment-bundle', version: 1, fragments: [] })).toThrow(InvalidPresetBundleError)
    expect(() => sanitizePresetBundle({ not: 'a bundle' })).toThrow(InvalidPresetBundleError)
  })

  it('rejects a bundle exceeding the fragment count limit', () => {
    const many = Array.from({ length: PRESET_LIMITS.maxFragments + 1 }, (_, i) => ({
      type: 'knowledge' as const,
      name: `Fact ${i}`,
      description: '',
      content: 'x',
      tags: [],
      sticky: false,
    }))
    expect(() => sanitizePresetBundle(makeBundle({ fragments: many }))).toThrow(InvalidPresetBundleError)
  })
})

describe('preset storage', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('creates a preset, splitting meta and bundle across two files', async () => {
    const meta = await createPreset(dataDir, {
      name: 'Noir Detective Cast',
      description: 'A grim little world',
      sourceStoryName: 'Source Story',
      bundle: makeBundle(),
    })

    expect(meta.id).toMatch(/^preset-[a-z0-9]+$/)
    expect(meta.name).toBe('Noir Detective Cast')
    expect(meta.fragmentCount).toBe(2)
    expect(meta.countsByType).toEqual({ character: 1, guideline: 1 })

    const fetched = await getPreset(dataDir, meta.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.meta).toEqual(meta)
    expect(fetched?.bundle.fragments).toHaveLength(2)
  })

  it('lists presets newest first and skips unparseable directories', async () => {
    const first = await createPreset(dataDir, { name: 'First', bundle: makeBundle() })
    await new Promise((r) => setTimeout(r, 2))
    const second = await createPreset(dataDir, { name: 'Second', bundle: makeBundle() })

    const list = await listPresets(dataDir)
    expect(list.map((p) => p.id)).toEqual([second.id, first.id])
  })

  it('renames a preset without touching its bundle', async () => {
    const meta = await createPreset(dataDir, { name: 'Original', bundle: makeBundle() })
    const updated = await updatePresetMeta(dataDir, meta.id, { name: 'Renamed' })
    expect(updated?.name).toBe('Renamed')
    expect(updated?.id).toBe(meta.id)

    const fetched = await getPreset(dataDir, meta.id)
    expect(fetched?.meta.name).toBe('Renamed')
    expect(fetched?.bundle.fragments).toHaveLength(2)
  })

  it('returns null when updating or getting a preset that does not exist', async () => {
    expect(await updatePresetMeta(dataDir, 'preset-doesnotexist', { name: 'X' })).toBeNull()
    expect(await getPreset(dataDir, 'preset-doesnotexist')).toBeNull()
  })

  it('deletes a preset', async () => {
    const meta = await createPreset(dataDir, { name: 'Doomed', bundle: makeBundle() })
    expect(await deletePreset(dataDir, meta.id)).toBe(true)
    expect(await getPreset(dataDir, meta.id)).toBeNull()
    expect(await deletePreset(dataDir, meta.id)).toBe(false)
  })

  it('refuses a traversal-shaped id without touching the filesystem', async () => {
    expect(await getPreset(dataDir, '../../etc/passwd')).toBeNull()
    expect(await deletePreset(dataDir, '../../etc/passwd')).toBe(false)
  })
})
