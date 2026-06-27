import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { buildFragmentPack } from '@/server/erratanet/pack-build'
import { unwrapPack } from '@/server/erratanet/pack-install'
import {
  ErratapackManifestSchema,
  ASSET_URI_PREFIX,
} from '@/lib/erratanet/pack-schema'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'

// A 1x1 transparent PNG, base64-encoded (no data-url prefix on the raw bytes).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/**
 * A minimal fragment bundle: two character fragments that reference each other,
 * one of which carries a base64 image attachment.
 */
function makeBundle(): FragmentBundleData {
  return {
    _errata: 'fragment-bundle',
    version: 1,
    source: 'test-source',
    exportedAt: '2026-06-07T00:00:00.000Z',
    storyName: 'Test Story',
    fragments: [
      {
        id: 'ch-alice',
        type: 'character',
        name: 'Alice',
        description: 'A curious protagonist.',
        content: 'Alice is brave and inquisitive.',
        tags: ['protagonist'],
        sticky: false,
        refs: ['ch-bob'],
        attachments: [
          {
            kind: 'image',
            name: 'Alice Portrait',
            description: 'A portrait of Alice.',
            content: PNG_DATA_URL,
          },
        ],
      },
      {
        id: 'ch-bob',
        type: 'character',
        name: 'Bob',
        description: "Alice's rival.",
        content: 'Bob is cunning.',
        tags: ['rival'],
        sticky: false,
        refs: ['ch-alice'],
      },
    ],
  }
}

const manifestInput = {
  id: '@tester/duo-pack',
  version: '1.0.0',
  title: 'Duo Pack',
  description: 'Two characters who reference each other.',
  license: 'MIT',
  tags: ['characters'],
}

describe('buildFragmentPack -> unwrapPack', () => {
  it('produces a manifest that validates against the shared schema', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    expect(() => ErratapackManifestSchema.parse(built.manifest)).not.toThrow()
    expect(built.manifest.id).toBe('@tester/duo-pack')
    expect(built.manifest.version).toBe('1.0.0')
    expect(built.manifest.contentKind).toBe('fragment-pack')
    expect(built.manifest.capabilities).toEqual([])
  })

  it('derives fragmentCount and fragmentTypes from the bundle', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    expect(built.manifest.fragmentCount).toBe(2)
    expect(built.manifest.fragmentTypes).toEqual(['character'])
  })

  it('extracts the attachment to an asset:// uri inside the zip', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    const extracted = unzipSync(built.zip)

    // The bundle payload now points the attachment at an asset:// uri.
    const bundleInZip = JSON.parse(
      strFromU8(extracted['payload/bundle.json']),
    ) as FragmentBundleData
    const att = bundleInZip.fragments[0].attachments![0]
    expect(att.content.startsWith(ASSET_URI_PREFIX)).toBe(true)
    expect(att.content).not.toContain('base64,')

    // The raw bytes live under assets/<hash>.<ext>.
    const assetPaths = Object.keys(extracted).filter((p) => p.startsWith('assets/'))
    expect(assetPaths).toHaveLength(1)
    expect(assetPaths[0]).toMatch(/^assets\/[0-9a-f]{64}\.png$/)
  })

  it('re-inlines the asset to a data URL on unwrap (zip form)', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    const unwrapped = unwrapPack(built.zip)

    expect(unwrapped.contentKind).toBe('fragment-pack')
    if (unwrapped.contentKind !== 'fragment-pack') throw new Error('expected fragment-pack')

    const att = unwrapped.bundle.fragments[0].attachments![0]
    // No longer an asset:// uri: it has been re-inlined as a base64 data URL.
    expect(att.content.startsWith('data:')).toBe(true)
    expect(att.content).toContain(';base64,')
    expect(att.content.startsWith(ASSET_URI_PREFIX)).toBe(false)
    // The round-tripped base64 payload matches the original bytes.
    expect(att.content).toContain(PNG_BASE64)
  })

  it('re-inlines the asset to a data URL on unwrap (pure-JSON form)', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    const jsonBytes = new TextEncoder().encode(JSON.stringify(built.jsonForm))
    const unwrapped = unwrapPack(jsonBytes)

    expect(unwrapped.contentKind).toBe('fragment-pack')
    if (unwrapped.contentKind !== 'fragment-pack') throw new Error('expected fragment-pack')

    // The pure-JSON form stores a full data URL in assetsInline, so the mime
    // (image/png) survives the round trip here.
    const att = unwrapped.bundle.fragments[0].attachments![0]
    expect(att.content.startsWith('data:image/png;base64,')).toBe(true)
    expect(att.content).toContain(PNG_BASE64)
  })

  it('preserves cross-fragment refs through pack + unwrap', () => {
    const built = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    const unwrapped = unwrapPack(built.zip)
    if (unwrapped.contentKind !== 'fragment-pack') throw new Error('expected fragment-pack')

    const [alice, bob] = unwrapped.bundle.fragments
    expect(alice.refs).toEqual(['ch-bob'])
    expect(bob.refs).toEqual(['ch-alice'])
  })

  it('produces a stable payloadHash for identical input', () => {
    const a = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    const b = buildFragmentPack({ bundleJson: makeBundle(), manifestInput })
    expect(a.manifest.payloadHash).toBe(b.manifest.payloadHash)
    expect(a.manifest.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a bundle that carries a blockConfig', () => {
    const bundle = makeBundle()
    ;(bundle as FragmentBundleData).blockConfig = {
      customBlocks: [],
      overrides: {},
      blockOrder: ['anything'],
    } as FragmentBundleData['blockConfig']

    expect(() => buildFragmentPack({ bundleJson: bundle, manifestInput })).toThrow(/blockConfig/)
  })
})
