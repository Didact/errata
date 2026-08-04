import { tool, ToolLoopAgent, stepCountIs } from 'ai'
import { z } from 'zod/v4'
import { getModel } from '../llm/client'
import { getFragment, getStory } from '../fragments/storage'
import { buildContextState } from '../llm/context-builder'
import { createFragmentTools } from '../llm/tools'
import { pluginRegistry } from '../plugins/registry'
import { collectPluginTools } from '../plugins/tools'
import { createLogger } from '../logging'
import { consumeAgentStream } from '../agents/create-event-stream'
import { compileAgentContext } from '../agents/compile-agent-context'
import { createAgentInstance } from '../agents/agent-instance'
import { getFragmentsByTag } from '../fragments/associations'
import { inspectGenerationForFragment, type InspectAspect } from './inspect-generation'
import { runLibrarian } from './agent'
import { withBranch } from '../fragments/branches'
import type { ChatStreamEvent, ChatResult } from '../agents/stream-types'
import type { AgentBlockContext } from '../agents/agent-block-context'

export type { ChatStreamEvent, ChatResult }

const logger = createLogger('librarian-chat')

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatContinuation {
  plan: string[]
  completedSteps: string[]
  reasoning: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  maxSteps?: number
  continuation?: ChatContinuation
}

export async function librarianChat(
  dataDir: string,
  storyId: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  return withBranch(dataDir, storyId, () => librarianChatInner(dataDir, storyId, opts))
}

async function librarianChatInner(
  dataDir: string,
  storyId: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const requestLogger = logger.child({ storyId })
  requestLogger.info('Starting librarian chat...', { messageCount: opts.messages.length })

  // Validate story exists
  const story = await getStory(dataDir, storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }

  // Build context
  const ctxState = await buildContextState(dataDir, storyId, '')

  // Load system prompt fragments
  const sysFragIds = await getFragmentsByTag(dataDir, storyId, 'pass-to-librarian-system-prompt')
  const systemPromptFragments = []
  for (const id of sysFragIds) {
    const frag = await getFragment(dataDir, storyId, id)
    if (frag) {
      requestLogger.debug('Adding system prompt fragment to context', { fragmentId: frag.id, name: frag.name })
      systemPromptFragments.push(frag)
    }
  }

  // Resolve model early so modelId is available for instruction resolution
  const { model, modelId, temperature } = await getModel(dataDir, storyId, { role: 'librarian.chat' })
  requestLogger.info('Resolved model', { modelId })

  // Create write-enabled fragment tools + enabled plugin tools
  const enabledPlugins = (story.settings.enabledPlugins ?? [])
    .map((name) => pluginRegistry.get(name))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
  const fragmentTools = createFragmentTools(dataDir, storyId, { readOnly: false })
  const pluginTools = collectPluginTools(enabledPlugins, dataDir, storyId)

  const reanalyzeFragmentTool = tool({
    description: 'Re-run librarian analysis on a prose fragment. Updates its summary, detects mentions, flags contradictions, and suggests knowledge.',
    inputSchema: z.object({
      fragmentId: z.string().describe('The prose fragment ID to reanalyze (e.g. pr-bakumo)'),
    }),
    execute: async ({ fragmentId }: { fragmentId: string }) => {
      requestLogger.info('Reanalyzing fragment via chat tool', { fragmentId })
      try {
        const analysis = await runLibrarian(dataDir, storyId, fragmentId)
        return {
          ok: true,
          analysisId: analysis.id,
          summary: analysis.summaryUpdate,
          mentionCount: analysis.mentionedCharacters.length,
          contradictionCount: analysis.contradictions.length,
          suggestionCount: analysis.fragmentSuggestions.length,
          timelineEventCount: analysis.timelineEvents.length,
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const optimizeCharacterTool = tool({
    description: 'Optimize a character sheet using depth-focused writing methodology. Rewrites the character with causality, Egri dimensions, friction, and contrast.',
    inputSchema: z.object({
      fragmentId: z.string().describe('The character fragment ID to optimize (e.g. ch-bakumo)'),
      instructions: z.string().optional().describe('Optional specific instructions for the optimization'),
    }),
    execute: async ({ fragmentId, instructions }: { fragmentId: string; instructions?: string }) => {
      requestLogger.info('Optimizing character via chat tool', { fragmentId })
      const agent = createAgentInstance('librarian.optimize-character', { dataDir, storyId })
      try {
        const result = await agent.execute({ fragmentId, instructions })
        // Nested agent: drive it to completion, discarding its events — the
        // chat turn reports the outcome, not the sub-agent's token stream.
        await result.run(() => {})
        return { ok: true, fragmentId }
      } catch (err) {
        agent.fail(err)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const inspectGenerationTool = tool({
    description:
      "Inspect the generation (debug) details behind a generated prose fragment: the model used, the exact prompt/context it was given, the tools it called, token usage, the model's reasoning, and the prewriter brief. Use this to explain why a passage came out the way it did, or to trace a continuity issue back to what the model actually saw.",
    inputSchema: z.object({
      fragmentId: z.string().describe('The generated prose fragment ID to inspect (e.g. pr-bakumo)'),
      aspect: z
        .enum(['summary', 'prompt', 'tools', 'prewriter', 'reasoning'])
        .optional()
        .describe(
          'Which detail to return. Default "summary" is an overview; "prompt" is the full assembled context, "tools" is what the model looked up, "prewriter" is the writing brief, "reasoning" is the model\'s thinking.',
        ),
    }),
    execute: async ({ fragmentId, aspect }: { fragmentId: string; aspect?: InspectAspect }) => {
      requestLogger.info('Inspecting generation via chat tool', { fragmentId, aspect: aspect ?? 'summary' })
      return inspectGenerationForFragment(dataDir, storyId, fragmentId, aspect ?? 'summary')
    },
  })

  const planEditsTool = tool({
    description: 'Call this FIRST, before making any edits, to declare the concrete actions (tool calls) you intend to make to fulfill the request.',
    inputSchema: z.object({
      steps: z.array(z.string()).describe('Short descriptions of each action you intend to take, e.g. "update ch-bakumo description to mention the time skip"'),
    }),
    execute: async ({ steps }: { steps: string[] }) => ({ ok: true, steps }),
  })

  const allTools = { ...fragmentTools, ...pluginTools, reanalyzeFragment: reanalyzeFragmentTool, optimizeCharacter: optimizeCharacterTool, inspectGeneration: inspectGenerationTool, planEdits: planEditsTool }

  // Build plugin tool descriptions for the block context
  const pluginToolDescriptions = Object.entries(pluginTools).map(([name, def]) => ({
    name,
    description: (def as { description?: string }).description ?? '',
  }))

  // Build agent block context
  const blockContext: AgentBlockContext = {
    story: ctxState.story,
    proseFragments: ctxState.proseFragments,
    stickyGuidelines: ctxState.stickyGuidelines,
    stickyKnowledge: ctxState.stickyKnowledge,
    stickyCharacters: ctxState.stickyCharacters,
    guidelineShortlist: ctxState.guidelineShortlist,
    knowledgeShortlist: ctxState.knowledgeShortlist,
    characterShortlist: ctxState.characterShortlist,
    systemPromptFragments,
    pluginToolDescriptions,
    modelId,
    continuation: opts.continuation,
  }

  // Compile context via block system
  const compiled = await compileAgentContext(dataDir, storyId, 'librarian.chat', blockContext, allTools)

  requestLogger.info('Prepared chat tools', {
    fragmentToolCount: Object.keys(fragmentTools).length,
    pluginToolCount: Object.keys(pluginTools).length,
    totalToolCount: Object.keys(compiled.tools).length,
  })

  // Extract system instructions from compiled messages
  const systemMessage = compiled.messages.find(m => m.role === 'system')
  const userMessage = compiled.messages.find(m => m.role === 'user')

  const chatAgent = new ToolLoopAgent({
    model,
    instructions: systemMessage?.content || 'You are a helpful assistant.',
    tools: compiled.tools,
    toolChoice: 'auto',
    stopWhen: stepCountIs(opts.maxSteps ?? 10),
    temperature,
  })

  // Build messages: context as first user message, then conversation history
  const aiMessages = [
    { role: 'user' as const, content: `Here is the current story context for reference:\n\n${userMessage?.content ?? ''}\n\nI'm ready to chat about this story. Please acknowledge briefly.` },
    { role: 'assistant' as const, content: 'I have the story context. How can I help you with your fragments?' },
    ...opts.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  // Prepare the stream. The abort signal is wired to explicit cancel only — a
  // client disconnecting must never stop a turn that is already applying edits.
  const abortController = new AbortController()
  const result = await chatAgent.stream({
    messages: aiMessages,
    abortSignal: abortController.signal,
  })

  return {
    cancel: () => abortController.abort(),
    run: (onEvent) => consumeAgentStream(result.fullStream, onEvent),
  }
}
