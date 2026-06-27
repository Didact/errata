import { z } from 'zod/v4'
import type { AgentConfigInclude, AgentConfigSummary } from '@/lib/erratanet/pack-schema'
import {
  AgentBlockConfigSchema,
  getAgentBlockConfig,
  saveAgentBlockConfig,
  type AgentBlockConfig,
} from '../agents/agent-block-storage'
import { agentBlockRegistry } from '../agents/agent-block-registry'
import { ensureCoreAgentsRegistered } from '../agents/register-core'
import { getGlobalConfig } from '../config/storage'
import { getStory, updateStory } from '../fragments/storage'

/**
 * The shareable "agent configuration" payload that rides inside an `agent-config`
 * erratapack. Portable by construction: no API keys, no local provider ids —
 * providers are referenced by name so the importer can match them to their own.
 *
 * Snapshot reads the surfaces from the current story + global config; apply
 * overlays them onto a target story. Scripts (executable `script` blocks) are
 * carried verbatim and gated by explicit consent at apply time, never here.
 */

/** A provider's non-secret shape. API key and custom headers are intentionally absent. */
export const PortableProviderShapeSchema = z.object({
  name: z.string(),
  preset: z.string().default('custom'),
  baseURL: z.string(),
  defaultModel: z.string(),
  temperature: z.number().nullable().optional(),
})
export type PortableProviderShape = z.infer<typeof PortableProviderShapeSchema>

/** A per-role model assignment that references its provider by name, not local id. */
export const PortableModelRoleSchema = z.object({
  role: z.string(),
  providerName: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().nullable().optional(),
})
export type PortableModelRole = z.infer<typeof PortableModelRoleSchema>

export const AgentConfigBundleSchema = z.object({
  _errata: z.literal('agent-config-bundle'),
  version: z.literal(1),
  source: z.string().default('unknown'),
  exportedAt: z.string(),
  /** Per-agent block configs keyed by agent name (incl. the generation writer). */
  agentBlockConfigs: z.record(z.string(), AgentBlockConfigSchema).optional(),
  providerShapes: z.array(PortableProviderShapeSchema).optional(),
  modelRoles: z.array(PortableModelRoleSchema).optional(),
})
export type AgentConfigBundle = z.infer<typeof AgentConfigBundleSchema>

// --- Snapshot (current config -> bundle) ---

/** Is this agent block config worth bundling, or is it untouched defaults? */
function agentConfigIsEmpty(cfg: AgentBlockConfig): boolean {
  return (
    cfg.customBlocks.length === 0 &&
    Object.keys(cfg.overrides).length === 0 &&
    cfg.blockOrder.length === 0 &&
    cfg.disabledTools.length === 0 &&
    !cfg.disableAutoAnalysis
  )
}

function wants(includes: AgentConfigInclude[] | undefined, part: AgentConfigInclude): boolean {
  return includes === undefined || includes.includes(part)
}

/**
 * Snapshot a story's agent configuration into a portable bundle. With `includes`
 * omitted, every non-empty surface is captured; pass a subset to narrow it.
 */
export async function snapshotAgentConfig(
  dataDir: string,
  storyId: string,
  includes?: AgentConfigInclude[],
): Promise<AgentConfigBundle> {
  ensureCoreAgentsRegistered()
  const bundle: AgentConfigBundle = {
    _errata: 'agent-config-bundle',
    version: 1,
    source: storyId,
    exportedAt: new Date().toISOString(),
  }

  if (wants(includes, 'agent-blocks')) {
    const configs: Record<string, AgentBlockConfig> = {}
    for (const def of agentBlockRegistry.list()) {
      const cfg = await getAgentBlockConfig(dataDir, storyId, def.agentName)
      if (!agentConfigIsEmpty(cfg)) configs[def.agentName] = cfg
    }
    if (Object.keys(configs).length > 0) bundle.agentBlockConfigs = configs
  }

  const config = await getGlobalConfig(dataDir)

  if (wants(includes, 'provider-shape') && config.providers.length > 0) {
    bundle.providerShapes = config.providers.map((p) => ({
      name: p.name,
      preset: p.preset,
      baseURL: p.baseURL,
      defaultModel: p.defaultModel,
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    }))
  }

  if (wants(includes, 'model-roles')) {
    const story = await getStory(dataDir, storyId)
    const overrides = story?.settings.modelOverrides ?? {}
    const providerName = (id: string | null | undefined): string | undefined =>
      config.providers.find((p) => p.id === id)?.name
    const roles: PortableModelRole[] = []
    for (const [role, ov] of Object.entries(overrides)) {
      const name = providerName(ov.providerId)
      // Skip empty overrides that carry nothing portable.
      if (!name && !ov.modelId && ov.temperature == null) continue
      roles.push({
        role,
        ...(name ? { providerName: name } : {}),
        ...(ov.modelId ? { model: ov.modelId } : {}),
        ...(ov.temperature != null ? { temperature: ov.temperature } : {}),
      })
    }
    if (roles.length > 0) bundle.modelRoles = roles
  }

  return bundle
}

// --- Summary + script detection ---

/** True when any bundled block is an executable `script` block. */
export function bundleHasScripts(bundle: AgentConfigBundle): boolean {
  for (const cfg of Object.values(bundle.agentBlockConfigs ?? {})) {
    if (cfg.customBlocks.some((b) => b.type === 'script')) return true
  }
  return false
}

/** The manifest-level discovery summary derived from a bundle. */
export function summarizeAgentConfig(bundle: AgentConfigBundle): AgentConfigSummary {
  const agents = Object.keys(bundle.agentBlockConfigs ?? {})
  const blockCount = Object.values(bundle.agentBlockConfigs ?? {}).reduce(
    (n, cfg) => n + cfg.customBlocks.length,
    0,
  )
  const includes: AgentConfigInclude[] = []
  if (agents.length > 0) includes.push('agent-blocks')
  if ((bundle.providerShapes?.length ?? 0) > 0) includes.push('provider-shape')
  if ((bundle.modelRoles?.length ?? 0) > 0) includes.push('model-roles')
  return { agents, blockCount, hasScripts: bundleHasScripts(bundle), includes }
}

// --- Structured preview (bundle -> human-inspectable shape, incl. script source) ---

export interface AgentConfigPreview {
  agents: {
    name: string
    displayName: string
    blocks: { id: string; name: string; role: 'system' | 'user'; type: 'simple' | 'script'; enabled: boolean }[]
    overrideCount: number
    disabledTools: string[]
  }[]
  providerShapes: PortableProviderShape[]
  modelRoles: PortableModelRole[]
  /** Verbatim source of every script block, for the consent inspection view. */
  scripts: { agent: string; blockId: string; blockName: string; content: string }[]
  hasScripts: boolean
}

/** Build the inspectable preview shown before import (no side effects). */
export function buildAgentConfigPreview(bundle: AgentConfigBundle): AgentConfigPreview {
  ensureCoreAgentsRegistered()
  const displayNameOf = (agentName: string): string =>
    agentBlockRegistry.get(agentName)?.displayName ?? agentName

  const agents: AgentConfigPreview['agents'] = []
  const scripts: AgentConfigPreview['scripts'] = []
  for (const [name, cfg] of Object.entries(bundle.agentBlockConfigs ?? {})) {
    agents.push({
      name,
      displayName: displayNameOf(name),
      blocks: cfg.customBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        role: b.role,
        type: b.type,
        enabled: b.enabled,
      })),
      overrideCount: Object.keys(cfg.overrides).length,
      disabledTools: cfg.disabledTools,
    })
    for (const b of cfg.customBlocks) {
      if (b.type === 'script') scripts.push({ agent: name, blockId: b.id, blockName: b.name, content: b.content })
    }
  }

  return {
    agents,
    providerShapes: bundle.providerShapes ?? [],
    modelRoles: bundle.modelRoles ?? [],
    scripts,
    hasScripts: scripts.length > 0,
  }
}

// --- Granular selection (bundle -> narrowed bundle) ---

/**
 * A precise pick of what to publish, down to individual blocks. Each field is a
 * whitelist; an absent or empty field excludes that surface entirely.
 *  - `agentBlocks`: agentName -> the custom-block ids to keep. A present key
 *    includes the agent (its overrides + disabled tools ride along) — EXCEPT
 *    when the source agent has custom blocks and the list is empty, which reads
 *    as "every block unchecked" and excludes the agent entirely.
 *  - the rest list items by their natural key (set name, provider name, role).
 */
export const AgentConfigSelectionSchema = z.object({
  agentBlocks: z.record(z.string(), z.array(z.string())).optional(),
  providerShapes: z.array(z.string()).optional(),
  modelRoles: z.array(z.string()).optional(),
})
export type AgentConfigSelection = z.infer<typeof AgentConfigSelectionSchema>

/** Custom block ids are minted as `cb-...`; everything else in blockOrder is a builtin. */
function isCustomBlockId(id: string): boolean {
  return id.startsWith('cb-')
}

/**
 * Narrow a bundle to exactly the selected agents/blocks/sets/providers/roles.
 * Within a kept agent, custom blocks are filtered to the selected ids (and
 * blockOrder is pruned to match, preserving builtin ordering); an agent left
 * with no blocks AND no overrides/tools is dropped as empty.
 */
export function filterAgentConfigBundle(
  bundle: AgentConfigBundle,
  selection: AgentConfigSelection,
): AgentConfigBundle {
  const next: AgentConfigBundle = {
    _errata: 'agent-config-bundle',
    version: 1,
    source: bundle.source,
    exportedAt: bundle.exportedAt,
  }

  if (selection.agentBlocks && bundle.agentBlockConfigs) {
    const configs: Record<string, AgentBlockConfig> = {}
    for (const [agentName, keepIds] of Object.entries(selection.agentBlocks)) {
      const cfg = bundle.agentBlockConfigs[agentName]
      if (!cfg) continue
      // An empty keep-list against an agent that HAS custom blocks means the
      // caller unchecked them all: exclude the agent rather than shipping (and
      // later overwriting the target with) its overrides/disabledTools.
      if (keepIds.length === 0 && cfg.customBlocks.length > 0) continue
      const keep = new Set(keepIds)
      const customBlocks = cfg.customBlocks.filter((b) => keep.has(b.id))
      const blockOrder = cfg.blockOrder.filter((id) => !isCustomBlockId(id) || keep.has(id))
      const filtered: AgentBlockConfig = { ...cfg, customBlocks, blockOrder }
      if (!agentConfigIsEmpty(filtered)) configs[agentName] = filtered
    }
    if (Object.keys(configs).length > 0) next.agentBlockConfigs = configs
  }

  if (selection.providerShapes && bundle.providerShapes) {
    const names = new Set(selection.providerShapes)
    const shapes = bundle.providerShapes.filter((p) => names.has(p.name))
    if (shapes.length > 0) next.providerShapes = shapes
  }

  if (selection.modelRoles && bundle.modelRoles) {
    const roles = new Set(selection.modelRoles)
    const filtered = bundle.modelRoles.filter((r) => roles.has(r.role))
    if (filtered.length > 0) next.modelRoles = filtered
  }

  return next
}

// --- Apply (bundle -> target story) ---

export interface ApplyAgentConfigResult {
  agentsApplied: string[]
  modelRolesApplied: string[]
  /** Role keys whose provider name matched no local provider (model still set). */
  modelRolesNeedingProvider: string[]
  /** Provider shapes the config expects; surfaced so the user can add them (with keys). */
  suggestedProviders: PortableProviderShape[]
}

/**
 * Overlay a bundle onto a target story. Non-destructive to secrets: it never
 * writes API keys and never overwrites an existing provider. Agent block configs
 * ARE overwritten (the point of adopting a config).
 *
 * Refuses to apply a bundle that carries script blocks unless `consentToScripts`
 * is explicitly true — the caller is responsible for having shown the source.
 */
export async function applyAgentConfigToStory(
  dataDir: string,
  storyId: string,
  bundle: AgentConfigBundle,
  opts: { consentToScripts?: boolean } = {},
): Promise<ApplyAgentConfigResult> {
  if (bundleHasScripts(bundle) && !opts.consentToScripts) {
    throw new Error(
      'Refusing to apply: this configuration contains executable script blocks and consent was not given.',
    )
  }

  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error('Target story not found.')

  const result: ApplyAgentConfigResult = {
    agentsApplied: [],
    modelRolesApplied: [],
    modelRolesNeedingProvider: [],
    suggestedProviders: [],
  }

  // Agent block configs: overwrite per agent.
  for (const [agentName, cfg] of Object.entries(bundle.agentBlockConfigs ?? {})) {
    await saveAgentBlockConfig(dataDir, storyId, agentName, cfg)
    result.agentsApplied.push(agentName)
  }

  // Provider shapes are surfaced as suggestions, never written (no keys to write).
  result.suggestedProviders = bundle.providerShapes ?? []

  // Model roles: resolve provider by name against the local providers.
  if ((bundle.modelRoles?.length ?? 0) > 0) {
    const config = await getGlobalConfig(dataDir)
    const findProviderId = (name: string | null | undefined): string | undefined => {
      if (!name) return undefined
      const lower = name.toLowerCase()
      return config.providers.find((p) => p.name.toLowerCase() === lower)?.id
    }
    const nextOverrides = { ...(story.settings.modelOverrides ?? {}) }
    for (const role of bundle.modelRoles!) {
      const providerId = findProviderId(role.providerName)
      nextOverrides[role.role] = {
        ...(providerId ? { providerId } : {}),
        ...(role.model ? { modelId: role.model } : {}),
        ...(role.temperature != null ? { temperature: role.temperature } : {}),
      }
      result.modelRolesApplied.push(role.role)
      if (role.providerName && !providerId) result.modelRolesNeedingProvider.push(role.role)
    }
    await updateStory(dataDir, {
      ...story,
      settings: { ...story.settings, modelOverrides: nextOverrides },
      updatedAt: new Date().toISOString(),
    })
  }

  return result
}
