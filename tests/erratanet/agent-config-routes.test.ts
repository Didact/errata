import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** Mock the only network module; build/unwrap/apply stay real. */
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

import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createApp } from '@/server/api'
import { createStory, getStory } from '@/server/fragments/storage'
import { getAgentBlockConfig, saveAgentBlockConfig, type AgentBlockConfig } from '@/server/agents/agent-block-storage'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import type { StoryMeta } from '@/server/fragments/schema'

const SOURCE = 'story-src'
const TARGET = 'story-tgt'

function makeStory(id: string, overrides?: Partial<StoryMeta['settings']>): StoryMeta {
  const now = new Date().toISOString()
  return { id, name: id, description: '', coverImage: null, summary: '', createdAt: now, updatedAt: now, settings: makeTestSettings(overrides) }
}

function makeAgentConfig(): AgentBlockConfig {
  return {
    customBlocks: [
      { id: 'cb-voice1', name: 'Voice', role: 'system', order: 10, enabled: true, type: 'simple', content: 'Close third person.' },
      { id: 'cb-dyn001', name: 'Dynamic', role: 'system', order: 20, enabled: true, type: 'script', content: 'return "x"' },
    ],
    overrides: {},
    blockOrder: ['cb-voice1', 'cb-dyn001'],
    disabledTools: [],
    disableAutoAnalysis: false,
  }
}

const manifest = {
  id: '@me/cozy-writer',
  version: '1.0.0',
  title: 'Cozy Writer',
  description: 'Warm close-third config.',
  license: 'MIT',
  tags: ['cozy'],
}

describe('agent-config routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  let publishedZip: Uint8Array | null = null

  const call = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost/api${path}`, init))
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)
    publishedZip = null

    agentBlockRegistry.register({
      agentName: 'test-agent', displayName: 'Test Agent', description: 'stub',
      createDefaultBlocks: () => [], buildPreviewContext: async () => ({}) as never,
    })

    await seedTestProvider(dataDir)
    await createStory(dataDir, makeStory(SOURCE, { modelOverrides: { generation: { providerId: 'test-provider', modelId: 'fancy' } } }))
    await createStory(dataDir, makeStory(TARGET))
    await saveAgentBlockConfig(dataDir, SOURCE, 'test-agent', makeAgentConfig())

    hubMocks.publishVersion.mockImplementation(async (_d: string, id: string, m: { version: string }, zip: Uint8Array) => {
      publishedZip = zip
      return { id, version: m.version }
    })
    hubMocks.downloadPack.mockImplementation(async () => {
      if (!publishedZip) throw new Error('nothing published')
      return publishedZip.slice().buffer
    })
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await cleanup()
  })

  it('snapshots the current story config', async () => {
    const res = await post('/erratanet/agent-config/snapshot', { storyId: SOURCE })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.hasScripts).toBe(true)
    expect(body.summary.agents).toContain('test-agent')
    expect(body.preview.scripts).toHaveLength(1)
  })

  it('publishes an agent-config pack with the scripts capability', async () => {
    const res = await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('@me/cozy-writer')
    const passedManifest = hubMocks.publishVersion.mock.calls[0][2]
    expect(passedManifest.contentKind).toBe('agent-config')
    expect(passedManifest.capabilities).toEqual(expect.arrayContaining(['agent-config', 'scripts']))
  })

  it('stamps the story so a shared config can be re-synced, deduped by pack id', async () => {
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    let story = await getStory(dataDir, SOURCE)
    expect(story?.settings.erratanet?.agentConfigs).toHaveLength(1)
    expect(story?.settings.erratanet?.agentConfigs?.[0].pack).toBe('@me/cozy-writer')
    expect(story?.settings.erratanet?.agentConfigs?.[0].version).toBe('1.0.0')
    expect(story?.settings.erratanet?.agentConfigs?.[0].includes).toContain('agent-blocks')

    // Re-publishing the same pack at a new version updates the slot in place.
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest: { ...manifest, version: '1.1.0' } })
    story = await getStory(dataDir, SOURCE)
    expect(story?.settings.erratanet?.agentConfigs).toHaveLength(1)
    expect(story?.settings.erratanet?.agentConfigs?.[0].version).toBe('1.1.0')
  })

  it('publishes only the selected blocks, dropping the scripts capability', async () => {
    const res = await post('/erratanet/agent-config/publish', {
      storyId: SOURCE,
      manifest,
      // Keep only the non-script block of test-agent; drop every other surface.
      selection: { agentBlocks: { 'test-agent': ['cb-voice1'] } },
    })
    expect(res.status).toBe(200)
    const passedManifest = hubMocks.publishVersion.mock.calls[0][2]
    expect(passedManifest.capabilities).toEqual(['agent-config'])
    expect(passedManifest.capabilities).not.toContain('scripts')
    expect(passedManifest.agentConfig.blockCount).toBe(1)
    expect(passedManifest.agentConfig.includes).toEqual(['agent-blocks'])
  })

  it('applies only the selected blocks, so no consent is needed', async () => {
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    const res = await post('/erratanet/agent-config/apply', {
      id: '@me/cozy-writer',
      applyToStoryId: TARGET,
      // Only the simple block: the script is excluded, so consent is moot.
      selection: { agentBlocks: { 'test-agent': ['cb-voice1'] } },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied.agentsApplied).toContain('test-agent')
    const cfg = await getAgentBlockConfig(dataDir, TARGET, 'test-agent')
    expect(cfg.customBlocks.map((b) => b.id)).toEqual(['cb-voice1'])
  })

  it('inspects a published pack without applying it', async () => {
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    const res = await post('/erratanet/agent-config/inspect', { id: '@me/cozy-writer' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.requiresConsent).toBe(true)
    expect(body.preview.scripts[0].content).toBe('return "x"')
  })

  it('refuses to apply a script pack without consent', async () => {
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    const res = await post('/erratanet/agent-config/apply', { id: '@me/cozy-writer', applyToStoryId: TARGET })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.requiresConsent).toBe(true)
    // Nothing was written to the target.
    const cfg = await getAgentBlockConfig(dataDir, TARGET, 'test-agent')
    expect(cfg.customBlocks).toHaveLength(0)
  })

  it('applies with consent and saves a preset in one call', async () => {
    await post('/erratanet/agent-config/publish', { storyId: SOURCE, manifest })
    const res = await post('/erratanet/agent-config/apply', {
      id: '@me/cozy-writer',
      applyToStoryId: TARGET,
      consentToScripts: true,
      savePreset: { name: 'Cozy' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied.agentsApplied).toContain('test-agent')
    expect(body.presetId).toMatch(/^apreset-/)

    const cfg = await getAgentBlockConfig(dataDir, TARGET, 'test-agent')
    expect(cfg.customBlocks).toHaveLength(2)

    // The saved preset is listable and applyable to another story.
    const list = await (await call('/erratanet/agent-presets')).json()
    expect(list.presets).toHaveLength(1)
    const applyRes = await post(`/erratanet/agent-presets/${list.presets[0].id}/apply`, { storyId: TARGET, consentToScripts: true })
    expect(applyRes.status).toBe(200)
  })

  it('saves a preset directly from a story', async () => {
    const res = await post('/erratanet/agent-presets', { name: 'From Story', fromStoryId: SOURCE })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.hasScripts).toBe(true)
  })
})
