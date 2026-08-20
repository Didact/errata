/** HTTP glue between the run registry and Elysia routes. */

import { encodeStream } from '../routes/encode-stream'
import { subscribeRun, findRunByClientRequestId, type Run } from './registry'

/**
 * Stream a run's event log to the client, starting at `cursor`.
 *
 * The response is only ever a *view* of the run. If the client goes away
 * mid-stream, this stream is cancelled and nothing else happens — the run keeps
 * going, and the client reattaches later with the cursor it got to.
 *
 * The anti-buffering headers matter for the common deployment here: a phone
 * reaching the app through a reverse proxy. Without them an intermediary can
 * hold the whole NDJSON body until the generation finishes, which looks exactly
 * like a hang.
 */
export function runStreamResponse(run: Run, cursor = 0): Response {
  const stream = subscribeRun(run.id, cursor)
  if (!stream) {
    return new Response(JSON.stringify({ error: 'Run not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(encodeStream(stream), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Run-Id': run.id,
    },
  })
}

/**
 * Resolve a retried request to the run it already started.
 *
 * A flaky mobile connection makes duplicate POSTs likely, and a duplicate POST
 * would otherwise mean a second generation re-applying the same edits. If the
 * client sent an idempotency key we've seen, replay that run from the top
 * instead of starting a new one — including after it finished, since the run is
 * retained for a while.
 */
export function resolveExistingRun(
  storyId: string,
  scopeId: string | null,
  clientRequestId: string | undefined,
): Response | null {
  if (!clientRequestId) return null
  const existing = findRunByClientRequestId(storyId, clientRequestId)
  if (!existing || existing.scopeId !== scopeId) return null
  return runStreamResponse(existing, 0)
}
