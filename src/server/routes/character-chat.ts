import { Elysia, t } from 'elysia'
import { getStory, getFragment } from '../fragments/storage'
import { createAgentInstance } from '../agents'
import {
  saveConversation as saveCharacterConversation,
  getConversation as getCharacterConversation,
  listConversations as listCharacterConversations,
  deleteConversation as deleteCharacterConversation,
  appendMessage as appendCharacterMessage,
  updateMessageByRunId as updateCharacterMessageByRunId,
  generateConversationId,
  type CharacterChatConversation,
} from '../character-chat/storage'
import { createLogger } from '../logging'
import { startRun, findLiveRun } from '../runs'
import { runStreamResponse, resolveExistingRun } from '../runs/http'
import { createTurnTracker } from '../runs/turn-tracker'

export function characterChatRoutes(dataDir: string) {
  const logger = createLogger('api:character-chat', { dataDir })

  return new Elysia({ detail: { tags: ['Character Chat'] } })
    .get('/stories/:storyId/character-chat/conversations', async ({ params, query }) => {
      const characterId = typeof query?.characterId === 'string' ? query.characterId : undefined
      return listCharacterConversations(dataDir, params.storyId, characterId)
    }, {
      detail: { summary: 'List conversations, optionally filtered by character' },
    })

    .get('/stories/:storyId/character-chat/conversations/:conversationId', async ({ params, set }) => {
      const conv = await getCharacterConversation(dataDir, params.storyId, params.conversationId)
      if (!conv) {
        set.status = 404
        return { error: 'Conversation not found' }
      }
      return conv
    }, {
      detail: { summary: 'Get a conversation by ID' },
    })

    .post('/stories/:storyId/character-chat/conversations', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const character = await getFragment(dataDir, params.storyId, body.characterId)
      if (!character || character.type !== 'character') {
        set.status = 404
        return { error: 'Character not found' }
      }

      const now = new Date().toISOString()
      const conv: CharacterChatConversation = {
        id: generateConversationId(),
        characterId: body.characterId,
        persona: body.persona,
        storyPointFragmentId: body.storyPointFragmentId ?? null,
        title: body.title || `Chat with ${character.name}`,
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      await saveCharacterConversation(dataDir, params.storyId, conv)
      return conv
    }, {
      detail: { summary: 'Create a new conversation' },
      body: t.Object({
        characterId: t.String(),
        persona: t.Union([
          t.Object({ type: t.Literal('character'), characterId: t.String() }),
          t.Object({ type: t.Literal('stranger') }),
          t.Object({ type: t.Literal('custom'), prompt: t.String() }),
        ]),
        storyPointFragmentId: t.Optional(t.Union([t.String(), t.Null()])),
        title: t.Optional(t.String()),
      }),
    })

    .delete('/stories/:storyId/character-chat/conversations/:conversationId', async ({ params, set }) => {
      const deleted = await deleteCharacterConversation(dataDir, params.storyId, params.conversationId)
      if (!deleted) {
        set.status = 404
        return { error: 'Conversation not found' }
      }
      return { ok: true }
    }, {
      detail: { summary: 'Delete a conversation' },
    })

    .post('/stories/:storyId/character-chat/conversations/:conversationId/chat', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId, extra: { conversationId: params.conversationId } })
      requestLogger.info('Character chat request')

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const conv = await getCharacterConversation(dataDir, params.storyId, params.conversationId)
      if (!conv) {
        set.status = 404
        return { error: 'Conversation not found' }
      }

      const text = body.message.trim()
      if (!text) {
        set.status = 422
        return { error: 'message is required' }
      }

      const existing = resolveExistingRun(params.storyId, params.conversationId, body.clientRequestId)
      if (existing) return existing

      const live = findLiveRun(params.storyId, 'character-chat', params.conversationId)
      if (live) {
        set.status = 409
        return { error: 'A chat turn is already running', runId: live.id }
      }

      try {
        // The client sends only the new message; the server owns the transcript.
        const afterUser = await appendCharacterMessage(dataDir, params.storyId, params.conversationId, {
          role: 'user',
          content: text,
          createdAt: new Date().toISOString(),
        })
        const agentMessages = (afterUser ?? conv).messages.map(m => ({ role: m.role, content: m.content }))

        const run = await startRun({
          dataDir,
          storyId: params.storyId,
          kind: 'character-chat',
          scopeId: params.conversationId,
          ...(body.clientRequestId ? { clientRequestId: body.clientRequestId } : {}),
          body: async ({ runId, emit, signal }) => {
            await appendCharacterMessage(dataDir, params.storyId, params.conversationId, {
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
              runId,
              status: 'streaming',
            })

            const tracker = createTurnTracker({
              write: (snap) => updateCharacterMessageByRunId(
                dataDir, params.storyId, params.conversationId, runId,
                {
                  content: snap.content,
                  ...(snap.reasoning ? { reasoning: snap.reasoning } : {}),
                },
              ),
            })

            const agent = createAgentInstance('character-chat.chat', { dataDir, storyId: params.storyId })
            let streamResult
            try {
              streamResult = await agent.execute({
                characterId: conv.characterId,
                persona: conv.persona,
                storyPointFragmentId: conv.storyPointFragmentId,
                messages: agentMessages,
                maxSteps: story.settings.maxSteps ?? 10,
              })
            } catch (err) {
              agent.fail(err)
              throw err
            }

            signal.addEventListener('abort', () => streamResult.cancel(), { once: true })

            try {
              const result = await streamResult.run((event) => {
                emit(event)
                tracker.onEvent(event)
              })

              await tracker.flush()
              await updateCharacterMessageByRunId(dataDir, params.storyId, params.conversationId, runId, {
                content: result.text,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                status: 'complete',
              })

              requestLogger.info('Character chat completed', {
                runId,
                stepCount: result.stepCount,
                finishReason: result.finishReason,
                toolCallCount: result.toolCalls.length,
              })
            } catch (err) {
              // Keep whatever streamed through rather than dropping the turn.
              await tracker.flush()
              await updateCharacterMessageByRunId(dataDir, params.storyId, params.conversationId, runId, {
                status: signal.aborted ? 'cancelled' : 'error',
                ...(signal.aborted ? {} : { error: err instanceof Error ? err.message : String(err) }),
              })
              throw err
            }
          },
        })

        return runStreamResponse(run)
      } catch (err) {
        requestLogger.error('Character chat failed to start', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Chat failed' }
      }
    }, {
      detail: { summary: 'Send a message (starts a run; streaming NDJSON)' },
      body: t.Object({
        message: t.String({ minLength: 1 }),
        clientRequestId: t.Optional(t.String()),
      }),
    })
}
