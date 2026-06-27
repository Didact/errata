# Changelog

All notable changes to Errata are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are git tags.

## [1.10.0] — 2026-06-26

### Added
- **Share agent configs as erratapacks.** A new `agent-config` erratapack kind
  lets writers publish and install agent presets through erratanet, on a
  scripts-with-consent trust model. Adds a share dialog, import view, config
  selector, and `PackLink`; server-side bundle/pack builders, a preset store,
  and config routes. The pack schema mirrors the erratanet contract verbatim.
- **Prose image headers** with configurable aspect ratios and an edge fade.

### Changed
- **Hardened the generation pipeline** against data loss and races, tightened
  token-usage tracking, and stopped the prewriter from handing the writer a
  doubled brief.
- Removed the superseded model-specific instruction-override layer (registry
  defaults retained); per-agent blocks replace it.

## [1.9.0] — 2026-06-05

### Added
- **Summaries are now fragments.** Librarian summaries moved out of loose fields
  (`story.summary`, `analysis.summaryUpdate`, `fragment.meta._librarian.summary`)
  into a first-class `summary` fragment type (`sm-` prefix). Summaries are now
  editable, taggable, versionable, reorderable, and referenceable via
  `ctx.getFragment`. See `docs/summary-fragments-plan.md`.
  - Per-chapter summary fragments with overflow → era-summary compaction.
  - One-shot migration from `story.summary` on story load (idempotent).
  - `hiddenFromList` registry flag keeps summaries out of the fragment list by default.
- **Dedicated Summaries tab** with a fullscreen editor, plus a Summaries section
  in the librarian panel.
- **CodeMirror script editor** for context blocks — fullscreen view and `ctx`
  autocompletion (`ScriptEditor.tsx`, `ScriptEditor.completions.ts`).
- **Per-agent context config** export/import, with confirm-on-import for replacements.
- Prose: always-visible chapter-marker divider, jump-to-latest control in the
  outline sidebar, and a color picker for dialogue / narration / emphasis.
- New UI primitives: wizard, panel, file-drop dialog, async-state view, and
  semantic prose-text components.
- Agent activity wisps with rotating verbs and accessibility improvements.
- `.impeccable.md` design context and `.github/copilot-instructions.md`.

### Changed
- **Replaced the legacy Block Editor** with per-agent block configuration.
- Rewrote the new-story wizard on the new UI primitives.
- Reorganized generation controls and librarian analysis settings.
- Auto-resizing textareas for librarian and character chat input.
- Backend simplification sweep (PRs #22–#30): `withStory` route wrapper,
  inlined `createToolAgent` / writer agent / `renderBlock`, deduped
  capitalize/pluralize helpers, consolidated plugin-hook runners.

### Fixed
- Prevent context blocks leaking between the prewriter and writer agents.
- Handle `null` temperature in provider config.
- Pass writer temperature through to the model; apply writer prompt overrides.
- Register core agents before creating default blocks.
- Pass created fragment type to cache invalidation so the list updates on creation.
- Writer agent uses the writer-brief prompt in prewriter mode.

### Removed
- Legacy `BlockEditorPanel` and `BlockPreviewDialog`.
- `story.summary` writers and the `_librarian.summary` meta cache.
- Dead modules: `create-agent.ts`, `writer-agent.ts`, `blocks/storage.ts`.

### Notes
- `package.json` was never bumped for 1.8.0 (stayed at 1.7.0); corrected to 1.9.0 here.
- The `summary` fragment type bumps the fragment schema version. Migration runs on
  story load — verify against real `data/` stories before tagging.

## [1.8.0] — 2026-03-04

- Librarian: settings to disable directions/suggestions, dismiss suggestions,
  and delete analyses.

## [1.7.0] — 2026-02-20

## [1.6.0] — 2026-02-19
