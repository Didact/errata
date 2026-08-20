import { z } from 'zod/v4'

/**
 * Story presets: a named, saved bundle of non-prose fragments (characters,
 * guidelines, knowledge) that lives outside any single story and seeds a new
 * one on demand. See `docs/story-presets.md`.
 *
 * A preset is two files on disk (`src/server/presets/storage.ts`):
 *   data/presets/<presetId>/meta.json   — StoryPresetMeta, small, list-friendly
 *   data/presets/<presetId>/bundle.json — a FragmentBundleData payload
 *
 * The payload is stored as the exact same shape the export panel already
 * produces (`src/lib/fragment-clipboard.ts`), so import/export interop is
 * free: downloading a preset is just serving `bundle.json`, and importing one
 * accepts any Errata fragment-bundle or single-fragment export.
 */

/** Only these fragment types may ever enter a preset. Prose can't. */
export const PRESET_FRAGMENT_TYPES = ['character', 'guideline', 'knowledge'] as const
export type PresetFragmentType = (typeof PRESET_FRAGMENT_TYPES)[number]

export const PRESET_LIMITS = {
  /** Max top-level fragments a single preset may carry. */
  maxFragments: 500,
  /** Max serialized bundle size, bytes. 32 MiB (portraits are base64 data URLs). */
  maxBytes: 32 * 1024 * 1024,
  /** Max preset name length. */
  maxNameLength: 80,
} as const

export const PRESET_ID_REGEX = /^preset-[a-z0-9]+$/

export const StoryPresetMetaSchema = z.object({
  id: z.string().regex(PRESET_ID_REGEX),
  name: z.string().min(1).max(PRESET_LIMITS.maxNameLength),
  description: z.string().max(250).default(''),
  /** Name of the story this was saved from, for display only. */
  sourceStoryName: z.string().optional(),
  fragmentCount: z.int().min(0).default(0),
  countsByType: z.record(z.string(), z.int().min(0)).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type StoryPresetMeta = z.infer<typeof StoryPresetMetaSchema>
