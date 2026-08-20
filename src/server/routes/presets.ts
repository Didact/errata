import { Elysia, t } from 'elysia'
import {
  listPresets,
  getPreset,
  createPreset,
  updatePresetMeta,
  deletePreset,
  InvalidPresetBundleError,
} from '../presets/storage'
import { getStory } from '../fragments/storage'
import { installFragmentBundle } from '../erratanet/pack-install'
import { createLogger } from '../logging'

export function presetRoutes(dataDir: string) {
  const logger = createLogger('api:presets', { dataDir })

  return new Elysia({ detail: { tags: ['Presets'] } })
    .get('/presets', async () => {
      return { presets: await listPresets(dataDir) }
    }, { detail: { summary: 'List story presets' } })

    .get('/presets/:presetId', async ({ params, set }) => {
      const preset = await getPreset(dataDir, params.presetId)
      if (!preset) {
        set.status = 404
        return { error: 'Preset not found' }
      }
      return preset
    }, { detail: { summary: 'Get a preset and its fragment bundle' } })

    .post('/presets', async ({ body, set }) => {
      try {
        const meta = await createPreset(dataDir, {
          name: body.name,
          description: body.description,
          sourceStoryName: body.sourceStoryName,
          bundle: body.bundle,
        })
        return meta
      } catch (err) {
        if (err instanceof InvalidPresetBundleError) {
          set.status = 422
          return { error: err.message }
        }
        logger.error('Failed to create preset', { err })
        throw err
      }
    }, {
      detail: { summary: 'Save a fragment bundle as a named preset' },
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        sourceStoryName: t.Optional(t.String()),
        bundle: t.Record(t.String(), t.Unknown()),
      }),
    })

    .patch('/presets/:presetId', async ({ params, body, set }) => {
      const meta = await updatePresetMeta(dataDir, params.presetId, body)
      if (!meta) {
        set.status = 404
        return { error: 'Preset not found' }
      }
      return meta
    }, {
      detail: { summary: 'Rename or redescribe a preset' },
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
      }),
    })

    .delete('/presets/:presetId', async ({ params, set }) => {
      const ok = await deletePreset(dataDir, params.presetId)
      if (!ok) {
        set.status = 404
        return { error: 'Preset not found' }
      }
      return { ok: true }
    }, { detail: { summary: 'Delete a preset' } })

    // Copies the preset's fragments into an existing (typically just-created)
    // story. Fresh ids throughout — the preset itself is never touched, and
    // the story ends up fully independent of it. See installFragmentBundle.
    .post('/presets/:presetId/apply', async ({ params, body, set }) => {
      const preset = await getPreset(dataDir, params.presetId)
      if (!preset) {
        set.status = 404
        return { error: 'Preset not found' }
      }
      const story = await getStory(dataDir, body.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const fragments = await installFragmentBundle(dataDir, body.storyId, preset.bundle, {
        pack: preset.meta.id,
        version: '0.0.0',
        kind: 'preset',
        presetName: preset.meta.name,
      })
      return { fragments, count: fragments.length }
    }, {
      detail: { summary: 'Apply a preset into a story, copying fresh fragments' },
      body: t.Object({
        storyId: t.String(),
      }),
    })
}
