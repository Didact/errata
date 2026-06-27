import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Mock the only module that talks to the network. Every hub call is replaced
 * with a vi.fn() so the routes run end to end without a real hub. The
 * pack-build / pack-install modules stay real, so install actually unwraps a
 * pack and writes fragments.
 */
const hubMocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  search: vi.fn(),
  getPack: vi.fn(),
  downloadPack: vi.fn(),
  publishVersion: vi.fn(),
  login: vi.fn(),
}))

vi.mock('@/server/erratanet/hub-client', () => ({
  getAccount: hubMocks.getAccount,
  search: hubMocks.search,
  getPack: hubMocks.getPack,
  downloadPack: hubMocks.downloadPack,
  publishVersion: hubMocks.publishVersion,
  login: hubMocks.login,
}))

import { createTempDir, makeTestSettings } from '../setup'
import { createApp } from '@/server/api'
import { createStory, getStory, listFragments } from '@/server/fragments/storage'
import { getGlobalConfigSafe, getErratanetConfig } from '@/server/config/storage'
import { buildFragmentPack } from '@/server/erratanet/pack-build'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'

describe('erratanet routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  const storyId = 'story-enet'

  function call(path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://localhost/api${path}`, init))
  }
  const post = (path: string, body: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  /** A minimal valid fragment bundle JSON string for publish tests. */
  function makeBundleJson(): string {
    const bundle: FragmentBundleData = {
      _errata: 'fragment-bundle',
      version: 1,
      source: 'test',
      exportedAt: '2025-01-01T00:00:00.000Z',
      storyName: 'Test Story',
      fragments: [
        {
          id: 'ch-alice',
          type: 'character',
          name: 'Alice',
          description: 'A curious protagonist',
          content: 'Alice is a curious protagonist.',
          tags: ['lead'],
          sticky: false,
        },
      ],
    }
    return JSON.stringify(bundle)
  }

  /** A valid manifest body half for publish. */
  const manifest = {
    id: '@me/test-pack',
    version: '1.0.0',
    title: 'Test Pack',
    description: 'A pack for tests',
    license: 'MIT',
    tags: ['test'],
  }

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)

    hubMocks.getAccount.mockReset()
    hubMocks.search.mockReset()
    hubMocks.getPack.mockReset()
    hubMocks.downloadPack.mockReset()
    hubMocks.publishVersion.mockReset()
    hubMocks.login.mockReset()

    await createStory(dataDir, {
      id: storyId,
      name: 'Enet Story',
      description: 'For erratanet tests',
      coverImage: null,
      summary: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      settings: makeTestSettings(),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  // --- config ---

  it('POST /erratanet/config stores hubUrl + token and GET returns a masked token', async () => {
    const res = await post('/erratanet/config', {
      hubUrl: 'https://hub.example.com',
      token: 'secret-token-value',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hubUrl).toBe('https://hub.example.com')
    // Token is masked, never returned raw.
    expect(body.token).toBe('••••')
    expect(body.token).not.toContain('secret-token-value')

    // The raw token is persisted server-side, untouched.
    const stored = await getErratanetConfig(dataDir)
    expect(stored.token).toBe('secret-token-value')
    expect(stored.hubUrl).toBe('https://hub.example.com')

    // GET returns the same masked view.
    const getRes = await call('/erratanet/config')
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.hubUrl).toBe('https://hub.example.com')
    expect(getBody.token).toBe('••••')
    expect(JSON.stringify(getBody)).not.toContain('secret-token-value')
  })

  it('getGlobalConfigSafe never returns the raw token', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com', token: 'top-secret' })
    const safe = await getGlobalConfigSafe(dataDir)
    expect(safe.erratanet.token).toBe('••••')
    expect(JSON.stringify(safe)).not.toContain('top-secret')
  })

  it('POST /erratanet/config trims the hubUrl', async () => {
    const res = await post('/erratanet/config', { hubUrl: '  https://hub.example.com  ' })
    const body = await res.json()
    expect(body.hubUrl).toBe('https://hub.example.com')
  })

  // --- account ---

  it('GET /erratanet/account reports not-connected with no token (never throws)', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com' })
    const res = await call('/erratanet/account')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(false)
    // The hub is never contacted without a token.
    expect(hubMocks.getAccount).not.toHaveBeenCalled()
  })

  it('GET /erratanet/account proxies to the hub when a token is set and caches the handle', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com', token: 'tok' })
    hubMocks.getAccount.mockResolvedValueOnce({ handle: 'alice', displayName: 'Alice' })

    const res = await call('/erratanet/account')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.handle).toBe('alice')
    expect(body.displayName).toBe('Alice')
    expect(hubMocks.getAccount).toHaveBeenCalledWith(dataDir)

    // Handle is cached back into config.
    const stored = await getErratanetConfig(dataDir)
    expect(stored.handle).toBe('alice')
  })

  it('GET /erratanet/account returns connected:false with an error when the hub is unreachable', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com', token: 'tok' })
    hubMocks.getAccount.mockRejectedValueOnce(new Error('boom'))

    const res = await call('/erratanet/account')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.error).toBe('boom')
  })

  // --- login ---

  it('POST /erratanet/login exchanges credentials for a token and stores it', async () => {
    hubMocks.login.mockResolvedValueOnce({ token: 'ern_minted', handle: 'alice', displayName: 'Alice' })

    const res = await post('/erratanet/login', {
      hubUrl: 'https://hub.example.com',
      identifier: 'alice',
      password: 'secret',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.handle).toBe('alice')
    expect(hubMocks.login).toHaveBeenCalledWith('https://hub.example.com', 'alice', 'secret')

    // The minted token + handle are stored; the response never exposes the raw token.
    const stored = await getErratanetConfig(dataDir)
    expect(stored.token).toBe('ern_minted')
    expect(stored.handle).toBe('alice')
    expect(JSON.stringify(body)).not.toContain('ern_minted')
  })

  it('POST /erratanet/login 401s on bad credentials and stores nothing', async () => {
    hubMocks.login.mockRejectedValueOnce(new Error('Wrong username/email or password.'))
    const res = await post('/erratanet/login', {
      hubUrl: 'https://hub.example.com',
      identifier: 'alice',
      password: 'wrong',
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.error).toContain('Wrong')
    const stored = await getErratanetConfig(dataDir)
    expect(stored.token).toBe('')
  })

  // --- publish ---

  it('POST /erratanet/publish builds a pack and calls hub publishVersion', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com', token: 'tok' })
    hubMocks.publishVersion.mockResolvedValueOnce({ id: '@me/test-pack', version: '1.0.0' })

    const res = await post('/erratanet/publish', {
      bundleJson: makeBundleJson(),
      manifest,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('@me/test-pack')
    expect(body.version).toBe('1.0.0')

    expect(hubMocks.publishVersion).toHaveBeenCalledTimes(1)
    const callArgs = hubMocks.publishVersion.mock.calls[0]
    // (dataDir, id, manifest, zip)
    expect(callArgs[0]).toBe(dataDir)
    expect(callArgs[1]).toBe('@me/test-pack')
    const builtManifest = callArgs[2]
    expect(builtManifest.id).toBe('@me/test-pack')
    expect(builtManifest.contentKind).toBe('fragment-pack')
    expect(builtManifest.fragmentCount).toBe(1)
    expect(builtManifest.fragmentTypes).toContain('character')
    // Trust model: MVP packs declare no capabilities.
    expect(builtManifest.capabilities).toEqual([])
    // The zip is real bytes.
    expect(callArgs[3]).toBeInstanceOf(Uint8Array)
    expect(callArgs[3].byteLength).toBeGreaterThan(0)
  })

  it('POST /erratanet/publish with a storyId builds a story pack, forwards visibility, stamps provenance', async () => {
    await post('/erratanet/config', { hubUrl: 'https://hub.example.com', token: 'tok' })
    hubMocks.publishVersion.mockResolvedValueOnce({ id: '@me/my-story', version: '1.0.0' })

    const res = await post('/erratanet/publish', {
      storyId,
      unlisted: true,
      manifest: { ...manifest, id: '@me/my-story' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('@me/my-story')
    // The publish response echoes where the story is now published.
    expect(body.publishedAs).toEqual({ pack: '@me/my-story', version: '1.0.0' })

    expect(hubMocks.publishVersion).toHaveBeenCalledTimes(1)
    const callArgs = hubMocks.publishVersion.mock.calls[0]
    expect(callArgs[1]).toBe('@me/my-story')
    expect(callArgs[2].contentKind).toBe('story')
    expect(callArgs[3]).toBeInstanceOf(Uint8Array)
    expect(callArgs[3].byteLength).toBeGreaterThan(0)
    // The visibility flag is forwarded to the hub.
    expect(callArgs[4]).toEqual({ unlisted: true })

    // The local story is stamped so the sidebar can offer "sync" later.
    const story = await getStory(dataDir, storyId)
    expect(story?.settings.erratanet?.publishedAs).toEqual({ pack: '@me/my-story', version: '1.0.0' })
  })

  it('POST /erratanet/publish 422s when neither bundleJson nor storyId is given', async () => {
    const res = await post('/erratanet/publish', { manifest })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(hubMocks.publishVersion).not.toHaveBeenCalled()
  })

  it('POST /erratanet/publish 422s and never publishes when the bundle is invalid', async () => {
    const res = await post('/erratanet/publish', {
      bundleJson: JSON.stringify({ not: 'a bundle' }),
      manifest,
    })
    expect(res.status).toBe(422)
    expect(hubMocks.publishVersion).not.toHaveBeenCalled()
  })

  // --- install ---

  it('POST /erratanet/install downloads a fragment pack and creates fragments with meta.erratanet', async () => {
    // Build a real fragment pack zip and hand it back from the mocked download.
    const built = buildFragmentPack({
      bundleJson: makeBundleJson(),
      manifestInput: {
        id: '@me/test-pack',
        version: '2.1.0',
        title: 'Test Pack',
        description: 'A pack for tests',
        license: 'MIT',
      },
    })
    // downloadPack returns an ArrayBuffer.
    const ab = built.zip.buffer.slice(
      built.zip.byteOffset,
      built.zip.byteOffset + built.zip.byteLength,
    )
    hubMocks.downloadPack.mockResolvedValueOnce(ab)

    const res = await post('/erratanet/install', {
      id: '@me/test-pack',
      version: '2.1.0',
      targetStoryId: storyId,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.createdStory).toBe(false)
    expect(body.storyId).toBe(storyId)
    expect(typeof body.fragmentCount).toBe('number')
    expect(body.fragmentCount).toBeGreaterThanOrEqual(1)

    expect(hubMocks.downloadPack).toHaveBeenCalledWith(dataDir, '@me/test-pack', '2.1.0')

    // The fragment exists in the story and carries erratanet provenance.
    const fragments = await listFragments(dataDir, storyId)
    const installed = fragments.find((f) => f.type === 'character' && f.name === 'Alice')
    expect(installed).toBeTruthy()
    const meta = installed!.meta as Record<string, unknown>
    expect(meta.erratanet).toMatchObject({ pack: '@me/test-pack', version: '2.1.0' })
  })

  it('POST /erratanet/install 422s when a fragment pack has no target story', async () => {
    const built = buildFragmentPack({
      bundleJson: makeBundleJson(),
      manifestInput: {
        id: '@me/test-pack',
        version: '1.0.0',
        title: 'Test Pack',
        description: 'A pack for tests',
        license: 'MIT',
      },
    })
    const ab = built.zip.buffer.slice(
      built.zip.byteOffset,
      built.zip.byteOffset + built.zip.byteLength,
    )
    hubMocks.downloadPack.mockResolvedValueOnce(ab)

    const res = await post('/erratanet/install', { id: '@me/test-pack' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })
})
