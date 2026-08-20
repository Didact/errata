import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createPreset, getPreset } from '@/server/presets/storage'
import { installFragmentBundle } from '@/server/erratanet/pack-install'
import { createStory, getFragment, updateFragment } from '@/server/fragments/storage'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'
import type { StoryMeta } from '@/server/fragments/schema'

const STORY_ID = 'story-apply-target'

// A 1x1 transparent PNG as a data URL, used as a portrait attachment.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: STORY_ID,
    name: 'Apply Target',
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeBundle(): FragmentBundleData {
  return {
    _errata: 'fragment-bundle',
    version: 1,
    source: 'test-source',
    exportedAt: new Date().toISOString(),
    storyName: 'Source Story',
    fragments: [
      {
        id: 'ch-alice1',
        type: 'character',
        name: 'Alice',
        description: 'Protagonist',
        content: 'Alice is the protagonist.',
        tags: ['cast'],
        sticky: true,
        placement: 'system',
        order: 3,
        refs: ['ch-bob0001'],
        attachments: [
          { kind: 'image', name: 'Alice portrait', description: 'Portrait', content: PNG_DATA_URL },
        ],
      },
      {
        id: 'ch-bob0001',
        type: 'character',
        name: 'Bob',
        description: 'Deuteragonist',
        content: 'Bob is the deuteragonist.',
        tags: ['cast'],
        sticky: false,
        refs: ['ch-alice1'],
      },
    ],
  }
}

describe('applying a preset (the "copied, not shared" contract)', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('produces fresh, independent copies with re-wired refs and a recreated portrait', async () => {
    const preset = await createPreset(dataDir, { name: 'Noir Detective Cast', bundle: makeBundle() })
    const { bundle } = (await getPreset(dataDir, preset.id))!

    const created = await installFragmentBundle(dataDir, STORY_ID, bundle, {
      pack: preset.id,
      version: '0.0.0',
      kind: 'preset',
      presetName: preset.name,
    })

    const alice = created.find((f) => f.name === 'Alice')!
    const bob = created.find((f) => f.name === 'Bob')!

    // Ids are only remapped on collision (see the disjoint-id test below for
    // that case) into a fresh story they're kept as-is. Either way, what
    // matters for "copied, not shared" is that these are independent Fragment
    // records (the preset's own bundle.json is untouched, proven in the next
    // test), with refs staying internally consistent regardless of which id
    // scheme applied.
    expect(alice.refs).toEqual([bob.id])
    expect(bob.refs).toEqual([alice.id])

    // sticky / placement / order / tags survive the copy.
    expect(alice.sticky).toBe(true)
    expect(alice.placement).toBe('system')
    expect(alice.order).toBe(3)
    expect(alice.tags).toEqual(['cast'])

    // The portrait was recreated as its own fragment and wired via visualRefs.
    const visualRefs = alice.meta.visualRefs as Array<{ fragmentId: string; kind: string }>
    expect(visualRefs).toHaveLength(1)
    const portrait = created.find((f) => f.id === visualRefs[0].fragmentId)!
    expect(portrait.type).toBe('image')
    expect(portrait.content).toBe(PNG_DATA_URL)

    // Provenance says "preset", not "erratanet" (hub) content.
    expect(alice.meta.preset).toMatchObject({ id: preset.id, name: 'Noir Detective Cast' })
    expect(alice.meta.erratanet).toBeUndefined()
  })

  it('leaves the preset bundle untouched when a copy is edited afterward', async () => {
    const preset = await createPreset(dataDir, { name: 'Noir Detective Cast', bundle: makeBundle() })
    const before = (await getPreset(dataDir, preset.id))!.bundle

    const created = await installFragmentBundle(dataDir, STORY_ID, before, {
      pack: preset.id,
      version: '0.0.0',
      kind: 'preset',
      presetName: preset.name,
    })
    const alice = created.find((f) => f.name === 'Alice')!

    // Editing the copy in the story...
    const stored = (await getFragment(dataDir, STORY_ID, alice.id))!
    await updateFragment(dataDir, STORY_ID, { ...stored, content: 'Alice has been rewritten.' })

    // ...must not change the preset's stored bundle at all.
    const after = (await getPreset(dataDir, preset.id))!.bundle
    expect(after).toEqual(before)
    const originalAlice = after.fragments.find((f) => f.id === 'ch-alice1')!
    expect(originalAlice.content).toBe('Alice is the protagonist.')
  })

  it('applying the same preset twice yields two fully disjoint sets of fragment ids', async () => {
    const preset = await createPreset(dataDir, { name: 'Noir Detective Cast', bundle: makeBundle() })
    const { bundle } = (await getPreset(dataDir, preset.id))!

    const provenance = { pack: preset.id, version: '0.0.0', kind: 'preset' as const, presetName: preset.name }
    const first = await installFragmentBundle(dataDir, STORY_ID, bundle, provenance)
    const second = await installFragmentBundle(dataDir, STORY_ID, bundle, provenance)

    const firstIds = new Set(first.map((f) => f.id))
    for (const frag of second) {
      expect(firstIds.has(frag.id)).toBe(false)
    }
  })
})
