import { Elysia, t } from 'elysia'
import { getStory, getFragment, updateFragment, updateStory } from '../fragments/storage'
import {
  getGenerationLog,
  listGenerationLogs,
} from '../llm/generation-logs'
import { getLibrarianRuntimeStatus, triggerLibrarian } from '../librarian/scheduler'
import { createSSEStream } from '../librarian/analysis-stream'
import { createAgentInstance, listAgentRuns } from '../agents'
import {
  getActiveState as getLibrarianState,
  listActiveAnalyses as listLibrarianAnalyses,
  getAnalysis as getLibrarianAnalysis,
  saveAnalysis as saveLibrarianAnalysis,
  getChatHistory as getLibrarianChatHistory,
  appendChatMessage,
  updateChatMessageByRunId,
  clearChatHistory as clearLibrarianChatHistory,
  listConversations,
  createConversation,
  deleteConversation,
  getConversationHistory,
  appendConversationMessage,
  getLatestAnalysisIdsByFragment,
} from '../librarian/storage'
import { applyFragmentSuggestion } from '../librarian/suggestions'
import { createLogger } from '../logging'
import { describeError } from '../error-message'
import { encodeStream } from './encode-stream'
import { startRun, findLiveRun, abortedByTimeout, abortedByUser, type Run } from '../runs'
import { runStreamResponse, resolveExistingRun } from '../runs/http'
import { startAgentRun } from '../runs/agent-run'
import { createTurnTracker } from '../runs/turn-tracker'
import type { Logger } from '../logging'
import type { ChatHistory, ChatHistoryMessage, ChatHistoryToolCall } from '../librarian/storage'
import type { ChatContinuation } from '../librarian/chat'
import type { AgentStreamCompletion } from '../agents/stream-types'

function buildContinuation(history: ChatHistory): ChatContinuation | undefined {
  const last = history.messages[history.messages.length - 1]
  if (last?.role === 'assistant' && last.incomplete && last.plan?.length) {
    return {
      plan: last.plan,
      completedSteps: last.completedSteps ?? [],
      reasoning: last.reasoning ?? '',
    }
  }
  return undefined
}

function deriveChatTurnFields(
  result: AgentStreamCompletion,
  maxSteps: number,
): Pick<ChatHistoryMessage, 'toolCalls' | 'plan' | 'completedSteps' | 'incomplete'> {
  const planCall = result.toolCalls.find(tc => tc.toolName === 'planEdits')
  const plan = planCall ? (planCall.args.steps as string[] | undefined) : undefined
  const completedSteps = result.toolCalls
    .filter(tc => tc.toolName !== 'planEdits')
    .map(tc => `${tc.toolName}(${JSON.stringify(tc.args)})`)
  // Running out of steps mid-work leaves the request unfinished whether or not
  // the model declared a plan first — keying this on `plan` alone meant an
  // exhausted turn with no `planEdits` call was silently recorded as a success.
  const incomplete = result.stepCount >= maxSteps && result.toolCalls.length > 0

  return {
    toolCalls: result.toolCalls,
    ...(plan ? { plan } : {}),
    ...(completedSteps.length > 0 ? { completedSteps } : {}),
    ...(incomplete ? { incomplete: true } : {}),
  }
}

/** Keep a replayed tool call recognisable without pasting a whole fragment back in. */
function summarizeToolCall(tc: ChatHistoryToolCall): string {
  const args = JSON.stringify(tc.args ?? {})
  return `${tc.toolName}(${args.length > 200 ? args.slice(0, 200) + '…' : args})`
}

/**
 * Render stored history into the messages the provider actually sees.
 *
 * Two things go wrong with a naive `{ role, content }` map.
 *
 * An assistant turn stores its tool calls in a separate field, so replaying
 * only `content` hides the edits that turn made. The model then has no record
 * of them and cheerfully does them again — the duplicate-edit complaint, in its
 * deeper form: persisting the turn isn't enough if the next turn never sees it.
 *
 * And an assistant turn can legitimately have empty content — interrupted by a
 * restart, cancelled, or a model that made its edits and said nothing. Sending
 * that as literal `""` is worse than useless: Anthropic rejects empty text
 * blocks outright, which fails the next turn, which records another empty turn.
 * One blank reply compounds into a conversation that never answers again.
 */
export function toProviderMessages(
  messages: ChatHistoryMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const m of messages) {
    if (m.role === 'user') {
      // A user turn is only ever what the author typed; never blank in practice,
      // but guard anyway so we can't emit empty content from this side either.
      out.push({ role: 'user', content: m.content.trim() || '(empty message)' })
      continue
    }

    const parts: string[] = []
    if (m.content.trim()) parts.push(m.content.trim())

    const applied = (m.toolCalls ?? [])
      .filter(tc => tc.toolName !== 'planEdits')
      .map(summarizeToolCall)
    if (applied.length) {
      parts.push(`[Already applied this turn: ${applied.join('; ')}]`)
    }

    if (m.status === 'error' || m.status === 'cancelled') {
      parts.push(`[This turn ended early (${m.status}) — anything planned beyond the calls above did not happen.]`)
    }

    out.push({
      role: 'assistant',
      content: parts.join('\n\n') || '[No reply was recorded for this turn.]',
    })
  }

  return out
}

/**
 * Start a librarian chat turn as a server-owned run.
 *
 * Shared by the legacy per-story chat and named conversations — they differ
 * only by `conversationId`. The turn is persisted before, during, and after
 * generation, so a client that disconnects loses nothing: the run keeps
 * applying edits and recording them, and the client reattaches by run id.
 */
async function startLibrarianChatRun(args: {
  dataDir: string
  storyId: string
  conversationId: string | null
  message: string
  clientRequestId?: string
  maxSteps: number
  logger: Logger
}): Promise<Run> {
  const { dataDir, storyId, conversationId, message, clientRequestId, maxSteps, logger } = args

  const priorHistory = conversationId
    ? await getConversationHistory(dataDir, storyId, conversationId)
    : await getLibrarianChatHistory(dataDir, storyId)
  const continuation = buildContinuation(priorHistory)

  const appendMessage = (m: ChatHistoryMessage) => conversationId
    ? appendConversationMessage(dataDir, storyId, conversationId, m)
    : appendChatMessage(dataDir, storyId, m)

  const historyAfterUser = await appendMessage({ role: 'user', content: message })
  const agentMessages = toProviderMessages(historyAfterUser.messages)

  return startRun({
    dataDir,
    storyId,
    kind: 'librarian.chat',
    scopeId: conversationId,
    ...(clientRequestId ? { clientRequestId } : {}),
    body: async ({ runId, emit, signal }) => {
      // Record the turn as in-flight *before* generating, so it exists in
      // history from the first moment and is never derived from a live stream.
      await appendMessage({ role: 'assistant', content: '', runId, status: 'streaming' })

      const tracker = createTurnTracker({
        write: (snap) => updateChatMessageByRunId(dataDir, storyId, conversationId, runId, {
          content: snap.content,
          ...(snap.reasoning ? { reasoning: snap.reasoning } : {}),
          ...(snap.toolCalls.length ? { toolCalls: snap.toolCalls } : {}),
        }),
      })

      const agent = createAgentInstance('librarian.chat', { dataDir, storyId })
      let streamResult: Awaited<ReturnType<typeof agent.execute>>
      try {
        streamResult = await agent.execute({ messages: agentMessages, maxSteps, continuation })
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

        // Settle history before the run is marked finished, so a client that
        // sees `run-end` and refetches always reads the final turn.
        //
        // An aborted provider stream often ends gracefully rather than
        // throwing, so completing normally is not proof the turn finished —
        // the signal is what says whether the author stopped it.
        // Nothing said *and* nothing done, even after the tool-free retry:
        // record a failure rather than a blank success, which reads to the
        // author as the librarian ignoring them.
        //
        // A silent turn that *did* land tool calls is not an error — the work
        // happened. That one stays 'complete' and the UI notes the missing
        // prose alongside the tool-call cards.
        const saidNothing =
          !result.text.trim() && result.toolCalls.length === 0 && !signal.aborted

        await tracker.flush()
        await updateChatMessageByRunId(dataDir, storyId, conversationId, runId, {
          content: result.text,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          ...deriveChatTurnFields(result, maxSteps),
          status: abortedByTimeout(signal)
            ? 'error'
            : signal.aborted ? 'cancelled' : saidNothing ? 'error' : 'complete',
          ...(abortedByTimeout(signal) ? { error: 'Generation timed out.' } : {}),
          ...(saidNothing ? { error: 'The model returned an empty response.' } : {}),
        })

        if (saidNothing) {
          logger.warn('Librarian chat produced no text', {
            runId,
            finishReason: result.finishReason,
            stepCount: result.stepCount,
            toolCallCount: result.toolCalls.length,
          })
        }

        logger.info('Librarian chat completed', {
          runId,
          stepCount: result.stepCount,
          finishReason: result.finishReason,
          toolCallCount: result.toolCalls.length,
        })
      } catch (err) {
        // Keep whatever streamed through — those tool calls already ran and
        // already mutated fragments. Dropping them is what made the librarian
        // re-apply the same edits on the next turn.
        await tracker.flush()
        await updateChatMessageByRunId(dataDir, storyId, conversationId, runId, {
          status: abortedByUser(signal) ? 'cancelled' : 'error',
          ...(abortedByUser(signal)
            ? {}
            : { error: abortedByTimeout(signal) ? 'Generation timed out.' : describeError(err) }),
        })
        throw err
      }
    },
  })
}

export function librarianRoutes(dataDir: string) {
  const logger = createLogger('api:librarian', { dataDir })

  return new Elysia({ detail: { tags: ['Librarian'] } })
    // --- Generation Logs ---
    .get('/stories/:storyId/generation-logs', async ({ params }) => {
      return listGenerationLogs(dataDir, params.storyId)
    }, { detail: { summary: 'List generation logs' } })

    .get('/stories/:storyId/generation-logs/:logId', async ({ params, set }) => {
      const log = await getGenerationLog(dataDir, params.storyId, params.logId)
      if (!log) {
        set.status = 404
        return { error: 'Generation log not found' }
      }
      return log
    }, { detail: { summary: 'Get a generation log by ID' } })

    // --- Librarian ---
    .get('/stories/:storyId/librarian/status', async ({ params }) => {
      const state = await getLibrarianState(dataDir, params.storyId)
      const runtime = getLibrarianRuntimeStatus(params.storyId)
      return {
        ...state,
        ...runtime,
      }
    }, { detail: { summary: 'Get librarian status' } })

    .get('/stories/:storyId/librarian/analysis-index', async ({ params }) => {
      const index = await getLatestAnalysisIdsByFragment(dataDir, params.storyId)
      return Object.fromEntries(index)
    }, { detail: { summary: 'Get fragment → analysis ID mapping' } })

    .post('/stories/:storyId/librarian/analyze', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const { fragmentId } = body as { fragmentId: string }
      if (!fragmentId) {
        set.status = 422
        return { error: 'fragmentId is required' }
      }
      const fragment = await getFragment(dataDir, params.storyId, fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }
      triggerLibrarian(dataDir, params.storyId, fragment).catch((err) => {
        logger.error('Manual librarian trigger failed', { error: describeError(err) })
      })
      return { ok: true, fragmentId }
    }, { detail: { summary: 'Trigger librarian analysis on a specific fragment' } })

    .post('/stories/:storyId/librarian/resummarize', async ({ params, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      try {
        const { rebuildSummaries } = await import('../librarian/agent')
        const result = await rebuildSummaries(dataDir, params.storyId)
        return { ok: true, ...result }
      } catch (err) {
        logger.error('Resummarize failed', { error: describeError(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Failed to rebuild summaries' }
      }
    }, { detail: { summary: 'Rebuild all chapter summaries from scratch' } })

    .get('/stories/:storyId/librarian/analysis-stream', async ({ params, set }) => {
      const stream = createSSEStream(params.storyId)
      if (!stream) {
        set.status = 404
        return { error: 'No active analysis' }
      }
      return new Response(encodeStream(stream), {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      })
    }, { detail: { summary: 'Stream live analysis events (NDJSON)' } })

    .get('/stories/:storyId/librarian/analyses', async ({ params }) => {
      return listLibrarianAnalyses(dataDir, params.storyId)
    }, { detail: { summary: 'List all analyses' } })

    .get('/stories/:storyId/librarian/agent-runs', async ({ params }) => {
      return listAgentRuns(params.storyId)
    }, { detail: { summary: 'List agent runs' } })

    .get('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return analysis
    }, { detail: { summary: 'Get an analysis by ID' } })

    /**
     * @deprecated DEPRECATED (summary-fragments migration). Edits the
     * analysis's `summaryUpdate` field (the librarian's stated intent)
     * and performs a legacy string-replace into `story.summary`. Both
     * the intent write and the string-replace are no longer read by
     * downstream code — the artifact is the linked summary fragment
     * (`analysis.summaryFragmentId`). The correct edit surface is the
     * Summaries section in LibrarianPanel, which updates the fragment
     * directly via PUT /fragments/:id. Kept for backward compatibility
     * until the legacy inline edit UI is migrated or removed.
     */
    .patch('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, body, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const previousSummary = analysis.summaryUpdate
      const nextSummary = body.summaryUpdate.trim()
      analysis.summaryUpdate = nextSummary
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)

      const latestByFragment = await getLatestAnalysisIdsByFragment(dataDir, params.storyId)
      if (latestByFragment.get(analysis.fragmentId) === analysis.id) {
        const fragment = await getFragment(dataDir, params.storyId, analysis.fragmentId)
        if (fragment) {
          const meta = { ...fragment.meta }
          const existing = (meta._librarian ?? {}) as Record<string, unknown>
          meta._librarian = { ...existing, summary: nextSummary, analysisId: analysis.id }
          await updateFragment(dataDir, params.storyId, {
            ...fragment,
            meta,
          })
        }
      }

      // Legacy no-op: story.summary is no longer read by production code.
      // The replace runs only if story.summary still holds migration-stale content.
      if (previousSummary !== nextSummary && previousSummary && story.summary.includes(previousSummary)) {
        await updateStory(dataDir, {
          ...story,
          summary: story.summary.replace(previousSummary, nextSummary),
          updatedAt: new Date().toISOString(),
        })
      }

      return analysis
    }, {
      body: t.Object({
        summaryUpdate: t.String(),
      }),
      detail: { summary: 'Update an analysis summary (deprecated — edit the linked summary fragment instead)' },
    })

    .post('/stories/:storyId/librarian/analyses/:analysisId/suggestions/:index/accept', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentSuggestions.length) {
        set.status = 422
        return { error: 'Invalid suggestion index' }
      }

      const result = await applyFragmentSuggestion({
        dataDir,
        storyId: params.storyId,
        analysis,
        suggestionIndex: index,
        reason: 'manual-accept',
      })

      analysis.fragmentSuggestions[index].accepted = true
      analysis.fragmentSuggestions[index].autoApplied = false
      analysis.fragmentSuggestions[index].createdFragmentId = result.fragmentId
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return {
        analysis,
        createdFragmentId: result.fragmentId,
      }
    }, { detail: { summary: 'Accept a fragment suggestion' } })

    .post('/stories/:storyId/librarian/analyses/:analysisId/suggestions/:index/dismiss', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentSuggestions.length) {
        set.status = 422
        return { error: 'Invalid suggestion index' }
      }

      analysis.fragmentSuggestions[index].dismissed = true
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return { analysis }
    }, { detail: { summary: 'Dismiss a fragment suggestion' } })

    .delete('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const { deleteAnalysis } = await import('../librarian/storage')
      const deleted = await deleteAnalysis(dataDir, params.storyId, params.analysisId)
      if (!deleted) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return { ok: true }
    }, { detail: { summary: 'Delete an analysis' } })

    // --- Librarian Refine ---
    .post('/stories/:storyId/librarian/refine', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Refinement request started', { fragmentId: body.fragmentId })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type === 'prose') {
        set.status = 422
        return { error: 'Cannot refine prose fragments. Use the generation refine mode instead.' }
      }

      try {
        const run = await startAgentRun({
          dataDir,
          storyId: params.storyId,
          kind: 'librarian.refine',
          scopeId: body.fragmentId,
          agentName: 'librarian.refine',
          input: {
            fragmentId: body.fragmentId,
            instructions: body.instructions,
            maxSteps: story.settings.maxSteps ?? 5,
          },
          onComplete: (result) => {
            requestLogger.info('Refinement completed', {
              fragmentId: body.fragmentId,
              stepCount: result.stepCount,
              finishReason: result.finishReason,
              toolCallCount: result.toolCalls.length,
            })
          },
        })
        return runStreamResponse(run)
      } catch (err) {
        requestLogger.error('Refinement failed', { error: describeError(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Refinement failed' }
      }
    }, {
      body: t.Object({
        fragmentId: t.String(),
        instructions: t.Optional(t.String()),
      }),
      detail: { summary: 'Refine a non-prose fragment (starts a run; streaming NDJSON)' },
    })

    // --- Librarian Prose Transform ---
    .post('/stories/:storyId/librarian/prose-transform', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Prose transform request started', {
        fragmentId: body.fragmentId,
        operation: body.operation,
      })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type !== 'prose') {
        set.status = 422
        return { error: 'Only prose fragments support selection transforms.' }
      }

      try {
        const run = await startAgentRun({
          dataDir,
          storyId: params.storyId,
          kind: 'librarian.prose-transform',
          scopeId: body.fragmentId,
          agentName: 'librarian.prose-transform',
          input: {
            fragmentId: body.fragmentId,
            selectedText: body.selectedText,
            operation: body.operation,
            instruction: body.instruction,
            sourceContent: body.sourceContent,
            contextBefore: body.contextBefore,
            contextAfter: body.contextAfter,
          },
          onComplete: (result) => {
            requestLogger.info('Prose transform completed', {
              fragmentId: body.fragmentId,
              operation: body.operation,
              stepCount: result.stepCount,
              finishReason: result.finishReason,
              outputLength: result.text.trim().length,
              reasoningLength: result.reasoning.trim().length,
            })
          },
        })
        return runStreamResponse(run)
      } catch (err) {
        requestLogger.error('Prose transform failed', { error: describeError(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Prose transform failed' }
      }
    }, {
      body: t.Object({
        fragmentId: t.String(),
        selectedText: t.String({ minLength: 1 }),
        operation: t.Union([t.Literal('rewrite'), t.Literal('expand'), t.Literal('compress'), t.Literal('custom')]),
        instruction: t.Optional(t.String()),
        sourceContent: t.Optional(t.String()),
        contextBefore: t.Optional(t.String()),
        contextAfter: t.Optional(t.String()),
      }),
      detail: { summary: 'Transform a prose selection (streaming NDJSON)' },
    })

    // --- Librarian Chat ---
    .get('/stories/:storyId/librarian/chat', async ({ params }) => {
      return getLibrarianChatHistory(dataDir, params.storyId)
    }, { detail: { summary: 'Get chat history' } })

    .delete('/stories/:storyId/librarian/chat', async ({ params }) => {
      await clearLibrarianChatHistory(dataDir, params.storyId)
      return { ok: true }
    }, { detail: { summary: 'Clear chat history' } })

    .post('/stories/:storyId/librarian/chat', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Librarian chat request')

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const text = body.message.trim()
      if (!text) {
        set.status = 422
        return { error: 'message is required' }
      }

      const existing = resolveExistingRun(params.storyId, null, body.clientRequestId)
      if (existing) return existing

      const live = findLiveRun(params.storyId, 'librarian.chat', null)
      if (live) {
        set.status = 409
        return { error: 'A chat turn is already running', runId: live.id }
      }

      try {
        const run = await startLibrarianChatRun({
          dataDir,
          storyId: params.storyId,
          conversationId: null,
          message: text,
          ...(body.clientRequestId ? { clientRequestId: body.clientRequestId } : {}),
          maxSteps: story.settings.maxSteps ?? 10,
          logger: requestLogger,
        })
        return runStreamResponse(run)
      } catch (err) {
        requestLogger.error('Librarian chat failed to start', { error: describeError(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Chat failed' }
      }
    }, {
      body: t.Object({
        message: t.String({ minLength: 1 }),
        clientRequestId: t.Optional(t.String()),
      }),
      detail: { summary: 'Chat with the librarian (starts a run; streaming NDJSON)' },
    })

    // --- Conversations ---
    .get('/stories/:storyId/librarian/conversations', async ({ params }) => {
      return listConversations(dataDir, params.storyId)
    }, { detail: { summary: 'List chat conversations' } })

    .post('/stories/:storyId/librarian/conversations', async ({ params, body }) => {
      return createConversation(dataDir, params.storyId, body.title ?? 'New chat')
    }, {
      body: t.Object({ title: t.Optional(t.String()) }),
      detail: { summary: 'Create a chat conversation' },
    })

    .delete('/stories/:storyId/librarian/conversations/:conversationId', async ({ params, set }) => {
      const ok = await deleteConversation(dataDir, params.storyId, params.conversationId)
      if (!ok) { set.status = 404; return { error: 'Conversation not found' } }
      return { ok: true }
    }, { detail: { summary: 'Delete a conversation' } })

    .get('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params }) => {
      return getConversationHistory(dataDir, params.storyId, params.conversationId)
    }, { detail: { summary: 'Get conversation chat history' } })

    .post('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId, extra: { conversationId: params.conversationId } })
      requestLogger.info('Conversation chat request')

      const story = await getStory(dataDir, params.storyId)
      if (!story) { set.status = 404; return { error: 'Story not found' } }

      const text = body.message.trim()
      if (!text) { set.status = 422; return { error: 'message is required' } }

      const existing = resolveExistingRun(params.storyId, params.conversationId, body.clientRequestId)
      if (existing) return existing

      const live = findLiveRun(params.storyId, 'librarian.chat', params.conversationId)
      if (live) {
        set.status = 409
        return { error: 'A chat turn is already running', runId: live.id }
      }

      try {
        const run = await startLibrarianChatRun({
          dataDir,
          storyId: params.storyId,
          conversationId: params.conversationId,
          message: text,
          ...(body.clientRequestId ? { clientRequestId: body.clientRequestId } : {}),
          maxSteps: story.settings.maxSteps ?? 10,
          logger: requestLogger,
        })
        return runStreamResponse(run)
      } catch (err) {
        requestLogger.error('Conversation chat failed to start', { error: describeError(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Chat failed' }
      }
    }, {
      body: t.Object({
        message: t.String({ minLength: 1 }),
        clientRequestId: t.Optional(t.String()),
      }),
      detail: { summary: 'Chat in a conversation (starts a run; streaming NDJSON)' },
    })
}
