# Story Presets

Story presets let you save a named, reusable bundle of non-prose fragments — characters,
guidelines, knowledge — outside any single story, and use it to seed a new one in a single
click.

## Overview

- Presets are story-independent. They live at `data/presets/<presetId>/`, alongside (not
  inside) `data/stories/`.
- Only `character`, `guideline`, and `knowledge` fragments may enter a preset. Prose,
  summaries, and markers can't — a preset is a starting point, not a saved story.
- Fragments are **copied, not shared**. Applying a preset installs fresh copies of its
  fragments into the target story via the same ref-aware batch importer used for erratanet
  hub packs (`installFragmentBundle`); editing a copy never touches the preset, and editing
  the preset never touches a story that was seeded from it.
- A preset payload is stored as a standard `FragmentBundleData` bundle (the same shape the
  fragment export panel already produces), so exporting a preset is just downloading
  `bundle.json`, and importing one accepts any Errata fragment-bundle or single-fragment
  export.
- Presets never carry context block configuration (`blockConfig` / `agentBlockConfigs`) —
  the same trust boundary already enforced on `POST /stories/:storyId/fragments/import-bundle`.

## Data Model

Preset metadata (`src/server/presets/schema.ts`):

```ts
interface StoryPresetMeta {
  id: string                          // preset-<random>
  name: string
  description: string
  sourceStoryName?: string            // name of the story it was saved from, display only
  fragmentCount: number
  countsByType: Record<string, number>
  createdAt: string
  updatedAt: string
}
```

Storage layout (`src/server/presets/storage.ts`):

```
data/presets/<presetId>/meta.json     # StoryPresetMeta — small, read to render the list
data/presets/<presetId>/bundle.json   # FragmentBundleData — the payload, read on apply/export
```

Splitting meta from payload means listing presets never parses the (potentially
multi-megabyte, base64-portrait-carrying) bundle. `PRESET_LIMITS` caps fragment count
(500) and serialized size (32 MiB); `sanitizePresetBundle` is the trust boundary, rejecting
block configuration, non-`character`/`guideline`/`knowledge` entries, and oversized bundles
before anything touches disk.

## API

All routes live in `src/server/routes/presets.ts`, tagged `Presets` in the OpenAPI doc.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/presets` | List presets, newest first |
| `GET` | `/api/presets/:presetId` | Get a preset's meta and full bundle |
| `POST` | `/api/presets` | Save a bundle as a new preset |
| `PATCH` | `/api/presets/:presetId` | Rename or redescribe a preset |
| `DELETE` | `/api/presets/:presetId` | Delete a preset |
| `POST` | `/api/presets/:presetId/apply` | Copy the preset's fragments into a story |

`apply` is server-side end to end: it reads the preset's `bundle.json` and calls
`installFragmentBundle(dataDir, storyId, bundle, { pack: preset.id, version: '0.0.0', kind:
'preset', presetName: preset.name })`. The `kind: 'preset'` provenance stamps
`meta.preset = { id, name, appliedAt }` on every installed fragment instead of
`meta.erratanet` — a preset copy is local content, not hub content, and must never be
mistaken for one by the erratanet update-check logic. Every other caller of
`installFragmentBundle` omits `kind`, which defaults to `'erratanet'` and is unaffected.

## UI

- **Save**: the fragment export panel (`src/components/fragments/FragmentExportPanel.tsx`,
  which already multi-selects exactly character/guideline/knowledge) gains a "Save as
  preset" button, opening `src/components/presets/SavePresetDialog.tsx`. Context
  configuration is never included, regardless of the panel's "Include context
  configuration" toggle.
- **Manage**: `src/components/presets/PresetManager.tsx` renders inside the global Settings
  dialog on the story list (`src/routes/index.tsx`) — rename, delete, download `.json`, or
  import a preset from a file.
- **Apply**: the New Story dialog gains a "Start from" picker (blank story or any preset,
  with fragment counts). Picking a preset and loading a one-off fragment bundle in the
  dialog's Options section are mutually exclusive, since both add fragments to the new
  story.

## Testing

- `tests/presets/storage.test.ts` — sanitization rules and the create/list/get/rename/delete
  round-trip.
- `tests/api/preset-routes.test.ts` — every endpoint, including 404s and the 422 refusals.
- `tests/presets/apply.test.ts` — the "copied, not shared" contract: refs re-wired between
  copies, portraits recreated, `meta.preset` stamped instead of `meta.erratanet`, and
  editing an installed copy never mutates the preset's stored bundle.
- `tests/erratanet/install.test.ts` — confirms `installFragmentBundle`'s `kind: 'preset'`
  branch, alongside its existing default-provenance coverage.
