import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../fs-utils'
import {
  StoryPresetMetaSchema,
  PRESET_FRAGMENT_TYPES,
  PRESET_LIMITS,
  PRESET_ID_REGEX,
  type StoryPresetMeta,
} from './schema'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'

/** Thrown by `sanitizePresetBundle` — carries an HTTP-appropriate message. */
export class InvalidPresetBundleError extends Error {}

function presetsDir(dataDir: string): string {
  return join(dataDir, 'presets')
}

function presetDir(dataDir: string, presetId: string): string {
  return join(presetsDir(dataDir), presetId)
}

function presetMetaPath(dataDir: string, presetId: string): string {
  return join(presetDir(dataDir, presetId), 'meta.json')
}

function presetBundlePath(dataDir: string, presetId: string): string {
  return join(presetDir(dataDir, presetId), 'bundle.json')
}

function generatePresetId(): string {
  return `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as T
}

/**
 * The trust boundary for preset payloads. Mirrors the refusal already applied
 * to `POST /stories/:storyId/fragments/import-bundle`
 * (`src/server/routes/fragments.ts`): no block/agent configuration may ride
 * along. Additionally, only non-prose content types may enter a preset —
 * prose, summaries, and markers can never be saved as one — and the bundle
 * must fit within `PRESET_LIMITS`.
 */
export function sanitizePresetBundle(bundle: unknown): FragmentBundleData {
  const data = bundle as FragmentBundleData
  if (data?._errata !== 'fragment-bundle' || !Array.isArray(data.fragments) || data.fragments.length === 0) {
    throw new InvalidPresetBundleError('Invalid fragment bundle')
  }
  if (data.blockConfig || data.agentBlockConfigs) {
    throw new InvalidPresetBundleError('Refusing bundle: block configuration is not allowed in a preset')
  }
  if (data.fragments.length > PRESET_LIMITS.maxFragments) {
    throw new InvalidPresetBundleError(`Preset may not exceed ${PRESET_LIMITS.maxFragments} fragments`)
  }
  const disallowed = new Set(data.fragments.map((f) => f.type).filter((t) => !(PRESET_FRAGMENT_TYPES as readonly string[]).includes(t)))
  if (disallowed.size > 0) {
    throw new InvalidPresetBundleError(
      `Preset may only contain ${PRESET_FRAGMENT_TYPES.join('/')} fragments; found: ${[...disallowed].join(', ')}`,
    )
  }
  const size = Buffer.byteLength(JSON.stringify(data), 'utf-8')
  if (size > PRESET_LIMITS.maxBytes) {
    throw new InvalidPresetBundleError(`Preset payload exceeds ${Math.floor(PRESET_LIMITS.maxBytes / (1024 * 1024))} MiB`)
  }
  return data
}

function countsByType(bundle: FragmentBundleData): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of bundle.fragments) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1
  }
  return counts
}

export async function listPresets(dataDir: string): Promise<StoryPresetMeta[]> {
  const dir = presetsDir(dataDir)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const metas: StoryPresetMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await readJson<unknown>(presetMetaPath(dataDir, entry.name))
      if (raw) metas.push(StoryPresetMetaSchema.parse(raw))
    } catch {
      // Skip an unparseable preset directory rather than failing the whole list.
    }
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getPreset(
  dataDir: string,
  presetId: string,
): Promise<{ meta: StoryPresetMeta; bundle: FragmentBundleData } | null> {
  if (!PRESET_ID_REGEX.test(presetId)) return null
  const meta = await readJson<StoryPresetMeta>(presetMetaPath(dataDir, presetId))
  if (!meta) return null
  const bundle = await readJson<FragmentBundleData>(presetBundlePath(dataDir, presetId))
  if (!bundle) return null
  return { meta: StoryPresetMetaSchema.parse(meta), bundle }
}

export interface CreatePresetInput {
  name: string
  description?: string
  sourceStoryName?: string
  bundle: unknown
}

export async function createPreset(dataDir: string, input: CreatePresetInput): Promise<StoryPresetMeta> {
  const bundle = sanitizePresetBundle(input.bundle)
  const now = new Date().toISOString()
  const id = generatePresetId()
  const meta = StoryPresetMetaSchema.parse({
    id,
    name: input.name,
    description: input.description ?? '',
    sourceStoryName: input.sourceStoryName,
    fragmentCount: bundle.fragments.length,
    countsByType: countsByType(bundle),
    createdAt: now,
    updatedAt: now,
  })

  const dir = presetDir(dataDir, id)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(presetMetaPath(dataDir, id), meta)
  await writeJsonAtomic(presetBundlePath(dataDir, id), bundle)
  return meta
}

export interface UpdatePresetMetaInput {
  name?: string
  description?: string
}

export async function updatePresetMeta(
  dataDir: string,
  presetId: string,
  patch: UpdatePresetMetaInput,
): Promise<StoryPresetMeta | null> {
  const existing = await getPreset(dataDir, presetId)
  if (!existing) return null
  const meta = StoryPresetMetaSchema.parse({
    ...existing.meta,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    updatedAt: new Date().toISOString(),
  })
  await writeJsonAtomic(presetMetaPath(dataDir, presetId), meta)
  return meta
}

export async function deletePreset(dataDir: string, presetId: string): Promise<boolean> {
  if (!PRESET_ID_REGEX.test(presetId)) return false
  const dir = presetDir(dataDir, presetId)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
