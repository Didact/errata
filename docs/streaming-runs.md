# Server-Authoritative Runs

Every LLM generation in Errata — librarian chat, prose generation, character
chat, refine, prose-transform — executes as a **run**: a server-owned unit of
work with its own event log. HTTP requests are only ever *subscribers* to that
log, reading from a cursor.

## Why

Streams used to be bound to the lifetime of the HTTP request that started them.
On a phone, where the tab is often backgrounded and the network is unreliable,
that produced three failure modes:

1. **Lost assistant turns.** The stream writer enqueued into a `ReadableStream`
   that the response consumed directly. A client disconnect cancelled that
   stream, so the next `enqueue` threw; the generation's completion promise
   rejected; and the route — which persisted the assistant message inside
   `completion.then(...)` — never wrote it. The whole turn vanished, *including
   tool calls that had already mutated fragments*.
2. **Repeated edits.** Because the turn was never recorded, the next turn's
   history had no evidence the tools had run, so the model did the work again.
3. **Truncated prose.** The generation route wired the response stream's
   `cancel` directly to `abortController.abort()`. Backgrounding the tab killed
   the generation, and `/generate` saved the partial text as a fragment.

Runs fix all three at the root: **nothing a consumer does can affect a
generation.**

## Model

```
POST /stories/:id/librarian/chat          →  startRun() ──┐
                                                          │  detached body
  response  ←  subscribeRun(run, cursor=0)  ←  event log ←┘  (keeps going)
                     ▲
                     └── GET /runs/:runId/events?cursor=N   (reattach)
```

### The registry — `src/server/runs/registry.ts`

- `startRun({ dataDir, storyId, kind, scopeId, clientRequestId, body })` registers
  a run and starts `body` **detached** from the request.
- `emit` **never throws and never blocks on a consumer**. This is the invariant
  the whole design rests on.
- The abort signal fires **only** on an explicit `cancelRun`. Nothing in the HTTP
  layer touches it.
- Consecutive text/reasoning deltas are coalesced for ~50ms *before* being
  assigned a `seq`, so sequence numbers are immutable once emitted and a
  subscriber can never miss text appended to an event it already delivered.
- Finished runs are retained for 10 minutes so a phone that wakes up late can
  still pull the tail.

### Branch pinning

`withBranch` uses `AsyncLocalStorage`, and every write resolves through
`getContentRoot`. Because a run body outlives its request, `startRun` resolves
the active branch **once** and wraps the body in `withBranch(..., branchId)`.
Switching timelines mid-run therefore cannot redirect that run's writes.

### `scopeId`

Identifies which UI surface owns a run — a conversation id for chats, a fragment
id for refine/prose-transform. It's how a client asks "is something already
running for *this* view?".

## Event protocol

NDJSON, one event per line, each carrying its `seq` (its position in the log).

| Event | Meaning |
|---|---|
| `run-start` | Always first. Carries `runId`. |
| `text`, `reasoning`, `tool-call`, `tool-result`, `tool-error`, `finish` | Agent events. |
| `phase`, `prewriter-text`, `prewriter-reset`, `prewriter-directions`, `clarify-questions` | Generation-specific. |
| `error` | **Terminal.** The run failed. |
| `run-end` | **Terminal.** Carries the final `status`. |

**The disconnect rule:** a stream that ends *without* a terminal `run-end` or
`error` was a dropped connection, not a result. This is the distinction the old
code could not make — `controller.error()` surfaced to the client as a generic
network failure, indistinguishable from the phone going to sleep.

The response also sets `X-Run-Id` (reattach without parsing the body) and
`X-Accel-Buffering: no` (stop a reverse proxy from holding the whole NDJSON body
until the generation finishes, which looks exactly like a hang).

### Keepalive

A subscriber that sits silent for 5s gets a blank line. Generations routinely go
tens of seconds without emitting — model latency on a large context, a slow tool
— and anything between the phone and the server that tracks idleness will drop
such a connection: carrier NAT, tunnels, corporate proxies. The client recovers
by reattaching, but the author sees a needless "reconnecting" mid-answer.

A blank line is valid NDJSON padding that both client parsers already skip, so
it costs no protocol change and consumes no `seq`.

Note this guards the *network* path, not the runtime: Nitro bundles srvx's Node
adapter, and Node's http server imposes no idle timeout on a streaming response
(verified by holding one silent for 20s with keepalives disabled).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/stories/:storyId/runs?active=1&scopeId=…` | What is still running. |
| `GET` | `/stories/:storyId/runs/:runId` | One run's status. |
| `GET` | `/stories/:storyId/runs/:runId/events?cursor=N` | Replay from `N`, then follow live. |
| `POST` | `/stories/:storyId/runs/:runId/cancel` | The only thing that stops a generation. |

## Chat turn persistence

"Tool calls must always be properly indicated" is enforced by writing the turn
as it happens rather than at the end:

1. The user message is appended.
2. A placeholder assistant message is appended **before generation starts**,
   with `runId` and `status: 'streaming'`.
3. `createTurnTracker` patches it in place — throttled (~500ms) for text, and
   **unconditionally on every tool result**, because text can be reconstructed
   from the event log whereas a missing tool call is what causes duplicate edits.
4. On settle, a final patch sets `status` to `complete` / `cancelled` / `error`.
   This happens *before* the run is marked finished, so a client that sees
   `run-end` and refetches always reads settled state.

Turns are addressed by `runId`, not "the last message", so a late write can
never clobber a newer turn.

**Cancellation detects the signal, not an error.** An aborted provider stream
usually ends *gracefully* rather than throwing, so returning without an error is
not proof the turn finished.

**Crash recovery without a journal.** On read, a trailing `streaming` turn whose
`runId` is absent from the live registry is reported as interrupted. Derived at
read time — no migration, no stale lock file — and the tool calls that did land
are still on the record.

## Idempotency

A flaky mobile link makes duplicate POSTs likely, and a duplicate POST would
otherwise be a second generation re-applying the same edits.

- `clientRequestId` on the request body: a retry attaches to the original run
  (including after it finished, within the retention window).
- A competing POST for a `(kind, scopeId)` that already has a live run gets
  `409` with the live `runId`, so the client attaches instead of racing.

## Client

`src/hooks/use-run-stream.ts` (`useRunStream`) for components, and
`consumeRun` in `src/lib/api/runs.ts` for imperative call sites.

Both dedupe by `seq` so replay after a reconnect can't double-apply anything.
`useRunStream` additionally:

- Reconnects with backoff (0.5s → 8s) when a stream ends without a terminal event.
- **Reconnects immediately on `visibilitychange`, `focus`, and `online`** —
  without this the user waits out the backoff every time they return to the app,
  which on a phone is constantly.
- Persists `runId` + cursor in `sessionStorage`, so a page reload reattaches.
- On mount, attaches to any live run matching its `(kind, scopeId)`.

A `404` from the events endpoint means the run aged out of the registry, so both
stop retrying and surface it rather than looping.

## Adding a new streaming surface

1. Add a `RunKind` in `src/server/runs/types.ts`.
2. In the route, call `startAgentRun` (agent-backed, no per-turn history) or
   `startRun` directly (if you need turn bookkeeping — see
   `startLibrarianChatRun` in `src/server/routes/librarian.ts`), then return
   `runStreamResponse(run)`.
3. Guard with `resolveExistingRun` + `findLiveRun` for idempotency.
4. On the client, use `useRunStream` with the matching `kind`/`scopeId`.

Streaming agents return `AgentStreamResult` — `{ run(onEvent), cancel() }` — so
the run layer decides when the generation runs and where its events go. Never
hand a consumer something that can stop the producer.

## Tests

- `tests/runs/registry.test.ts` — replay, live follow, coalescing, cancel, retention.
- `tests/api/runs-routes.test.ts` — the disconnect regression, cursor replay,
  idempotency, `409`, cancellation, restart-orphaned turns.
- `tests/llm/generation.test.ts` — full passage saved after a disconnect.
- `tests/lib/consume-run.test.ts` — the client half of the disconnect contract.
