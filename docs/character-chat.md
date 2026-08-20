# Character Chat

Character Chat lets you talk to a character as if they were in-world, constrained by story context and the selected story point.

## Overview

- Conversations are stored per-story on disk and can be listed, resumed, or deleted.
- Storage is branch-aware, so each timeline has its own character-chat history.
- Chat runs as a server-owned **run** (see `docs/streaming-runs.md`): the client sends only the new message, the server owns the transcript, and a disconnect never stops or loses a turn.
- Chat responses stream as NDJSON events (`run-start`, `text`, `reasoning`, `tool-call`, `tool-result`, `finish`, `run-end`), each carrying a `seq` cursor.
- The chat agent uses read-only fragment tools so it can look things up without mutating story data.
- Model routing supports character-chat-specific provider/model settings with fallback to namespace and story defaults.
- The UI is conversation-first: you can start a new chat, resume older chats, switch persona modes, and set a story-point cutoff.

## Data Model

Conversation storage type (`src/server/character-chat/storage.ts`):

```ts
type PersonaMode =
  | { type: 'character'; characterId: string }
  | { type: 'stranger' }
  | { type: 'custom'; prompt: string }
```

```ts
interface CharacterChatConversation {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    reasoning?: string
    createdAt: string
  }>
  createdAt: string
  updatedAt: string
}
```

```ts
interface CharacterChatConversationSummary {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}
```

## Storage Layout

Character chat data is stored under the active branch content root:

```text
data/stories/<storyId>/
  branches/
    <branchId>/
      character-chat/
        conversations/
          cc-<timestamp>-<random>.json
```

`storyPointFragmentId` acts as a context cutoff. The agent only sees story context up to that point.

## API

Routes are defined in `src/server/routes/character-chat.ts`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/stories/:storyId/character-chat/conversations` | List conversations (optional `?characterId=...`) |
| `GET` | `/stories/:storyId/character-chat/conversations/:conversationId` | Get one conversation |
| `POST` | `/stories/:storyId/character-chat/conversations` | Create a conversation |
| `DELETE` | `/stories/:storyId/character-chat/conversations/:conversationId` | Delete a conversation |
| `POST` | `/stories/:storyId/character-chat/conversations/:conversationId/chat` | Stream character response |

### Create conversation payload

```json
{
  "characterId": "ch-ab12",
  "persona": { "type": "stranger" },
  "storyPointFragmentId": "pr-xy12",
  "title": "Interrogation in the courtyard"
}
```

### Chat payload

Only the new message is sent — the server holds the transcript and appends to it.
`clientRequestId` is an optional idempotency key so a retry over a flaky link
attaches to the run already in flight instead of generating twice.

```json
{
  "message": "What happened in the archive fire?",
  "clientRequestId": "cr-abc123"
}
```

A turn already running for this conversation returns `409` with the live `runId`,
so the client attaches rather than racing.

### Streaming format (NDJSON)

Example events from `/chat` stream:

```json
{"type":"run-start","runId":"run-abc","kind":"character-chat","status":"running","seq":0}
{"type":"text","text":"I remember smoke before I saw flames...","seq":1}
{"type":"tool-call","id":"...","toolName":"getFragment","args":{"id":"pr-ab12"},"seq":2}
{"type":"tool-result","id":"...","toolName":"getFragment","result":{"ok":true},"seq":3}
{"type":"finish","finishReason":"stop","stepCount":2,"seq":4}
{"type":"run-end","status":"complete","seq":5}
```

`run-end` (and `error`) are terminal. A stream that ends *without* one was a
dropped connection, not a result — reattach with
`GET /stories/:storyId/runs/:runId/events?cursor=N`.

## Provider/Model Selection

Character chat resolves models with role `character-chat.chat` (`src/server/llm/client.ts`) using the shared fallback chain system:

1. `story.settings.modelOverrides['character-chat.chat']`
2. `story.settings.modelOverrides['character-chat']`
3. `story.settings.modelOverrides['generation']`
4. Legacy `characterChatProviderId` / `characterChatModelId` fields, then legacy generation fields
5. Global default provider

Temperature follows the same fallback chain, so character chat can inherit or override provider/model temperature independently of prose generation.

## Frontend Integration

- Main UI: `src/components/character-chat/CharacterChatView.tsx`
- Config bar: `src/components/character-chat/ChatConfig.tsx`
- Conversation browser: `src/components/character-chat/ConversationList.tsx`
- Shared message rendering: `src/components/chat/ChatMessageParts.tsx`
- Client API wrapper: `src/lib/api/character-chat.ts`
- Story route toggle: `src/routes/story.$storyId.tsx`

The Character Chat view is mounted from the story route. The composer auto-resizes, conversations can be resumed from the list, and portraits are shown when the character fragment references an image or icon fragment.

## Context Assembly

Character chat uses the **agent block system** for context assembly. Instead of hardcoded system prompts and manual context string building, the character chat agent registers block definitions in `src/server/character-chat/blocks.ts`. At runtime, `compileAgentContext()` assembles the system and user messages from those blocks, applying any per-story agent block config overrides.

The agent is created via the shared `createToolAgent()` wrapper. The agent returns an `AgentStreamResult` (`{ run(onEvent), cancel() }`); the run registry drives it and owns the event log, so no consumer can stop the generation.

Character portraits are shown in the chat UI when the character fragment has an image reference in its `refs` array.

## Related Files

- `src/server/character-chat/chat.ts`
- `src/server/character-chat/blocks.ts` — agent block definitions (system prompt, context layout)
- `src/server/character-chat/storage.ts`
- `src/server/character-chat/agents.ts`
- `src/server/agents/create-agent.ts` — shared `createToolAgent` wrapper
- `src/server/agents/create-event-stream.ts` — `consumeAgentStream`, the shared agent-event normalizer
- `src/server/runs/` — run registry, turn tracker, and HTTP glue
- `src/server/agents/compile-agent-context.ts` — block-based context compiler
- `tests/character-chat/chat.test.ts`
- `tests/character-chat/storage.test.ts`
