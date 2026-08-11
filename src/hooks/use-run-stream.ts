import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { isTerminalChatEvent, type ChatEvent, type RunKind, type RunStatus, type SequencedChatEvent } from '@/lib/api/types'

/**
 * Client half of the server-authoritative run protocol.
 *
 * Reading a generation is decoupled from producing it. The server owns the
 * event log; this hook is a cursor over it. So:
 *
 * - Losing the connection is not losing the generation. The stream ending
 *   without a terminal `run-end`/`error` event means "disconnected", and we
 *   reconnect from the last seq we saw.
 * - Coming back to a backgrounded tab reconnects immediately rather than
 *   waiting out a backoff — the case this whole thing exists for.
 * - A page reload reattaches, because the run id and cursor are kept in
 *   sessionStorage and the server still has the run.
 *
 * Events are dispatched to `onEvent` exactly once, deduped by `seq`, so replay
 * after a reconnect can't double-apply anything.
 */

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

/**
 * How long the client will wait for *anything* before declaring the stream dead.
 *
 * The server sends a keepalive blank line every 5s for exactly this reason, so
 * silence this long means the connection is gone even though the socket still
 * looks open — a half-open TCP connection, a proxy that dropped one direction,
 * a backgrounded tab whose read loop was throttled. Nothing else notices: the
 * reader simply never resolves, so there is no stream end to trigger a
 * reconnect, and the author watches a spinner while the run finishes without
 * them. Three missed keepalives is unambiguous.
 */
const STALL_TIMEOUT_MS = 15_000

class StreamStalled extends Error {
  constructor() {
    super('Stream stalled')
    this.name = 'StreamStalled'
  }
}

/**
 * `reader.read()` that rejects rather than hanging forever if the stream goes
 * quiet past {@link STALL_TIMEOUT_MS}.
 */
async function readWithStallTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalled()), STALL_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export type RunPhase = 'idle' | RunStatus

export interface UseRunStreamOptions {
  storyId: string
  kind: RunKind
  /** conversationId / fragmentId — identifies which run belongs to this view. */
  scopeId?: string | null
  /** Receives every event once, in order. */
  onEvent?: (event: ChatEvent) => void
  /** Fires when the run reaches a terminal state. */
  onSettled?: (status: RunStatus, error?: string) => void
  /** Reattach to an already-running run for this scope on mount. Default true. */
  autoAttach?: boolean
}

export interface UseRunStreamResult {
  runId: string | null
  phase: RunPhase
  isStreaming: boolean
  /** True while disconnected from a run that is still going. */
  isReconnecting: boolean
  error: string | null
  /**
   * Start a run. `post` receives an idempotency key it must send with the
   * request, so a retry over a flaky link attaches instead of generating twice.
   */
  start: (post: (clientRequestId: string) => Promise<ReadableStream<SequencedChatEvent>>) => Promise<void>
  cancel: () => Promise<void>
  /** Forget the current run without cancelling it (e.g. switching conversations). */
  detach: () => void
}

function storageKey(storyId: string, kind: RunKind, scopeId: string | null): string {
  return `errata:run:${storyId}:${kind}:${scopeId ?? ''}`
}

function readStored(key: string): { runId: string; cursor: number } | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { runId?: string; cursor?: number }
    if (!parsed.runId) return null
    return { runId: parsed.runId, cursor: parsed.cursor ?? 0 }
  } catch {
    return null
  }
}

function writeStored(key: string, value: { runId: string; cursor: number } | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    // Private-mode or quota failures are not worth breaking the chat over.
  }
}

function makeClientRequestId(): string {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function useRunStream(options: UseRunStreamOptions): UseRunStreamResult {
  const { storyId, kind, scopeId = null, autoAttach = true } = options

  const [runId, setRunId] = useState<string | null>(null)
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Callbacks live in refs so a re-render with new closures doesn't restart
  // anything mid-stream.
  const onEventRef = useRef(options.onEvent)
  const onSettledRef = useRef(options.onSettled)
  onEventRef.current = options.onEvent
  onSettledRef.current = options.onSettled

  const runIdRef = useRef<string | null>(null)
  /** Next seq we expect; also the cursor we reconnect with. */
  const cursorRef = useRef(0)
  const settledRef = useRef(true)
  const connectedRef = useRef(false)
  const attemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = useRef(false)
  /** Bumped on detach/unmount so an in-flight reader knows it is stale. */
  const epochRef = useRef(0)

  const key = storageKey(storyId, kind, scopeId)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const settle = useCallback((status: RunStatus, message?: string) => {
    settledRef.current = true
    connectedRef.current = false
    clearReconnectTimer()
    setPhase(status)
    setIsReconnecting(false)
    if (message) setError(message)
    writeStored(key, null)
    onSettledRef.current?.(status, message)
  }, [clearReconnectTimer, key])

  /** Read a stream to its end. Returns true if the run reached a terminal event. */
  const consume = useCallback(async (
    stream: ReadableStream<SequencedChatEvent>,
    epoch: number,
  ): Promise<boolean> => {
    const reader = stream.getReader()
    connectedRef.current = true
    setIsReconnecting(false)
    let terminal = false

    try {
      while (true) {
        const { done, value } = await readWithStallTimeout(reader)
        if (done) break
        if (epoch !== epochRef.current) break

        const event = value as SequencedChatEvent
        // Replay after a reconnect can overlap; seq makes dedupe exact.
        if (typeof event.seq === 'number') {
          if (event.seq < cursorRef.current) continue
          cursorRef.current = event.seq + 1
        }

        if (event.type === 'run-start') {
          runIdRef.current = event.runId
          setRunId(event.runId)
          setPhase('running')
        }

        if (runIdRef.current) {
          writeStored(key, { runId: runIdRef.current, cursor: cursorRef.current })
        }

        onEventRef.current?.(event)

        if (isTerminalChatEvent(event)) {
          terminal = true
          if (event.type === 'error') {
            settle('error', event.error)
          } else if (event.type === 'run-end') {
            settle(event.status, event.status === 'error' ? 'Generation failed' : undefined)
          }
        }
      }
    } catch (err) {
      // A stall is a dropped connection, not a failed run — fall through with
      // `terminal` false so the caller reconnects from the cursor. Anything
      // else (a genuinely errored stream) is treated the same way: the run is
      // authoritative, and reattaching will tell us how it really ended.
      if (!(err instanceof StreamStalled)) {
        // Keep unexpected failures visible in dev without breaking recovery.
        console.warn('[useRunStream] stream read failed; will reattach', err)
      }
    } finally {
      connectedRef.current = false
      reader.cancel().catch(() => {})
    }

    return terminal
  }, [key, settle])

  /** Reconnect to the current run from our cursor, with backoff. */
  const scheduleReconnect = useCallback((immediate = false) => {
    if (disposedRef.current || settledRef.current || connectedRef.current) return
    if (!runIdRef.current) return
    if (reconnectTimerRef.current && !immediate) return

    clearReconnectTimer()
    const delay = immediate ? 0 : RECONNECT_DELAYS_MS[Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1)]
    if (immediate) attemptRef.current = 0
    setIsReconnecting(true)

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null
      if (disposedRef.current || settledRef.current || connectedRef.current) return

      const currentRunId = runIdRef.current
      if (!currentRunId) return
      const epoch = epochRef.current

      try {
        const stream = await api.runs.events(storyId, currentRunId, cursorRef.current)
        attemptRef.current = 0
        const terminal = await consume(stream, epoch)
        if (!terminal && epoch === epochRef.current) scheduleReconnect()
      } catch (err) {
        // A 404 means the run aged out of the registry; there is nothing left
        // to reattach to, so stop retrying and surface it.
        const status = (err as { status?: number })?.status
        if (status === 404) {
          settle('error', 'This generation is no longer available')
          return
        }
        attemptRef.current += 1
        scheduleReconnect()
      }
    }, delay)
  }, [clearReconnectTimer, consume, settle, storyId])

  const start = useCallback(async (
    post: (clientRequestId: string) => Promise<ReadableStream<SequencedChatEvent>>,
  ) => {
    clearReconnectTimer()
    epochRef.current += 1
    const epoch = epochRef.current

    runIdRef.current = null
    cursorRef.current = 0
    attemptRef.current = 0
    settledRef.current = false
    setRunId(null)
    setError(null)
    setPhase('running')

    const clientRequestId = makeClientRequestId()

    try {
      const stream = await post(clientRequestId)
      const terminal = await consume(stream, epoch)
      if (!terminal && epoch === epochRef.current) scheduleReconnect()
    } catch (err) {
      // A 409 means a turn is already running for this surface and the server
      // handed back its id precisely so we can watch it instead of racing it
      // (another tab, or a resend the UI didn't manage to block). Attaching is
      // the whole reason that id is in the response.
      const conflictRunId = (err as { status?: number; data?: { runId?: unknown } })?.status === 409
        ? (err as { data?: { runId?: unknown } }).data?.runId
        : undefined

      if (typeof conflictRunId === 'string') {
        runIdRef.current = conflictRunId
        cursorRef.current = 0
        setRunId(conflictRunId)
        try {
          const stream = await api.runs.events(storyId, conflictRunId, 0)
          const terminal = await consume(stream, epoch)
          if (!terminal && epoch === epochRef.current) scheduleReconnect()
          return
        } catch {
          scheduleReconnect()
          return
        }
      }

      // The POST itself failed, so no run exists to reattach to.
      settledRef.current = true
      const message = err instanceof Error ? err.message : 'Request failed'
      settle('error', message)
      throw err
    }
  }, [clearReconnectTimer, consume, scheduleReconnect, settle, storyId])

  const cancel = useCallback(async () => {
    const currentRunId = runIdRef.current
    if (!currentRunId) return
    try {
      await api.runs.cancel(storyId, currentRunId)
    } catch {
      // The run may have finished between render and click.
    }
  }, [storyId])

  const detach = useCallback(() => {
    epochRef.current += 1
    clearReconnectTimer()
    settledRef.current = true
    connectedRef.current = false
    runIdRef.current = null
    cursorRef.current = 0
    setRunId(null)
    setPhase('idle')
    setIsReconnecting(false)
    setError(null)
  }, [clearReconnectTimer])

  // Reattach on mount: to a stored run for this scope, or to whatever the
  // server says is still running here (covers a reload on a different device).
  useEffect(() => {
    if (!autoAttach) return
    disposedRef.current = false
    let cancelled = false

    void (async () => {
      const stored = readStored(key)
      let targetRunId = stored?.runId ?? null
      let cursor = stored?.cursor ?? 0

      try {
        if (targetRunId) {
          const summary = await api.runs.get(storyId, targetRunId)
          if (summary.status !== 'running') {
            writeStored(key, null)
            targetRunId = null
          }
        }
        if (!targetRunId) {
          const active = await api.runs.list(storyId, { active: true, scopeId })
          // Match the scope too. A null scopeId can't be expressed as a query
          // param, so the server returns every active run for the story —
          // without this check the legacy chat would latch onto a
          // conversation's run, and the "new prose" view onto a regeneration.
          const match = active.find(r => r.kind === kind && r.scopeId === scopeId)
          if (match) {
            targetRunId = match.id
            // No stored cursor for this client — replay the run from the top.
            cursor = 0
          }
        }
      } catch {
        return
      }

      if (cancelled || !targetRunId) return

      epochRef.current += 1
      const epoch = epochRef.current
      runIdRef.current = targetRunId
      cursorRef.current = cursor
      settledRef.current = false
      attemptRef.current = 0
      setRunId(targetRunId)
      setPhase('running')

      try {
        const stream = await api.runs.events(storyId, targetRunId, cursor)
        const terminal = await consume(stream, epoch)
        if (!terminal && epoch === epochRef.current) scheduleReconnect()
      } catch {
        scheduleReconnect()
      }
    })()

    return () => {
      cancelled = true
    }
    // Re-attach when the surface we're watching changes.
  }, [autoAttach, consume, kind, key, scheduleReconnect, scopeId, storyId])

  // Come back from a backgrounded tab or a dropped network and reconnect at
  // once. Without this the user waits out the backoff every time they switch
  // back to the app, which on a phone is constantly.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return
      if (settledRef.current || connectedRef.current) return
      scheduleReconnect(true)
    }
    const online = () => {
      if (settledRef.current || connectedRef.current) return
      scheduleReconnect(true)
    }

    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', online)
    window.addEventListener('focus', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', online)
      window.removeEventListener('focus', wake)
    }
  }, [scheduleReconnect])

  useEffect(() => {
    return () => {
      disposedRef.current = true
      epochRef.current += 1
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    }
  }, [])

  return {
    runId,
    phase,
    isStreaming: phase === 'running',
    isReconnecting,
    error,
    start,
    cancel,
    detach,
  }
}
