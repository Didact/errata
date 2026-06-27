import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createStory, getStory } from '@/server/fragments/storage'
import {
  saveAgentBlockConfig,
  getAgentBlockConfig,
  type AgentBlockConfig,
} from '@/server/agents/agent-block-storage'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import type { StoryMeta } from '@/server/fragments/schema'
import {
  snapshotAgentConfig,
  summarizeAgentConfig,
  buildAgentConfigPreview,
  applyAgentConfigToStory,
  filterAgentConfigBundle,
} from '@/server/erratanet/agent-config-bundle'
import {
  buildAgentConfigPack,
  unwrapAgentConfigPack,
} from '@/server/erratanet/agent-config-pack'
import {
  saveAgentPreset,
  listAgentPresets,
  getAgentPreset,
  deleteAgentPreset,
} from '@/server/erratanet/agent-preset-store'

const STORY_A = 'story-source'
const STORY_B = 'story-target'

function makeStory(id: string, overrides?: Partial<StoryMeta['settings']>): StoryMeta {
  const now = new Date().toISOString()
  return {
    id,
    name: id,
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(overrides),
  }
}

/** An agent config with one simple block and one script block. */
function makeAgentConfig(): AgentBlockConfig {
  return {
    customBlocks: [
      { id: 'cb-simple1', name: 'Voice', role: 'system', order: 10, enabled: true, type: 'simple', content: 'Write in close third person.' },
      { id: 'cb-script1', name: 'Dynamic', role: 'system', order: 20, enabled: true, type: 'script', content: 'return `tokens: ${ctx.proseFragments?.length ?? 0}`' },
    ],
    overrides: { 'builtin-x': { enabled: false } },
    blockOrder: ['builtin-x', 'cb-simple1', 'cb-script1'],
    disabledTools: ['some_tool'],
    disableAutoAnalysis: false,
  }
}

const manifestInput = {
  id: '@tester/cozy-writer',
  version: '1.0.0',
  title: 'Cozy Writer',
  description: 'A warm, close-third config.',
  license: 'MIT',
  tags: ['cozy'],
}

describe('agent-config snapshot + summary', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    // Register a stub agent so the snapshot iterates it.
    agentBlockRegistry.register({
      agentName: 'test-agent',
      displayName: 'Test Agent',
      description: 'stub',
      createDefaultBlocks: () => [],
      buildPreviewContext: async () => ({}) as never,
    })
    await seedTestProvider(dataDir) // provider name "Test", id "test-provider"
    await createStory(
      dataDir,
      makeStory(STORY_A, { modelOverrides: { generation: { providerId: 'test-provider', modelId: 'fancy-model' } } }),
    )
    await saveAgentBlockConfig(dataDir, STORY_A, 'test-agent', makeAgentConfig())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('captures every surface in a portable bundle (no API keys)', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)

    expect(bundle.agentBlockConfigs?.['test-agent']?.customBlocks).toHaveLength(2)

    const provider = bundle.providerShapes?.find((p) => p.name === 'Test')
    expect(provider).toBeDefined()
    expect(provider?.baseURL).toBe('http://localhost:0')
    expect('apiKey' in (provider as object)).toBe(false)

    const role = bundle.modelRoles?.find((r) => r.role === 'generation')
    expect(role?.providerName).toBe('Test') // referenced by name, not id
    expect(role?.model).toBe('fancy-model')
  })

  it('honors an includes filter', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A, ['agent-blocks'])
    expect(bundle.agentBlockConfigs).toBeDefined()
    expect(bundle.providerShapes).toBeUndefined()
    expect(bundle.modelRoles).toBeUndefined()
  })

  it('summarizes scripts, counts, and includes', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const summary = summarizeAgentConfig(bundle)
    expect(summary.hasScripts).toBe(true)
    expect(summary.agents).toEqual(['test-agent'])
    expect(summary.blockCount).toBe(2)
    expect(summary.includes).toEqual(
      expect.arrayContaining(['agent-blocks', 'provider-shape', 'model-roles']),
    )
  })

  it('builds a structured preview that exposes script source + block ids', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const preview = buildAgentConfigPreview(bundle)
    expect(preview.hasScripts).toBe(true)
    expect(preview.scripts).toHaveLength(1)
    expect(preview.scripts[0].content).toContain('ctx.proseFragments')
    expect(preview.scripts[0].blockId).toBe('cb-script1')
    expect(preview.agents[0].displayName).toBe('Test Agent')
    expect(preview.agents[0].blocks.map((b) => b.id)).toEqual(['cb-simple1', 'cb-script1'])
  })

  it('filters down to individual blocks (and drops scripts when deselected)', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const filtered = filterAgentConfigBundle(bundle, { agentBlocks: { 'test-agent': ['cb-simple1'] } })
    const cfg = filtered.agentBlockConfigs?.['test-agent']
    expect(cfg?.customBlocks.map((b) => b.id)).toEqual(['cb-simple1'])
    // blockOrder keeps the builtin ordering entry, drops the removed custom id.
    expect(cfg?.blockOrder).toEqual(['builtin-x', 'cb-simple1'])
    expect(summarizeAgentConfig(filtered).hasScripts).toBe(false)
    // Surfaces absent from the selection are excluded entirely.
    expect(filtered.providerShapes).toBeUndefined()
    expect(filtered.modelRoles).toBeUndefined()
  })

  it('excludes a whole agent while keeping another surface', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const filtered = filterAgentConfigBundle(bundle, { providerShapes: ['Test'] })
    expect(filtered.agentBlockConfigs).toBeUndefined()
    expect(filtered.providerShapes?.map((p) => p.name)).toEqual(['Test'])
  })

  it('excludes an agent whose blocks were all deselected (empty keep-list)', async () => {
    // The selector leaves `agents['x'] = []` when every block is unchecked; the
    // agent must NOT survive via its overrides/disabledTools and later wipe the
    // target story's own config on apply.
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const filtered = filterAgentConfigBundle(bundle, { agentBlocks: { 'test-agent': [] } })
    expect(filtered.agentBlockConfigs).toBeUndefined()
  })

  it('keeps an agent with an empty keep-list when it has no custom blocks', async () => {
    // An overrides-only agent legitimately selects as `[]` — there are no
    // block ids to list — and must still be included.
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    bundle.agentBlockConfigs = {
      'test-agent': {
        customBlocks: [],
        overrides: { 'builtin-x': { enabled: false } },
        blockOrder: ['builtin-x'],
        disabledTools: [],
        disableAutoAnalysis: false,
      },
    }
    const filtered = filterAgentConfigBundle(bundle, { agentBlocks: { 'test-agent': [] } })
    expect(filtered.agentBlockConfigs?.['test-agent']?.overrides).toEqual({ 'builtin-x': { enabled: false } })
  })
})

describe('agent-config pack build -> unwrap', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    agentBlockRegistry.register({
      agentName: 'test-agent', displayName: 'Test Agent', description: 'stub',
      createDefaultBlocks: () => [], buildPreviewContext: async () => ({}) as never,
    })
    await seedTestProvider(dataDir)
    await createStory(dataDir, makeStory(STORY_A))
    await saveAgentBlockConfig(dataDir, STORY_A, 'test-agent', makeAgentConfig())
  })
  afterEach(async () => { await cleanup() })

  it('produces an agent-config manifest with the scripts capability', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const built = buildAgentConfigPack({ bundle, manifestInput })
    expect(built.manifest.contentKind).toBe('agent-config')
    expect(built.manifest.capabilities).toEqual(expect.arrayContaining(['agent-config', 'scripts']))
    expect(built.manifest.agentConfig?.hasScripts).toBe(true)
    expect(built.manifest.fragmentCount).toBe(0)
  })

  it('round-trips the bundle through the zip form', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const built = buildAgentConfigPack({ bundle, manifestInput })
    const unwrapped = unwrapAgentConfigPack(built.zip)
    expect(unwrapped.contentKind).toBe('agent-config')
    expect(unwrapped.bundle.agentBlockConfigs?.['test-agent']?.customBlocks).toHaveLength(2)
  })

  it('round-trips through the pure-JSON form', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const built = buildAgentConfigPack({ bundle, manifestInput })
    const jsonBytes = new TextEncoder().encode(JSON.stringify(built.jsonForm))
    const unwrapped = unwrapAgentConfigPack(jsonBytes)
    expect(unwrapped.bundle.agentBlockConfigs?.['test-agent']).toBeDefined()
    expect(unwrapped.manifest.id).toBe('@tester/cozy-writer')
  })

  it('refuses a pack that declares an unknown capability', () => {
    const bundle = { _errata: 'agent-config-bundle' as const, version: 1 as const, source: 'x', exportedAt: '2026-01-01T00:00:00.000Z' }
    const built = buildAgentConfigPack({ bundle, manifestInput })
    const tampered = { ...built.jsonForm, manifest: { ...built.manifest, capabilities: ['agent-config', 'rootkit'] } }
    const bytes = new TextEncoder().encode(JSON.stringify(tampered))
    expect(() => unwrapAgentConfigPack(bytes)).toThrow(/unsupported capabilities/)
  })
})

describe('applyAgentConfigToStory', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    agentBlockRegistry.register({
      agentName: 'test-agent', displayName: 'Test Agent', description: 'stub',
      createDefaultBlocks: () => [], buildPreviewContext: async () => ({}) as never,
    })
    await seedTestProvider(dataDir)
    await createStory(
      dataDir,
      makeStory(STORY_A, { modelOverrides: { generation: { providerId: 'test-provider', modelId: 'fancy-model' } } }),
    )
    await saveAgentBlockConfig(dataDir, STORY_A, 'test-agent', makeAgentConfig())
    await createStory(dataDir, makeStory(STORY_B))
  })
  afterEach(async () => { await cleanup() })

  it('refuses to apply a script-bearing bundle without consent', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    await expect(applyAgentConfigToStory(dataDir, STORY_B, bundle)).rejects.toThrow(/consent/i)
  })

  it('applies blocks and resolves model roles by provider name', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    const result = await applyAgentConfigToStory(dataDir, STORY_B, bundle, { consentToScripts: true })

    expect(result.agentsApplied).toEqual(['test-agent'])
    const applied = await getAgentBlockConfig(dataDir, STORY_B, 'test-agent')
    expect(applied.customBlocks).toHaveLength(2)

    expect(result.modelRolesApplied).toEqual(['generation'])
    const story = await getStory(dataDir, STORY_B)
    expect(story?.settings.modelOverrides?.generation?.providerId).toBe('test-provider')
    expect(result.modelRolesNeedingProvider).toEqual([])
    expect(result.suggestedProviders.some((p) => p.name === 'Test')).toBe(true)
  })

  it('flags model roles whose provider is missing locally', async () => {
    const bundle = await snapshotAgentConfig(dataDir, STORY_A)
    // Rename the role's provider so it no longer matches any local provider.
    bundle.modelRoles = [{ role: 'generation', providerName: 'Phantom', model: 'ghost-1' }]
    const result = await applyAgentConfigToStory(dataDir, STORY_B, bundle, { consentToScripts: true })
    expect(result.modelRolesNeedingProvider).toEqual(['generation'])
    const story = await getStory(dataDir, STORY_B)
    expect(story?.settings.modelOverrides?.generation?.modelId).toBe('ghost-1')
    expect(story?.settings.modelOverrides?.generation?.providerId).toBeUndefined()
  })
})

describe('agent preset store', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })
  afterEach(async () => { await cleanup() })

  it('saves, lists (without bundle), reads, and deletes presets', async () => {
    const bundle = { _errata: 'agent-config-bundle' as const, version: 1 as const, source: 'x', exportedAt: '2026-01-01T00:00:00.000Z', agentBlockConfigs: { 'test-agent': makeAgentConfig() } }
    const saved = await saveAgentPreset(dataDir, { name: 'Cozy Writer', bundle, source: { pack: '@a/b', version: '1.0.0' } })
    expect(saved.id).toMatch(/^apreset-/)
    expect(saved.summary.hasScripts).toBe(true)

    const list = await listAgentPresets(dataDir)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Cozy Writer')
    expect('bundle' in list[0]).toBe(false)

    const full = await getAgentPreset(dataDir, saved.id)
    expect(full?.bundle.agentBlockConfigs?.['test-agent']).toBeDefined()

    expect(await deleteAgentPreset(dataDir, saved.id)).toBe(true)
    expect(await listAgentPresets(dataDir)).toHaveLength(0)
  })

  it('rejects path-traversal ids on read and delete', async () => {
    // The id comes straight from the URL; without validation `../../config`
    // would resolve to <dataDir>/config.json.
    const { writeJsonAtomic } = await import('@/server/fs-utils')
    const { join } = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    await writeJsonAtomic(join(dataDir, 'config.json'), { secret: true })

    expect(await getAgentPreset(dataDir, '../config')).toBeNull()
    expect(await deleteAgentPreset(dataDir, '../config')).toBe(false)
    expect(await getAgentPreset(dataDir, '..\\config')).toBeNull()
    expect(await deleteAgentPreset(dataDir, '..%2Fconfig')).toBe(false)

    // The file outside the preset dir is untouched.
    expect(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf-8'))).toEqual({ secret: true })
  })
})

describe('generic install path vs agent-config packs', () => {
  it('refuses an agent-config pack with a pointer to the import flow', async () => {
    const { unwrapPack } = await import('@/server/erratanet/pack-install')
    const bundle = { _errata: 'agent-config-bundle' as const, version: 1 as const, source: 'x', exportedAt: '2026-01-01T00:00:00.000Z' }
    const built = buildAgentConfigPack({ bundle, manifestInput })
    expect(() => unwrapPack(built.zip)).toThrow(/agent.config.*import flow/i)
    const jsonBytes = new TextEncoder().encode(JSON.stringify(built.jsonForm))
    expect(() => unwrapPack(jsonBytes)).toThrow(/agent.config.*import flow/i)
  })
})
