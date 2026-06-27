import { readdir, readFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { AgentConfigSummarySchema } from '@/lib/erratanet/pack-schema'
import { writeJsonAtomic } from '../fs-utils'
import {
  AgentConfigBundleSchema,
  summarizeAgentConfig,
  type AgentConfigBundle,
} from './agent-config-bundle'

/**
 * Global, story-independent store of saved agent-configuration presets. An
 * imported config (or a snapshot of the current story) lands here so it can be
 * applied to any story later. Files live at `dataDir/agent-presets/<id>.json`.
 */

export const AgentPresetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  createdAt: z.string(),
  /** Where this preset came from, if imported from a hub pack. */
  source: z.object({ pack: z.string(), version: z.string() }).optional(),
  summary: AgentConfigSummarySchema,
  bundle: AgentConfigBundleSchema,
})
export type AgentPreset = z.infer<typeof AgentPresetSchema>

/** A preset without its (potentially large) bundle — for list views. */
export type AgentPresetSummary = Omit<AgentPreset, 'bundle'>

function presetDir(dataDir: string): string {
  return join(dataDir, 'agent-presets')
}

/**
 * Saved ids are `apreset-<uuid prefix>`, but read/delete take the id from the
 * URL — reject anything that could escape the preset directory when joined
 * into a path (e.g. `../../config`).
 */
const PRESET_ID_REGEX = /^[A-Za-z0-9-]+$/

function presetPath(dataDir: string, id: string): string | null {
  if (!PRESET_ID_REGEX.test(id)) return null
  return join(presetDir(dataDir), `${id}.json`)
}

/** Strip the bundle for list responses. */
function toSummary(preset: AgentPreset): AgentPresetSummary {
  const { bundle: _bundle, ...rest } = preset
  return rest
}

export async function listAgentPresets(dataDir: string): Promise<AgentPresetSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(presetDir(dataDir))
  } catch {
    return []
  }
  const presets: AgentPreset[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await readFile(join(presetDir(dataDir), entry), 'utf-8')
      const parsed = AgentPresetSchema.safeParse(JSON.parse(raw))
      if (parsed.success) presets.push(parsed.data)
    } catch {
      // Skip malformed entries.
    }
  }
  presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return presets.map(toSummary)
}

export async function getAgentPreset(dataDir: string, id: string): Promise<AgentPreset | null> {
  const path = presetPath(dataDir, id)
  if (!path) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return AgentPresetSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveAgentPreset(
  dataDir: string,
  input: { name: string; bundle: AgentConfigBundle; source?: { pack: string; version: string } },
): Promise<AgentPreset> {
  const bundle = AgentConfigBundleSchema.parse(input.bundle)
  const preset: AgentPreset = {
    id: `apreset-${randomUUID().slice(0, 12)}`,
    name: input.name.trim() || 'Untitled config',
    createdAt: new Date().toISOString(),
    ...(input.source ? { source: input.source } : {}),
    summary: summarizeAgentConfig(bundle),
    bundle,
  }
  const path = presetPath(dataDir, preset.id)
  if (!path) throw new Error('Invalid preset id.')
  await mkdir(presetDir(dataDir), { recursive: true })
  await writeJsonAtomic(path, preset)
  return preset
}

export async function deleteAgentPreset(dataDir: string, id: string): Promise<boolean> {
  const path = presetPath(dataDir, id)
  if (!path) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}
