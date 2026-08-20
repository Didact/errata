import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, ChevronRight, Brain, Loader2, Wrench, AlertTriangle } from 'lucide-react'
import { StreamMarkdown } from '@/components/ui/stream-markdown'

export interface ToolCallInfo {
  id: string
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface AssistantMessage {
  role: 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallInfo[]
  error?: string
  /** Steps the model declared via `planEdits` at the start of the turn. */
  plan?: string[]
  /** Tool calls it actually got through. */
  completedSteps?: string[]
  /** It ran out of tool steps with work still outstanding. */
  incomplete?: boolean
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | AssistantMessage

export function ToolCallCard({ tc, defaultExpanded = false }: { tc: ToolCallInfo; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const args = tc.args ?? {}
  const argSummary = Object.entries(args)
    .filter(([, v]) => typeof v === 'string' && (v as string).length < 80)
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(', ')

  const hasResult = tc.result !== undefined
  const hasError = Boolean(tc.error)

  return (
    <div className="my-1.5 rounded border border-border/40 bg-muted/20 text-[0.625rem]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <Badge variant="outline" className="text-[0.5625rem] px-1 py-0 h-4 font-mono">
          {tc.toolName}
        </Badge>
        {argSummary && (
          <span className="text-muted-foreground truncate">{argSummary}</span>
        )}
        {hasError && (
          <Badge variant="destructive" className="text-[0.5625rem] px-1 py-0 h-4 ml-auto shrink-0">
            failed
          </Badge>
        )}
        {!hasError && hasResult && (
          <Badge variant="secondary" className="text-[0.5625rem] px-1 py-0 h-4 ml-auto shrink-0">
            done
          </Badge>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-border/20">
          <div>
            <div className="text-muted-foreground mt-1.5 mb-0.5">Arguments</div>
            <pre className="bg-muted/30 rounded px-1.5 py-1 font-mono text-[0.625rem] overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {hasError && (
            <div>
              <div className="text-muted-foreground mb-0.5">Error</div>
              <pre className="bg-destructive/10 text-destructive rounded px-1.5 py-1 font-mono text-[0.625rem] overflow-x-auto whitespace-pre-wrap break-all">
                {tc.error}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-muted-foreground mb-0.5">Result</div>
              <pre className="bg-muted/30 rounded px-1.5 py-1 font-mono text-[0.625rem] overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(tc.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ReasoningSection({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[0.625rem] text-muted-foreground hover:text-muted-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />
        <span className="italic">
          {streaming ? 'Thinking...' : 'Reasoning'}
        </span>
        {streaming && <Loader2 className="size-3 animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-1 pl-5 text-[0.625rem] text-muted-foreground italic whitespace-pre-wrap leading-relaxed">
          {reasoning}
        </div>
      )}
    </div>
  )
}

/**
 * Shown when a turn ran out of tool steps with work outstanding.
 *
 * Without this the author sees a pile of tool-call cards and no explanation of
 * whether the request actually finished — the edits look complete when they
 * aren't.
 */
export function IncompleteTurnNotice({ msg }: { msg: AssistantMessage }) {
  const [expanded, setExpanded] = useState(false)
  const remaining = (msg.plan?.length ?? 0) - (msg.completedSteps?.length ?? 0)

  return (
    <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[0.625rem]">
      <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3 shrink-0" />
        <span>
          Ran out of tool steps
          {remaining > 0 ? ` — ${remaining} planned step${remaining === 1 ? '' : 's'} not done` : ' before finishing'}.
        </span>
      </div>
      <p className="mt-1 pl-[1.125rem] text-muted-foreground">
        Ask the librarian to continue, or raise Max Steps in story settings.
      </p>
      {msg.plan && msg.plan.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 flex items-center gap-1 pl-[1.125rem] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Its plan
          </button>
          {expanded && (
            <ul className="mt-1 pl-[2rem] space-y-0.5">
              {msg.plan.map((step, i) => {
                const done = i < (msg.completedSteps?.length ?? 0)
                return (
                  <li key={i} className={done ? 'text-muted-foreground line-through' : 'text-foreground/80'}>
                    {done ? '✓ ' : '○ '}{step}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export function AssistantMessageView({ msg, streaming }: { msg: AssistantMessage; streaming: boolean }) {
  // A finished turn with tool calls but nothing said is a failure to report
  // back, not a valid empty answer — never render it as a blank bubble.
  const silentAfterWork = !streaming && !msg.content && !msg.error && (msg.toolCalls?.length ?? 0) > 0

  return (
    <div className="break-words">
      {msg.reasoning && (
        <ReasoningSection reasoning={msg.reasoning} streaming={streaming && !msg.content} />
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div>
          {msg.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tc={tc} />
          ))}
        </div>
      )}
      {msg.content && (
        <StreamMarkdown
          content={msg.content}
          streaming={streaming}
        />
      )}
      {silentAfterWork && !msg.incomplete && (
        <div className="text-[0.625rem] text-muted-foreground italic">
          Made the changes above without a written reply.
        </div>
      )}
      {streaming && !msg.content && !msg.reasoning && (
        <span className="inline-block w-0.5 h-[1em] bg-primary/60 animate-pulse align-text-bottom" />
      )}
      {!streaming && msg.incomplete && <IncompleteTurnNotice msg={msg} />}
      {!streaming && msg.error && (
        <div className="mt-1.5 text-[0.625rem] text-destructive italic">
          {msg.error}
        </div>
      )}
    </div>
  )
}
