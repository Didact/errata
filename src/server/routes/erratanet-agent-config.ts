import { Elysia, t } from 'elysia'
import {
  publishVersion as hubPublishVersion,
  downloadPack as hubDownloadPack,
} from '../erratanet/hub-client'
import { manifestRequiresConsent } from '@/lib/erratanet/pack-schema'
import type { AgentConfigInclude } from '@/lib/erratanet/pack-schema'
import {
  snapshotAgentConfig,
  summarizeAgentConfig,
  buildAgentConfigPreview,
  applyAgentConfigToStory,
  filterAgentConfigBundle,
  bundleHasScripts,
  AgentConfigSelectionSchema,
} from '../erratanet/agent-config-bundle'
import { buildAgentConfigPack, unwrapAgentConfigPack } from '../erratanet/agent-config-pack'
import {
  listAgentPresets,
  getAgentPreset,
  saveAgentPreset,
  deleteAgentPreset,
} from '../erratanet/agent-preset-store'
import type { PackManifestInput } from '../erratanet/pack-build'
import { getStory, updateStory } from '../fragments/storage'

/** Normalize an unknown error into a message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Could not reach the hub.'
}

/** Caller half of an agent-config manifest (the build derives the rest). */
const manifestBody = t.Object({
  id: t.String(),
  version: t.String(),
  title: t.String(),
  description: t.String(),
  license: t.String(),
  tags: t.Optional(t.Array(t.String())),
  nsfw: t.Optional(t.Boolean()),
  readme: t.Optional(t.String()),
  contentRating: t.Optional(t.String()),
  thumbnail: t.Optional(t.String()),
  publisher: t.Optional(t.String()),
})

const includesBody = t.Optional(t.Array(t.String()))

/**
 * Routes for the `agent-config` pack kind: snapshot the current story's config,
 * publish it as a pack, inspect a remote pack before installing, and apply it to
 * a story and/or save it as a reusable preset. Mounted alongside `erratanetRoutes`.
 */
export function erratanetAgentConfigRoutes(dataDir: string) {
  return new Elysia({ detail: { tags: ['Erratanet Agent Config'] } })
    // Snapshot the current story's config for the publish dialog to preview.
    .post('/erratanet/agent-config/snapshot', async ({ body, set }) => {
      const story = await getStory(dataDir, body.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found.' }
      }
      const bundle = await snapshotAgentConfig(
        dataDir,
        body.storyId,
        body.includes as AgentConfigInclude[] | undefined,
      )
      return { bundle, summary: summarizeAgentConfig(bundle), preview: buildAgentConfigPreview(bundle) }
    }, {
      detail: { summary: 'Snapshot a story agent config into a portable bundle' },
      body: t.Object({ storyId: t.String(), includes: includesBody }),
    })

    // Build an agent-config pack from the story snapshot and publish a version.
    .post('/erratanet/agent-config/publish', async ({ body, set }) => {
      const story = await getStory(dataDir, body.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found.' }
      }
      const manifestInput: PackManifestInput = {
        id: body.manifest.id,
        version: body.manifest.version,
        title: body.manifest.title,
        description: body.manifest.description,
        license: body.manifest.license,
        ...(body.manifest.tags ? { tags: body.manifest.tags } : {}),
        ...(body.manifest.nsfw !== undefined ? { nsfw: body.manifest.nsfw } : {}),
        ...(body.manifest.readme ? { readme: body.manifest.readme } : {}),
        ...(body.manifest.contentRating ? { contentRating: body.manifest.contentRating } : {}),
        ...(body.manifest.thumbnail ? { thumbnail: body.manifest.thumbnail } : {}),
        ...(body.manifest.publisher ? { publisher: body.manifest.publisher } : {}),
      }
      try {
        // A `selection` narrows the snapshot to specific agents/blocks/items;
        // otherwise fall back to the surface-level `includes` (or everything).
        const bundle = body.selection
          ? filterAgentConfigBundle(
              await snapshotAgentConfig(dataDir, body.storyId),
              AgentConfigSelectionSchema.parse(body.selection),
            )
          : await snapshotAgentConfig(dataDir, body.storyId, body.includes as AgentConfigInclude[] | undefined)
        const summary = summarizeAgentConfig(bundle)
        if (summary.includes.length === 0) {
          set.status = 422
          return { error: 'Nothing to publish: select at least one part of the configuration.' }
        }
        const built = buildAgentConfigPack({ bundle, manifestInput })
        const result = await hubPublishVersion(dataDir, built.manifest.id, built.manifest, built.zip, {
          unlisted: body.unlisted ?? false,
        })
        // Stamp the story so the panel can list this config and re-sync it later.
        await stampStoryAgentConfig(dataDir, body.storyId, {
          pack: result.id,
          version: result.version,
          includes: summary.includes,
        })
        return { id: result.id, version: result.version }
      } catch (e) {
        set.status = 422
        return { error: errorMessage(e) }
      }
    }, {
      detail: { summary: 'Publish an agent-config pack from a story snapshot' },
      body: t.Object({
        storyId: t.String(),
        includes: includesBody,
        selection: t.Optional(t.Unknown()),
        unlisted: t.Optional(t.Boolean()),
        manifest: manifestBody,
      }),
    })

    // Download + unwrap a remote agent-config pack and return a structured
    // preview (incl. script source) WITHOUT applying anything.
    .post('/erratanet/agent-config/inspect', async ({ body, set }) => {
      try {
        const archive = await hubDownloadPack(dataDir, body.id, body.version)
        const { manifest, bundle } = unwrapAgentConfigPack(new Uint8Array(archive))
        return {
          manifest,
          summary: manifest.agentConfig ?? summarizeAgentConfig(bundle),
          preview: buildAgentConfigPreview(bundle),
          requiresConsent: manifestRequiresConsent(manifest),
        }
      } catch (e) {
        set.status = 502
        return { error: errorMessage(e) }
      }
    }, {
      detail: { summary: 'Inspect a remote agent-config pack before installing' },
      body: t.Object({ id: t.String(), version: t.Optional(t.String()) }),
    })

    // Apply a remote pack: to a story, and/or save it as a reusable preset.
    .post('/erratanet/agent-config/apply', async ({ body, set }) => {
      if (!body.applyToStoryId && !body.savePreset) {
        set.status = 422
        return { error: 'Choose to apply to a story, save as a preset, or both.' }
      }
      try {
        const archive = await hubDownloadPack(dataDir, body.id, body.version)
        const { manifest, bundle: fullBundle } = unwrapAgentConfigPack(new Uint8Array(archive))
        // A `selection` narrows what actually gets applied / saved.
        const bundle = body.selection
          ? filterAgentConfigBundle(fullBundle, AgentConfigSelectionSchema.parse(body.selection))
          : fullBundle
        // Consent is gated on what's actually being applied: deselecting the
        // script blocks drops the requirement.
        const requiresConsent = bundleHasScripts(bundle)

        let applied: Awaited<ReturnType<typeof applyAgentConfigToStory>> | undefined
        if (body.applyToStoryId) {
          if (requiresConsent && !body.consentToScripts) {
            set.status = 422
            return { error: 'This configuration runs code; consent is required to apply it.', requiresConsent: true }
          }
          applied = await applyAgentConfigToStory(dataDir, body.applyToStoryId, bundle, {
            consentToScripts: body.consentToScripts,
          })
        }

        let presetId: string | undefined
        if (body.savePreset) {
          const preset = await saveAgentPreset(dataDir, {
            name: body.savePreset.name,
            bundle,
            source: { pack: manifest.id, version: manifest.version },
          })
          presetId = preset.id
        }

        return { applied, presetId }
      } catch (e) {
        set.status = 422
        return { error: errorMessage(e) }
      }
    }, {
      detail: { summary: 'Apply a remote agent-config pack to a story and/or save a preset' },
      body: t.Object({
        id: t.String(),
        version: t.Optional(t.String()),
        selection: t.Optional(t.Unknown()),
        consentToScripts: t.Optional(t.Boolean()),
        applyToStoryId: t.Optional(t.String()),
        savePreset: t.Optional(t.Object({ name: t.String() })),
      }),
    })

    // --- Presets (global, story-independent) ---

    .get('/erratanet/agent-presets', async () => {
      return { presets: await listAgentPresets(dataDir) }
    }, { detail: { summary: 'List saved agent-config presets' } })

    .get('/erratanet/agent-presets/:id', async ({ params, set }) => {
      const preset = await getAgentPreset(dataDir, params.id)
      if (!preset) {
        set.status = 404
        return { error: 'Preset not found.' }
      }
      return {
        preset: { id: preset.id, name: preset.name, createdAt: preset.createdAt, source: preset.source, summary: preset.summary },
        preview: buildAgentConfigPreview(preset.bundle),
        requiresConsent: preset.summary.hasScripts,
      }
    }, { detail: { summary: 'Get a preset with its inspectable preview' } })

    // Save a preset from the current story snapshot (or a supplied bundle).
    .post('/erratanet/agent-presets', async ({ body, set }) => {
      try {
        const bundle = body.bundle
          ? body.bundle
          : body.fromStoryId
            ? await snapshotAgentConfig(dataDir, body.fromStoryId, body.includes as AgentConfigInclude[] | undefined)
            : null
        if (!bundle) {
          set.status = 422
          return { error: 'Provide fromStoryId or a bundle to save a preset.' }
        }
        const preset = await saveAgentPreset(dataDir, { name: body.name, bundle: bundle as never })
        return { id: preset.id, name: preset.name, summary: preset.summary }
      } catch (e) {
        set.status = 422
        return { error: errorMessage(e) }
      }
    }, {
      detail: { summary: 'Save an agent-config preset' },
      body: t.Object({
        name: t.String(),
        fromStoryId: t.Optional(t.String()),
        includes: includesBody,
        bundle: t.Optional(t.Unknown()),
      }),
    })

    .delete('/erratanet/agent-presets/:id', async ({ params, set }) => {
      const ok = await deleteAgentPreset(dataDir, params.id)
      if (!ok) {
        set.status = 404
        return { error: 'Preset not found.' }
      }
      return { ok: true }
    }, { detail: { summary: 'Delete a preset' } })

    // Apply a saved preset to a story.
    .post('/erratanet/agent-presets/:id/apply', async ({ params, body, set }) => {
      const preset = await getAgentPreset(dataDir, params.id)
      if (!preset) {
        set.status = 404
        return { error: 'Preset not found.' }
      }
      try {
        if (preset.summary.hasScripts && !body.consentToScripts) {
          set.status = 422
          return { error: 'This preset runs code; consent is required to apply it.', requiresConsent: true }
        }
        const applied = await applyAgentConfigToStory(dataDir, body.storyId, preset.bundle, {
          consentToScripts: body.consentToScripts,
        })
        return { applied }
      } catch (e) {
        set.status = 422
        return { error: errorMessage(e) }
      }
    }, {
      detail: { summary: 'Apply a saved preset to a story' },
      body: t.Object({ storyId: t.String(), consentToScripts: t.Optional(t.Boolean()) }),
    })
}

type StoryAgentConfig = { pack: string; version: string; includes: string[] }

/**
 * Record an agent-config pack shared from a story, deduped by pack id (its slot
 * is updated in place). Mirrors how fragment packs are stamped, so the panel can
 * list shared configs and offer a re-sync.
 */
async function stampStoryAgentConfig(
  dataDir: string,
  storyId: string,
  entry: StoryAgentConfig,
): Promise<void> {
  const story = await getStory(dataDir, storyId)
  if (!story) return
  const existing = (story.settings.erratanet ?? {}) as Record<string, unknown>
  const prior = Array.isArray(existing.agentConfigs)
    ? (existing.agentConfigs as StoryAgentConfig[])
    : []
  const idx = prior.findIndex((c) => c.pack === entry.pack)
  const agentConfigs = idx >= 0 ? prior.map((c, i) => (i === idx ? entry : c)) : [...prior, entry]
  await updateStory(dataDir, {
    ...story,
    settings: { ...story.settings, erratanet: { ...existing, agentConfigs } },
  })
}
