import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, createFragment, getFragment, listFragments } from '@/server/fragments/storage'
import { installFragmentBundle, type PackProvenance } from '@/server/erratanet/pack-install'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'

const STORY_ID = 'story-erratanet'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: STORY_ID,
    name: 'Host Story',
    description: 'Story that receives an installed pack',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'ch-aaaaaa',
    type: 'character',
    name: 'Existing',
    description: 'A fragment already living in the story',
    content: 'Occupies the colliding id',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
    version: 1,
    versions: [],
    ...overrides,
  }
}

const PROVENANCE: PackProvenance = { pack: '@author/starter', version: '1.2.3' }

// A 1x1 transparent PNG as a data URL, used as an attachment payload.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

/**
 * Bundle with two character fragments that reference each other by their
 * (local) ids. `ch-aaaaaa` deliberately collides with a fragment we pre-create
 * in the story. The first fragment carries an image attachment.
 */
function makeBundle(): FragmentBundleData {
  return {
    _errata: 'fragment-bundle',
    version: 1,
    source: 'test-source',
    exportedAt: new Date().toISOString(),
    storyName: 'Starter Pack',
    fragments: [
      {
        id: 'ch-aaaaaa', // collides with the pre-existing fragment
        type: 'character',
        name: 'Alice',
        description: 'Knows Bob',
        content: 'Alice is the protagonist.',
        tags: ['cast'],
        sticky: true,
        refs: ['ch-bbbbbb'], // points at the sibling below
        placement: 'user',
        order: 5,
        attachments: [
          {
            kind: 'image',
            name: 'Alice portrait',
            description: 'Portrait',
            content: PNG_DATA_URL,
            boundary: { x: 1, y: 2, width: 3, height: 4 },
          },
        ],
      },
      {
        id: 'ch-bbbbbb',
        type: 'character',
        name: 'Bob',
        description: 'Knows Alice',
        content: 'Bob is the deuteragonist.',
        tags: ['cast'],
        sticky: false,
        refs: ['ch-aaaaaa'], // points back at the first
      },
    ],
  }
}

describe('installFragmentBundle', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
    // Pre-create a fragment that occupies one of the bundle's ids.
    await createFragment(dataDir, STORY_ID, makeFragment({ id: 'ch-aaaaaa' }))
  })

  afterEach(async () => {
    await cleanup()
  })

  it('remaps colliding ids to fresh ones without overwriting the existing fragment', async () => {
    const before = await getFragment(dataDir, STORY_ID, 'ch-aaaaaa')
    expect(before?.name).toBe('Existing')

    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    // The pre-existing fragment is untouched.
    const stillThere = await getFragment(dataDir, STORY_ID, 'ch-aaaaaa')
    expect(stillThere?.name).toBe('Existing')
    expect(stillThere?.content).toBe('Occupies the colliding id')

    // Neither installed character kept the colliding local id.
    const characters = created.filter((f) => f.type === 'character')
    expect(characters).toHaveLength(2)
    for (const frag of characters) {
      expect(frag.id).not.toBe('ch-aaaaaa')
    }

    // Every created id is unique and matches the prefix/scheme for its type.
    const allIds = created.map((f) => f.id)
    expect(new Set(allIds).size).toBe(allIds.length)
    for (const frag of characters) {
      expect(frag.id).toMatch(/^ch-[a-z0-9]{4,12}$/)
    }
  })

  it('re-wires cross-fragment refs to the new ids instead of leaving them dangling', async () => {
    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    const alice = created.find((f) => f.name === 'Alice')!
    const bob = created.find((f) => f.name === 'Bob')!
    expect(alice).toBeDefined()
    expect(bob).toBeDefined()

    // Refs point at the live sibling ids, in both directions.
    expect(alice.refs).toEqual([bob.id])
    expect(bob.refs).toEqual([alice.id])

    // Bob kept his non-colliding local id, so Alice's ref to him is unchanged.
    expect(bob.id).toBe('ch-bbbbbb')
    expect(alice.refs).toEqual(['ch-bbbbbb'])

    // Alice's id WAS remapped (it collided), so Bob's ref to her was re-wired
    // away from the stale local id 'ch-aaaaaa' (which still belongs to the
    // pre-existing fragment) and onto Alice's fresh id.
    expect(alice.id).not.toBe('ch-aaaaaa')
    expect(bob.refs).not.toContain('ch-aaaaaa')
    expect(bob.refs).toEqual([alice.id])

    // Refs survive a round trip through storage.
    const storedAlice = await getFragment(dataDir, STORY_ID, alice.id)
    expect(storedAlice?.refs).toEqual([bob.id])
  })

  it('turns attachments into image fragments with remapped visualRefs', async () => {
    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    const alice = created.find((f) => f.name === 'Alice')!
    const visualRefs = alice.meta.visualRefs as Array<Record<string, unknown>>
    expect(Array.isArray(visualRefs)).toBe(true)
    expect(visualRefs).toHaveLength(1)

    const ref = visualRefs[0]
    expect(ref.kind).toBe('image')
    expect(ref.boundary).toEqual({ x: 1, y: 2, width: 3, height: 4 })

    // The visualRef points at a freshly-minted image fragment that actually exists.
    const mediaId = ref.fragmentId as string
    expect(mediaId).toMatch(/^im-[a-z0-9]{4,12}$/)
    const media = created.find((f) => f.id === mediaId)
    expect(media).toBeDefined()
    expect(media?.type).toBe('image')
    expect(media?.name).toBe('Alice portrait')
    expect(media?.content).toBe(PNG_DATA_URL)

    // And it is persisted, findable by listing image fragments.
    const images = await listFragments(dataDir, STORY_ID, 'image')
    expect(images.map((f) => f.id)).toContain(mediaId)
  })

  it('stamps erratanet provenance on every installed fragment', async () => {
    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    const alice = created.find((f) => f.name === 'Alice')!
    const prov = alice.meta.erratanet as Record<string, unknown>
    expect(prov).toMatchObject({
      pack: '@author/starter',
      version: '1.2.3',
      sourceLocalId: 'ch-aaaaaa',
    })

    const bob = created.find((f) => f.name === 'Bob')!
    expect(bob.meta.erratanet).toMatchObject({
      pack: '@author/starter',
      version: '1.2.3',
      sourceLocalId: 'ch-bbbbbb',
    })

    // Attachment-derived media fragments also carry provenance.
    const media = created.find((f) => f.type === 'image')!
    expect(media.meta.erratanet).toMatchObject({
      pack: '@author/starter',
      version: '1.2.3',
    })
  })

  it('preserves sticky / placement / order from the bundle entry', async () => {
    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    const alice = created.find((f) => f.name === 'Alice')!
    expect(alice.sticky).toBe(true)
    expect(alice.placement).toBe('user')
    expect(alice.order).toBe(5)
    expect(alice.tags).toEqual(['cast'])
  })
})
