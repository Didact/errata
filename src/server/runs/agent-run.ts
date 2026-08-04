/**
 * Start a registered agent as a server-owned run.
 *
 * For surfaces whose only durable artifact is whatever the agent's tools write
 * (refine, prose-transform). Chat surfaces need per-turn history bookkeeping and
 * build their run bodies directly.
 */

// Imported through the barrel, matching the other route modules — tests mock
// `@/server/agents`, and a deep import would bypass that mock.
import { createAgentInstance } from '../agents'
import type { AgentStreamCompletion } from '../agents/stream-types'
import { startRun, type Run } from './registry'
import type { RunKind } from './types'

export interface StartAgentRunOptions {
  dataDir: string
  storyId: string
  kind: RunKind
  scopeId?: string | null
  clientRequestId?: string
  agentName: string
  input: Record<string, unknown>
  /** Runs before the run is marked finished, so its effects are visible to a client that refetches on `run-end`. */
  onComplete?: (result: AgentStreamCompletion) => Promise<void> | void
}

export async function startAgentRun(opts: StartAgentRunOptions): Promise<Run> {
  return startRun({
    dataDir: opts.dataDir,
    storyId: opts.storyId,
    kind: opts.kind,
    scopeId: opts.scopeId ?? null,
    ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}),
    body: async ({ emit, signal }) => {
      const agent = createAgentInstance(opts.agentName, { dataDir: opts.dataDir, storyId: opts.storyId })

      let streamResult
      try {
        streamResult = await agent.execute(opts.input)
      } catch (err) {
        // The runner threw before producing a stream — record the failure so the
        // active-agent registration is freed instead of leaking.
        agent.fail(err)
        throw err
      }

      signal.addEventListener('abort', () => streamResult.cancel(), { once: true })

      const result = await streamResult.run(emit)
      await opts.onComplete?.(result)
    },
  })
}
