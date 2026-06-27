import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { installFragmentBundle, type PackProvenance } from '@/server/erratanet/pack-install'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'
import type { StoryMeta } from '@/server/fragments/schema'
import type { Fragment as ApiFragment } from '@/lib/api'
import { resolveHeaderImage, parseHeaderAspect, parseHeaderFade } from '@/lib/fragment-visuals'

// A prose passage published to ErrataNet with an image header should render the
// same header for whoever installs it: the linked image travels as an
// attachment, and the header settings (aspect + fade) ride along in meta.

const STORY_ID = 'story-header-roundtrip'
const PROVENANCE: PackProvenance = { pack: '@author/illustrated', version: '1.0.0' }
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: STORY_ID,
    name: 'Host',
    description: 'Receives an illustrated passage',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

// A prose fragment with a header image: meta carries the aspect + fade choices
// and a (stale, local) visualRef; the image bytes travel as an attachment.
function makeBundle(): FragmentBundleData {
  return {
    _errata: 'fragment-bundle',
    version: 1,
    source: 'test-source',
    exportedAt: new Date().toISOString(),
    storyName: 'Illustrated Pack',
    fragments: [
      {
        id: 'pr-aaaaaa',
        type: 'prose',
        name: 'Opening',
        description: 'the harbor at dusk',
        content: 'The lamps came on one by one along the quay.',
        tags: [],
        sticky: false,
        meta: {
          headerAspect: '16:9',
          headerFade: true,
          visualRefs: [{ fragmentId: 'im-orig', kind: 'image', boundary: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 } }],
        },
        attachments: [
          {
            kind: 'image',
            name: 'Harbor at dusk',
            description: 'Cover plate',
            content: PNG_DATA_URL,
            boundary: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
          },
        ],
      },
    ],
  }
}

describe('prose image header — ErrataNet round trip', () => {
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

  it('preserves the header settings and re-links the image after install', async () => {
    const created = await installFragmentBundle(dataDir, STORY_ID, makeBundle(), PROVENANCE)

    const prose = created.find((f) => f.type === 'prose')!
    expect(prose).toBeDefined()

    // Header display choices survive verbatim.
    expect(parseHeaderAspect(prose.meta)).toBe('16:9')
    expect(parseHeaderFade(prose.meta)).toBe(true)

    // The visual ref now points at a freshly-minted image fragment (not the
    // stale local id), with the crop boundary intact.
    const refs = prose.meta.visualRefs as Array<Record<string, unknown>>
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('image')
    expect(refs[0].fragmentId).not.toBe('im-orig')
    expect(refs[0].boundary).toEqual({ x: 0.1, y: 0.2, width: 0.4, height: 0.4 })

    // And the very thing the prose view renders resolves end-to-end.
    const mediaById = new Map<string, ApiFragment>(
      created.filter((f) => f.type === 'image').map((f) => [f.id, f as unknown as ApiFragment]),
    )
    expect(resolveHeaderImage(prose as unknown as ApiFragment, mediaById)).toEqual({
      imageUrl: PNG_DATA_URL,
      name: 'Harbor at dusk',
      boundary: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
    })
  })
})
