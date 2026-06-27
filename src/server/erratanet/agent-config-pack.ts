import { createHash } from 'node:crypto'
import { zipSync, unzipSync, strFromU8 } from 'fflate'
import {
  ErratapackManifestSchema,
  KNOWN_CAPABILITIES,
  type ErratapackManifest,
  type ErratapackJson,
} from '@/lib/erratanet/pack-schema'
import {
  AgentConfigBundleSchema,
  summarizeAgentConfig,
  bundleHasScripts,
  type AgentConfigBundle,
} from './agent-config-bundle'
import type { PackManifestInput } from './pack-build'

/**
 * Build + unwrap pipeline for the `agent-config` pack kind. Unlike fragment/story
 * packs, the payload is a single JSON document (the {@link AgentConfigBundle}) —
 * there are no binary assets to content-address. The manifest carries the
 * `agent-config` capability (plus `scripts` when the bundle contains executable
 * blocks), which is what gates consent at install time.
 */

const textEncoder = new TextEncoder()
const PAYLOAD_AGENT_CONFIG_PATH = 'payload/agent-config.json'

export interface BuildAgentConfigPackResult {
  zip: Uint8Array
  manifest: ErratapackManifest
  jsonForm: ErratapackJson
}

export interface UnwrappedAgentConfigPack {
  manifest: ErratapackManifest
  contentKind: 'agent-config'
  bundle: AgentConfigBundle
}

function payloadHashOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Assemble + validate an agent-config manifest from the caller half + derived facets. */
function buildAgentConfigManifest(
  input: PackManifestInput,
  bundle: AgentConfigBundle,
  payloadHash: string,
): ErratapackManifest {
  const summary = summarizeAgentConfig(bundle)
  const capabilities = ['agent-config', ...(summary.hasScripts ? ['scripts'] : [])]
  const candidate: ErratapackManifest = {
    errataPack: 1,
    id: input.id,
    version: input.version,
    title: input.title,
    description: input.description,
    license: input.license,
    contentKind: 'agent-config',
    errataFormatVersion: bundle.version,
    fragmentTypes: [],
    fragmentCount: 0,
    tags: input.tags ?? [],
    nsfw: input.nsfw ?? false,
    ...(input.readme ? { readme: input.readme } : {}),
    ...(input.contentRating
      ? { contentRating: input.contentRating as ErratapackManifest['contentRating'] }
      : {}),
    ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
    agentConfig: summary,
    capabilities,
    dependencies: input.dependencies ?? [],
    payloadHash,
    ...(input.engines ? { engines: input.engines } : {}),
    ...(input.publisher ? { publisher: input.publisher } : {}),
    createdAt: new Date().toISOString(),
  }
  return ErratapackManifestSchema.parse(candidate)
}

/**
 * Build an agent-config pack from a portable bundle. Produces both a zip
 * (`payload/agent-config.json` + `manifest.json`) and a pure-JSON form for the
 * lightweight transport.
 */
export function buildAgentConfigPack(opts: {
  bundle: AgentConfigBundle
  manifestInput: PackManifestInput
}): BuildAgentConfigPackResult {
  const bundle = AgentConfigBundleSchema.parse(opts.bundle)

  const payloadBytes = textEncoder.encode(JSON.stringify(bundle, null, 2))
  const payloadHash = payloadHashOf(payloadBytes)
  const manifest = buildAgentConfigManifest(opts.manifestInput, bundle, payloadHash)

  const files: Record<string, Uint8Array> = {
    [PAYLOAD_AGENT_CONFIG_PATH]: payloadBytes,
    'manifest.json': textEncoder.encode(JSON.stringify(manifest, null, 2)),
  }
  const zip = zipSync(files)

  const jsonForm: ErratapackJson = { errataPack: 1, manifest, payload: bundle }
  return { zip, manifest, jsonForm }
}

/** Refuse a manifest whose capabilities aren't the agent-config allowlist. */
function assertAgentConfigManifest(manifest: ErratapackManifest): void {
  if (manifest.contentKind !== 'agent-config') {
    throw new Error(`Expected an agent-config pack, got "${manifest.contentKind}".`)
  }
  const allowed = new Set<string>(KNOWN_CAPABILITIES)
  const unknown = manifest.capabilities.filter((c) => !allowed.has(c))
  if (unknown.length > 0) {
    throw new Error(`Refusing pack: unsupported capabilities [${unknown.join(', ')}].`)
  }
}

/** Read + validate an agent-config pack from zip bytes or the pure-JSON form. */
export function unwrapAgentConfigPack(zipBytes: Uint8Array): UnwrappedAgentConfigPack {
  const jsonForm = tryParseJsonForm(zipBytes)
  if (jsonForm) return jsonForm

  const extracted = unzipSync(zipBytes)
  const manifestBytes = extracted['manifest.json']
  if (!manifestBytes) throw new Error('Invalid pack: missing manifest.json')
  const manifest = ErratapackManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)))
  assertAgentConfigManifest(manifest)

  const payloadBytes = extracted[PAYLOAD_AGENT_CONFIG_PATH]
  if (!payloadBytes) throw new Error(`Invalid agent-config pack: missing ${PAYLOAD_AGENT_CONFIG_PATH}`)
  const bundle = AgentConfigBundleSchema.parse(JSON.parse(strFromU8(payloadBytes)))

  return { manifest, contentKind: 'agent-config', bundle }
}

function tryParseJsonForm(zipBytes: Uint8Array): UnwrappedAgentConfigPack | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(zipBytes))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !('errataPack' in parsed)) return null

  const obj = parsed as { manifest?: unknown; payload?: unknown }
  const manifest = ErratapackManifestSchema.parse(obj.manifest)
  assertAgentConfigManifest(manifest)
  const bundle = AgentConfigBundleSchema.parse(obj.payload)
  return { manifest, contentKind: 'agent-config', bundle }
}

/** Re-export for callers that gate UI on the executable surface. */
export { bundleHasScripts }
