import { createHash } from 'node:crypto'
import { zipSync, unzipSync } from 'fflate'
import {
  ErratapackManifestSchema,
  PACK_LIMITS,
  ASSET_URI_PREFIX,
  type ErratapackManifest,
  type ErratapackJson,
  type ContentKind,
} from '@/lib/erratanet/pack-schema'
import type { FragmentBundleData } from '@/lib/fragment-clipboard'
import { exportStoryAsZip } from '../story-archive'

/**
 * erratapack build pipeline (server only). Turns an Errata fragment bundle or a
 * full story export into a distributable `.erratapack` zip + manifest.
 *
 * Trust model (MVP): a pack carries fragments + assets ONLY. `blockConfig` and
 * `agentBlockConfigs` are refused at build time, and `capabilities` is always
 * empty. See `isManifestSafeForMvp` in pack-schema for the install-side gate.
 */

// --- Manifest input ---

/**
 * The caller-supplied half of a manifest. The build derives the rest
 * (`contentKind`, `fragmentTypes`, `fragmentCount`, `errataFormatVersion`,
 * `payloadHash`, `capabilities`, `createdAt`, `errataPack`).
 */
export interface PackManifestInput {
  id: string
  version: string
  title: string
  description: string
  license: string
  tags?: string[]
  nsfw?: boolean
  readme?: string
  contentRating?: string
  chapters?: { title: string; order?: number }[]
  thumbnail?: string
  dependencies?: ErratapackManifest['dependencies']
  engines?: ErratapackManifest['engines']
  publisher?: string
}

export interface BuildFragmentPackResult {
  zip: Uint8Array
  manifest: ErratapackManifest
  jsonForm: ErratapackJson
}

export interface BuildStoryPackResult {
  zip: Uint8Array
  manifest: ErratapackManifest
}

const textEncoder = new TextEncoder()

// --- Hash helpers ---

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Algorithm-prefixed integrity hash for the manifest `payloadHash` field. */
function payloadHashOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`
}

// --- Asset decoding ---

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

interface DecodedAsset {
  bytes: Uint8Array
  mime: string | null
  ext: string
}

/**
 * Decode an attachment `content` value into raw bytes. Accepts a
 * `data:<mime>;base64,<...>` data URL or a bare base64 string. The extension is
 * derived from the data URL mime when present, otherwise falls back by kind.
 */
function decodeAttachmentContent(content: string, kind: 'image' | 'icon'): DecodedAsset {
  let mime: string | null = null
  let base64 = content

  const dataUrlMatch = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(content)
  if (dataUrlMatch) {
    mime = dataUrlMatch[1] || null
    base64 = dataUrlMatch[3] ?? ''
  }

  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))

  let ext: string
  if (mime && MIME_EXT[mime]) {
    ext = MIME_EXT[mime]
  } else {
    ext = kind === 'icon' ? 'png' : 'png'
  }

  return { bytes, mime, ext }
}

/** Re-encode raw asset bytes back into a data URL for the inline JSON form. */
function bytesToDataUrl(bytes: Uint8Array, mime: string | null, ext: string): string {
  const resolvedMime = mime ?? extToMime(ext)
  return `data:${resolvedMime};base64,${Buffer.from(bytes).toString('base64')}`
}

function extToMime(ext: string): string {
  for (const [mime, e] of Object.entries(MIME_EXT)) {
    if (e === ext) return mime
  }
  return 'application/octet-stream'
}

// --- Bundle parsing ---

function parseBundle(bundleJson: string | FragmentBundleData): FragmentBundleData {
  const bundle: unknown =
    typeof bundleJson === 'string' ? JSON.parse(bundleJson) : bundleJson

  if (
    !bundle ||
    typeof bundle !== 'object' ||
    (bundle as FragmentBundleData)._errata !== 'fragment-bundle'
  ) {
    throw new Error('Invalid fragment bundle: expected an _errata "fragment-bundle" document')
  }

  const typed = bundle as FragmentBundleData
  if (!Array.isArray(typed.fragments)) {
    throw new Error('Invalid fragment bundle: missing fragments array')
  }
  return typed
}

// --- Fragment pack ---

/**
 * Build a fragment pack from an Errata fragment bundle. Extracts every
 * attachment into a content-addressed `assets/<sha256>.<ext>` entry, rewrites
 * each attachment's `content` to an `asset://<sha256>` uri, derives the
 * manifest, and produces both the zip and a pure-JSON form (for tiny packs).
 */
export function buildFragmentPack(opts: {
  bundleJson: string | FragmentBundleData
  manifestInput: PackManifestInput
}): BuildFragmentPackResult {
  const bundle = parseBundle(opts.bundleJson)

  // Trust gate: MVP packs are fragments + assets only.
  if (bundle.blockConfig) {
    throw new Error('Refusing to pack: bundle carries a blockConfig (not allowed in MVP packs)')
  }
  if (bundle.agentBlockConfigs && Object.keys(bundle.agentBlockConfigs).length > 0) {
    throw new Error('Refusing to pack: bundle carries agentBlockConfigs (not allowed in MVP packs)')
  }

  if (bundle.fragments.length > PACK_LIMITS.maxFragments) {
    throw new Error(
      `Pack exceeds fragment limit: ${bundle.fragments.length} > ${PACK_LIMITS.maxFragments}`,
    )
  }

  // assets keyed by hash so identical attachments dedupe.
  const assets = new Map<string, { ext: string; bytes: Uint8Array; mime: string | null }>()

  // Deep-clone the bundle so we never mutate the caller's input, then rewrite
  // attachment content to asset uris in the clone.
  const strippedBundle: FragmentBundleData = {
    ...bundle,
    fragments: bundle.fragments.map((entry) => {
      if (!entry.attachments || entry.attachments.length === 0) {
        return { ...entry }
      }
      const attachments = entry.attachments.map((att) => {
        const decoded = decodeAttachmentContent(att.content, att.kind)
        if (decoded.bytes.byteLength > PACK_LIMITS.maxAssetBytes) {
          throw new Error(
            `Asset "${att.name}" exceeds size limit: ${decoded.bytes.byteLength} > ${PACK_LIMITS.maxAssetBytes}`,
          )
        }
        const hash = sha256Hex(decoded.bytes)
        if (!assets.has(hash)) {
          assets.set(hash, { ext: decoded.ext, bytes: decoded.bytes, mime: decoded.mime })
        }
        return {
          kind: att.kind,
          name: att.name,
          description: att.description,
          content: `${ASSET_URI_PREFIX}${hash}`,
          ...(att.boundary ? { boundary: att.boundary } : {}),
        }
      })
      return { ...entry, attachments }
    }),
  }
  // blockConfig / agentBlockConfigs are guaranteed absent by the trust gate above.
  delete strippedBundle.blockConfig
  delete strippedBundle.agentBlockConfigs

  // Derive manifest facets from the (stripped) bundle.
  const fragmentTypes = Array.from(new Set(strippedBundle.fragments.map((f) => f.type)))
  const fragmentCount = strippedBundle.fragments.length

  const strippedBundleBytes = textEncoder.encode(JSON.stringify(strippedBundle, null, 2))

  // Build the zip file map. Assets are content-addressed under assets/.
  const files: Record<string, Uint8Array> = {}
  files['payload/bundle.json'] = strippedBundleBytes
  const assetsInline: Record<string, string> = {}
  for (const [hash, asset] of assets) {
    files[`assets/${hash}.${asset.ext}`] = asset.bytes
    assetsInline[`${ASSET_URI_PREFIX}${hash}`] = bytesToDataUrl(asset.bytes, asset.mime, asset.ext)
  }

  // Enforce total payload size (payload + assets, decompressed).
  let totalPayloadBytes = strippedBundleBytes.byteLength
  for (const asset of assets.values()) {
    totalPayloadBytes += asset.bytes.byteLength
  }
  if (totalPayloadBytes > PACK_LIMITS.maxPayloadBytes) {
    throw new Error(
      `Pack exceeds payload limit: ${totalPayloadBytes} > ${PACK_LIMITS.maxPayloadBytes}`,
    )
  }

  // payloadHash covers the canonical payload + every asset's bytes (sorted by
  // hash so the digest is order-independent).
  const payloadHash = hashPayloadAndAssets(strippedBundleBytes, assets)

  const manifest = buildManifest({
    input: opts.manifestInput,
    contentKind: 'fragment-pack',
    errataFormatVersion: strippedBundle.version,
    fragmentTypes,
    fragmentCount,
    payloadHash,
  })

  files['manifest.json'] = textEncoder.encode(JSON.stringify(manifest, null, 2))

  const zip = zipSync(files)

  const jsonForm: ErratapackJson = {
    errataPack: 1,
    manifest,
    payload: strippedBundle,
    ...(Object.keys(assetsInline).length > 0 ? { assetsInline } : {}),
  }

  return { zip, manifest, jsonForm }
}

/** Digest of the payload bytes followed by each asset's bytes, sorted by hash. */
function hashPayloadAndAssets(
  payloadBytes: Uint8Array,
  assets: Map<string, { bytes: Uint8Array }>,
): string {
  const hasher = createHash('sha256')
  hasher.update(payloadBytes)
  for (const hash of Array.from(assets.keys()).sort()) {
    hasher.update(hash)
    hasher.update(assets.get(hash)!.bytes)
  }
  return `sha256:${hasher.digest('hex')}`
}

// --- Story pack ---

/**
 * Build a story pack by wrapping the existing story-archive export. The story
 * archive is unzipped and re-zipped under `payload/story/<...>` with a manifest
 * added. Story images stay base64 inline inside the archive (no asset
 * extraction for stories), so `payloadHash` covers the archive bytes.
 */
export async function buildStoryPack(
  dataDir: string,
  storyId: string,
  manifestInput: PackManifestInput,
): Promise<BuildStoryPackResult> {
  const { buffer: storyArchive } = await exportStoryAsZip(dataDir, storyId)

  const innerEntries = unzipSync(storyArchive)

  const files: Record<string, Uint8Array> = {}
  let totalPayloadBytes = 0
  let fragmentCount = 0
  const fragmentTypes = new Set<string>()
  const decoder = new TextDecoder()

  for (const [path, bytes] of Object.entries(innerEntries)) {
    files[`payload/story/${path}`] = bytes
    totalPayloadBytes += bytes.byteLength

    // Count fragment entries + collect their types for discovery metadata.
    if (path.includes('/fragments/') && path.endsWith('.json')) {
      try {
        const fragment = JSON.parse(decoder.decode(bytes)) as { type?: string }
        fragmentCount++
        if (typeof fragment.type === 'string') fragmentTypes.add(fragment.type)
      } catch {
        // Ignore unparseable entries for metadata purposes.
      }
    }
  }

  if (fragmentCount > PACK_LIMITS.maxFragments) {
    throw new Error(
      `Pack exceeds fragment limit: ${fragmentCount} > ${PACK_LIMITS.maxFragments}`,
    )
  }
  if (totalPayloadBytes > PACK_LIMITS.maxPayloadBytes) {
    throw new Error(
      `Pack exceeds payload limit: ${totalPayloadBytes} > ${PACK_LIMITS.maxPayloadBytes}`,
    )
  }

  const payloadHash = payloadHashOf(storyArchive)

  const manifest = buildManifest({
    input: manifestInput,
    contentKind: 'story',
    // Stories carry their own internal format; surface bundle format version 1.
    errataFormatVersion: 1,
    fragmentTypes: Array.from(fragmentTypes),
    fragmentCount,
    payloadHash,
  })

  files['manifest.json'] = textEncoder.encode(JSON.stringify(manifest, null, 2))

  const zip = zipSync(files)
  return { zip, manifest }
}

// --- Manifest assembly ---

function buildManifest(args: {
  input: PackManifestInput
  contentKind: ContentKind
  errataFormatVersion: number
  fragmentTypes: string[]
  fragmentCount: number
  payloadHash: string
}): ErratapackManifest {
  const { input } = args
  const candidate: ErratapackManifest = {
    errataPack: 1,
    id: input.id,
    version: input.version,
    title: input.title,
    description: input.description,
    license: input.license,
    contentKind: args.contentKind,
    errataFormatVersion: args.errataFormatVersion,
    fragmentTypes: args.fragmentTypes,
    fragmentCount: args.fragmentCount,
    tags: input.tags ?? [],
    nsfw: input.nsfw ?? false,
    ...(input.readme ? { readme: input.readme } : {}),
    ...(input.contentRating
      ? { contentRating: input.contentRating as ErratapackManifest['contentRating'] }
      : {}),
    ...(input.chapters ? { chapters: input.chapters } : {}),
    ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
    capabilities: [],
    dependencies: input.dependencies ?? [],
    payloadHash: args.payloadHash,
    ...(input.engines ? { engines: input.engines } : {}),
    ...(input.publisher ? { publisher: input.publisher } : {}),
    createdAt: new Date().toISOString(),
  }

  // Validate (and normalize defaults) through the shared schema.
  return ErratapackManifestSchema.parse(candidate)
}
