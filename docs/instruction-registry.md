# Instruction Registry

## Overview

The instruction registry provides centralized management of all LLM prompt instructions. Instead of hardcoding system prompts in agent modules, each instruction is registered under a dot-separated key and resolved at runtime.

> **Removed:** the model-specific override layer (`data/instruction-sets/*.json`, `modelMatch`, `loadOverridesSync`, `InstructionSetSchema`) no longer exists. Per-agent block configuration (the Agent Context panel) supersedes it — customize prompts there instead. Leftover files in `data/instruction-sets/` are ignored, and the server logs a startup warning when it finds any.

## API

The singleton `instructionRegistry` is exported from `src/server/instructions/index.ts`.

| Method | Signature | Description |
|---|---|---|
| `registerDefault` | `(key: string, text: string) => void` | Register the default text for an instruction key. Called at module init. |
| `resolve` | `(key: string, modelId?: string) => string` | Return the registered default. The `modelId` parameter is accepted for call-site compatibility but ignored. Throws if key is unregistered. |
| `getDefault` | `(key: string) => string \| undefined` | Return the default text, or undefined for unknown keys. |
| `listKeys` | `() => string[]` | List all registered instruction keys. |
| `clear` | `() => void` | Reset all defaults. Used in tests. |

## Registered Instruction Keys

All 19 keys grouped by module:

### Generation (5)

| Key | Registered in | Description |
|---|---|---|
| `generation.system` | `src/server/llm/agents.ts` | Main writer system prompt |
| `generation.tools-suffix` | `src/server/llm/agents.ts` | Appended after tool descriptions in writer context |
| `generation.writer-brief.system` | `src/server/llm/agents.ts` | Writer system prompt when receiving a prewriter brief |
| `generation.writer-brief.tools-suffix` | `src/server/llm/agents.ts` | Tool suffix for brief-mode writer |
| `generation.prewriter.system` | `src/server/llm/agents.ts` | Prewriter agent system prompt |

### Librarian (6)

| Key | Registered in | Description |
|---|---|---|
| `librarian.analyze.system` | `src/server/librarian/agents.ts` | Background analysis system prompt |
| `librarian.chat.system` | `src/server/librarian/agents.ts` | Interactive librarian chat system prompt |
| `librarian.refine.system` | `src/server/librarian/agents.ts` | Fragment refinement system prompt |
| `librarian.optimize-character.system` | `src/server/librarian/agents.ts` | Character optimization system prompt (depth methodology) |
| `librarian.prose-transform.system` | `src/server/librarian/agents.ts` | Prose selection transform system prompt |
| `librarian.summary-compaction` | `src/server/librarian/agents.ts` | Summary compaction prompt template |

### Character Chat (5)

| Key | Registered in | Description |
|---|---|---|
| `character-chat.system` | `src/server/character-chat/agents.ts` | Character chat system prompt (uses `{{characterName}}`) |
| `character-chat.instructions` | `src/server/character-chat/agents.ts` | Roleplay behavior instructions |
| `character-chat.persona.character` | `src/server/character-chat/agents.ts` | Named character persona (uses `{{personaName}}`, `{{personaDescription}}`) |
| `character-chat.persona.stranger` | `src/server/character-chat/agents.ts` | Anonymous stranger persona |
| `character-chat.persona.custom` | `src/server/character-chat/agents.ts` | Custom persona (uses `{{prompt}}`) |

### Directions (2)

| Key | Registered in | Description |
|---|---|---|
| `directions.system` | `src/server/directions/agents.ts` | Direction suggestion system prompt |
| `directions.suggest-template` | `src/server/directions/agents.ts` | Suggest prompt template |

### Chapters (1)

| Key | Registered in | Description |
|---|---|---|
| `chapters.summarize.system` | `src/server/chapters/agents.ts` | Chapter summarization system prompt |

## Customizing Instructions

Per-model JSON overrides were replaced by **agent blocks**: every agent's prompt is assembled from blocks that can be overridden, reordered, disabled, or extended per story in the Agent Context panel. To customize an instruction, override the block that carries it (typically the `instructions` block) for the agent in question. See `docs/context-blocks.md` and `docs/adding-agents.md`.

## Template Variables

Some instruction keys contain `{{placeholder}}` markers that are substituted at call sites — not by the registry itself. The registry stores the raw template text.

| Key | Variables | Substituted in |
|---|---|---|
| `character-chat.system` | `{{characterName}}` | `src/server/character-chat/chat.ts` |
| `character-chat.persona.character` | `{{personaName}}`, `{{personaDescription}}` | `src/server/character-chat/chat.ts` |
| `character-chat.persona.custom` | `{{prompt}}` | `src/server/character-chat/chat.ts` |
| `directions.suggest-template` | (varies by caller) | `src/server/directions/suggest.ts` |

## Integration

Instructions flow into agent contexts through `instructionRegistry.resolve(key)`:

1. Agent block definitions call `resolve()` in their `createDefaultBlocks()` function
2. The instruction text becomes the content of a context block (typically the `instructions` block)
3. Users customize that block per story via the Agent Context panel (block overrides), not via the registry

## File Reference

| File | Purpose |
|---|---|
| `src/server/instructions/registry.ts` | `InstructionRegistry` class and singleton |
| `src/server/instructions/index.ts` | Re-exports |
| `tests/instructions/registry.test.ts` | Full test suite |
