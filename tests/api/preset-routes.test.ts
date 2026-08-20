import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir } from '../setup'
import { createApp } from '@/server/api'

let dataDir: string
let cleanup: () => Promise<void>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const tmp = await createTempDir()
  dataDir = tmp.path
  cleanup = tmp.cleanup
  app = createApp(dataDir)
})

afterEach(async () => {
  await cleanup()
})

async function api(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, init))
  return { status: res.status, json: async () => res.json() }
}

async function apiJson(path: string, body: unknown, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeBundle(overrides?: Record<string, unknown>) {
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
        refs: ['ch-bob0001'],
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
    ...overrides,
  }
}

describe('Preset API routes', () => {
  it('POST /api/presets creates a preset from a bundle', async () => {
    const res = await apiJson('/presets', { name: 'Noir Cast', bundle: makeBundle() })
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.id).toMatch(/^preset-[a-z0-9]+$/)
    expect(meta.name).toBe('Noir Cast')
    expect(meta.fragmentCount).toBe(2)
  })

  it('POST /api/presets refuses a bundle carrying blockConfig', async () => {
    const res = await apiJson('/presets', {
      name: 'Bad preset',
      bundle: makeBundle({ blockConfig: { customBlocks: [], overrides: {}, blockOrder: [] } }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/block configuration/i)
  })

  it('POST /api/presets refuses a bundle carrying a prose fragment', async () => {
    const res = await apiJson('/presets', {
      name: 'Bad preset',
      bundle: makeBundle({
        fragments: [
          ...makeBundle().fragments,
          { type: 'prose', name: 'Ch1', description: '', content: 'text', tags: [], sticky: false },
        ],
      }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/prose/)
  })

  it('GET /api/presets lists created presets', async () => {
    await apiJson('/presets', { name: 'First', bundle: makeBundle() })
    await apiJson('/presets', { name: 'Second', bundle: makeBundle() })

    const res = await api('/presets')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.presets).toHaveLength(2)
  })

  it('GET /api/presets/:id returns the meta and bundle', async () => {
    const created = await (await apiJson('/presets', { name: 'Noir Cast', bundle: makeBundle() })).json()
    const res = await api(`/presets/${created.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.id).toBe(created.id)
    expect(body.bundle.fragments).toHaveLength(2)
  })

  it('GET /api/presets/:id 404s for an unknown preset', async () => {
    const res = await api('/presets/preset-doesnotexist')
    expect(res.status).toBe(404)
  })

  it('PATCH /api/presets/:id renames a preset', async () => {
    const created = await (await apiJson('/presets', { name: 'Original', bundle: makeBundle() })).json()
    const res = await apiJson(`/presets/${created.id}`, { name: 'Renamed' }, 'PATCH')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Renamed')
  })

  it('PATCH /api/presets/:id 404s for an unknown preset', async () => {
    const res = await apiJson('/presets/preset-doesnotexist', { name: 'X' }, 'PATCH')
    expect(res.status).toBe(404)
  })

  it('DELETE /api/presets/:id deletes a preset', async () => {
    const created = await (await apiJson('/presets', { name: 'Doomed', bundle: makeBundle() })).json()
    const res = await api(`/presets/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await api(`/presets/${created.id}`)).status).toBe(404)
  })

  it('DELETE /api/presets/:id 404s for an unknown preset', async () => {
    const res = await api('/presets/preset-doesnotexist', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('POST /api/presets/:id/apply copies fresh fragments into a story', async () => {
    const preset = await (await apiJson('/presets', { name: 'Noir Cast', bundle: makeBundle() })).json()
    const story = await (await apiJson('/stories', { name: 'Target Story', description: '' })).json()

    const res = await apiJson(`/presets/${preset.id}/apply`, { storyId: story.id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)

    const alice = body.fragments.find((f: { name: string }) => f.name === 'Alice')
    const bob = body.fragments.find((f: { name: string }) => f.name === 'Bob')
    expect(alice).toBeDefined()
    expect(bob).toBeDefined()

    // Copied, not shared: refs stay consistent between the copies (ids are
    // only remapped on collision — into a fresh story they're kept as-is,
    // proven disjoint from the *second* apply below), and provenance is
    // stamped as a preset copy, never as erratanet (hub) content.
    expect(alice.refs).toEqual([bob.id])
    expect(bob.refs).toEqual([alice.id])
    expect(alice.meta.preset).toMatchObject({ id: preset.id, name: 'Noir Cast' })
    expect(alice.meta.erratanet).toBeUndefined()

    // The preset itself is untouched by the apply.
    const stillThere = await (await api(`/presets/${preset.id}`)).json()
    expect(stillThere.bundle.fragments.find((f: { id: string }) => f.id === 'ch-alice1')).toBeDefined()

    // Applying it again produces a second, disjoint set of copies.
    const res2 = await apiJson(`/presets/${preset.id}/apply`, { storyId: story.id })
    const body2 = await res2.json()
    const firstIds = new Set(body.fragments.map((f: { id: string }) => f.id))
    for (const frag of body2.fragments) {
      expect(firstIds.has(frag.id)).toBe(false)
    }
  })

  it('POST /api/presets/:id/apply 404s for an unknown preset', async () => {
    const story = await (await apiJson('/stories', { name: 'Target Story', description: '' })).json()
    const res = await apiJson('/presets/preset-doesnotexist/apply', { storyId: story.id })
    expect(res.status).toBe(404)
  })

  it('POST /api/presets/:id/apply 404s for an unknown story', async () => {
    const preset = await (await apiJson('/presets', { name: 'Noir Cast', bundle: makeBundle() })).json()
    const res = await apiJson(`/presets/${preset.id}/apply`, { storyId: 'story-doesnotexist' })
    expect(res.status).toBe(404)
  })
})
