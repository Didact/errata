import { useState } from 'react'
import type { AgentConfigPreview, AgentConfigSelection } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { Check, Minus, ChevronRight, Code2 } from 'lucide-react'

/**
 * Controlled selection over an agent-config preview, down to individual blocks.
 * Shared by the share dialog (what to publish) and the import view (what to
 * apply). The shape mirrors the server's filter input: `agents` maps an agent
 * name to its included block ids (key present = agent included).
 */
export interface AgentConfigSelectionState {
  agents: Record<string, string[]>
  providers: string[]
  modelRoles: string[]
}

type Tri = 'on' | 'off' | 'partial'

const SURFACE_LABEL: Record<string, string> = {
  agents: 'Context & agent blocks',
  providers: 'Provider shape',
  modelRoles: 'Model assignments',
}

/** Humanize an agent name for display ('character-chat' -> 'character chat'). */
function humanize(name: string): string {
  return name.replace(/[-_]+/g, ' ')
}

const blockIdsOf = (preview: AgentConfigPreview, agent: string): string[] =>
  preview.agents.find((a) => a.name === agent)?.blocks.map((b) => b.id) ?? []

/** Everything in the preview, selected. The default for a fresh share/import. */
export function fullSelection(preview: AgentConfigPreview): AgentConfigSelectionState {
  return {
    agents: Object.fromEntries(preview.agents.map((a) => [a.name, a.blocks.map((b) => b.id)])),
    providers: preview.providerShapes.map((p) => p.name),
    modelRoles: preview.modelRoles.map((r) => r.role),
  }
}

/** Keep only the surfaces named (e.g. restoring what a synced config bundled). */
export function restrictToSurfaces(
  state: AgentConfigSelectionState,
  surfaces: string[],
): AgentConfigSelectionState {
  const want = new Set(surfaces)
  return {
    agents: want.has('agent-blocks') ? state.agents : {},
    providers: want.has('provider-shape') ? state.providers : [],
    modelRoles: want.has('model-roles') ? state.modelRoles : [],
  }
}

export function toSelectionPayload(state: AgentConfigSelectionState): AgentConfigSelection {
  return {
    agentBlocks: state.agents,
    providerShapes: state.providers,
    modelRoles: state.modelRoles,
  }
}

export function selectionIsEmpty(state: AgentConfigSelectionState): boolean {
  return (
    Object.keys(state.agents).length === 0 &&
    state.providers.length === 0 &&
    state.modelRoles.length === 0
  )
}

/** Scripts that survive the current selection (for the import consent gate). */
export function selectedScripts(
  state: AgentConfigSelectionState,
  preview: AgentConfigPreview,
): AgentConfigPreview['scripts'] {
  return preview.scripts.filter((s) => state.agents[s.agent]?.includes(s.blockId))
}

/** A 14px tri-state checkbox: check / dash / empty. */
function TriCheck({ state, className }: { state: Tri; className?: string }) {
  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded border transition-colors',
        state === 'off' ? 'border-border' : 'border-primary bg-primary text-primary-foreground',
        className,
      )}
    >
      {state === 'on' ? <Check className="size-3" /> : state === 'partial' ? <Minus className="size-3" /> : null}
    </span>
  )
}

function ScriptTag() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 font-mono text-[0.5625rem] text-amber-600 dark:text-amber-400">
      <Code2 className="size-2.5" /> script
    </span>
  )
}

function flatTri(selected: string[], all: string[]): Tri {
  if (selected.length === 0) return 'off'
  return selected.length >= all.length ? 'on' : 'partial'
}

export function AgentConfigSelector({
  preview,
  value,
  onChange,
}: {
  preview: AgentConfigPreview
  value: AgentConfigSelectionState
  onChange: (next: AgentConfigSelectionState) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (agent: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(agent) ? next.delete(agent) : next.add(agent)
      return next
    })

  // --- agent / block toggles ---
  const agentTri = (agent: string): Tri => {
    const sel = value.agents[agent]
    if (!sel) return 'off'
    const all = blockIdsOf(preview, agent)
    return sel.length >= all.length ? 'on' : 'partial'
  }

  const toggleAgent = (agent: string) => {
    const next = { ...value.agents }
    if (agentTri(agent) === 'on') delete next[agent]
    else next[agent] = blockIdsOf(preview, agent)
    onChange({ ...value, agents: next })
  }

  const toggleBlock = (agent: string, blockId: string) => {
    const cur = value.agents[agent]
    const next = { ...value.agents }
    if (!cur) next[agent] = [blockId]
    else if (cur.includes(blockId)) {
      const remaining = cur.filter((id) => id !== blockId)
      // Unchecking the last block excludes the agent entirely; a lingering
      // empty entry would still ship its overrides/disabled tools.
      if (remaining.length === 0) delete next[agent]
      else next[agent] = remaining
    } else next[agent] = [...cur, blockId]
    onChange({ ...value, agents: next })
  }

  const agentsTri: Tri = (() => {
    if (preview.agents.length === 0) return 'off'
    const states = preview.agents.map((a) => agentTri(a.name))
    if (states.every((s) => s === 'on')) return 'on'
    if (states.every((s) => s === 'off')) return 'off'
    return 'partial'
  })()

  const toggleAllAgents = () => {
    if (agentsTri === 'on') onChange({ ...value, agents: {} })
    else onChange({ ...value, agents: Object.fromEntries(preview.agents.map((a) => [a.name, blockIdsOf(preview, a.name)])) })
  }

  // --- flat-surface toggles ---
  const flatToggleAll = (key: 'providers' | 'modelRoles', all: string[]) => {
    const tri = flatTri(value[key], all)
    onChange({ ...value, [key]: tri === 'on' ? [] : all })
  }
  const flatToggleItem = (key: 'providers' | 'modelRoles', item: string) => {
    const cur = value[key]
    onChange({ ...value, [key]: cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item] })
  }

  const providerNames = preview.providerShapes.map((p) => p.name)
  const roleKeys = preview.modelRoles.map((r) => r.role)

  return (
    <div className="space-y-3">
      {/* Agent blocks */}
      {preview.agents.length > 0 && (
        <div className="rounded-md border border-border/40">
          <SurfaceHeader
            tri={agentsTri}
            label={SURFACE_LABEL.agents}
            count={`${preview.agents.length} ${preview.agents.length === 1 ? 'agent' : 'agents'}`}
            onToggle={toggleAllAgents}
          />
          <div className="divide-y divide-border/30 border-t border-border/30">
            {preview.agents.map((agent) => {
              const sel = value.agents[agent.name] ?? []
              const isOpen = expanded.has(agent.name)
              const hasScript = agent.blocks.some((b) => b.type === 'script')
              return (
                <div key={agent.name}>
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    <button type="button" onClick={() => toggleAgent(agent.name)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <TriCheck state={agentTri(agent.name)} />
                      <span className="truncate text-[0.8125rem]">{humanize(agent.displayName)}</span>
                      {hasScript && <ScriptTag />}
                    </button>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground tabular-nums">
                      {agent.blocks.length > 0
                        ? `${sel.length}/${agent.blocks.length} blocks`
                        : `${agent.overrideCount} overrides`}
                    </span>
                    {agent.blocks.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(agent.name)}
                        className="grid size-5 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                      >
                        <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
                      </button>
                    )}
                  </div>
                  {isOpen && agent.blocks.length > 0 && (
                    <ul className="space-y-0.5 pb-2 pl-9 pr-2.5">
                      {agent.blocks.map((b) => (
                        <li key={b.id}>
                          <button
                            type="button"
                            onClick={() => toggleBlock(agent.name, b.id)}
                            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent/30"
                          >
                            <TriCheck state={sel.includes(b.id) ? 'on' : 'off'} />
                            <span className="truncate text-[0.75rem]">{b.name}</span>
                            <span className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">{b.role}</span>
                            {b.type === 'script' && <ScriptTag />}
                            {!b.enabled && <span className="text-[0.5625rem] text-muted-foreground">off</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Provider shape */}
      {preview.providerShapes.length > 0 && (
        <FlatSurface
          label={SURFACE_LABEL.providers}
          tri={flatTri(value.providers, providerNames)}
          onToggleAll={() => flatToggleAll('providers', providerNames)}
          items={preview.providerShapes.map((p) => ({
            key: p.name,
            on: value.providers.includes(p.name),
            label: p.name,
            // Show the base URL: it is published with the pack, so the user
            // must see it before consenting (private endpoints leak otherwise).
            hint: p.baseURL ? `${p.defaultModel} · ${p.baseURL}` : p.defaultModel,
          }))}
          onToggleItem={(name) => flatToggleItem('providers', name)}
        />
      )}

      {/* Model assignments */}
      {preview.modelRoles.length > 0 && (
        <FlatSurface
          label={SURFACE_LABEL.modelRoles}
          tri={flatTri(value.modelRoles, roleKeys)}
          onToggleAll={() => flatToggleAll('modelRoles', roleKeys)}
          items={preview.modelRoles.map((r) => ({
            key: r.role,
            on: value.modelRoles.includes(r.role),
            label: humanize(r.role),
            hint: r.model ?? undefined,
          }))}
          onToggleItem={(role) => flatToggleItem('modelRoles', role)}
        />
      )}
    </div>
  )
}

function SurfaceHeader({
  tri,
  label,
  count,
  onToggle,
}: {
  tri: Tri
  label: string
  count: string
  onToggle: () => void
}) {
  return (
    <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
      <TriCheck state={tri} />
      <span className="flex-1 text-[0.8125rem]">{label}</span>
      <span className="text-[0.625rem] text-muted-foreground tabular-nums">{count}</span>
    </button>
  )
}

function FlatSurface({
  label,
  tri,
  onToggleAll,
  items,
  onToggleItem,
}: {
  label: string
  tri: Tri
  onToggleAll: () => void
  items: { key: string; on: boolean; label: string; hint?: string }[]
  onToggleItem: (key: string) => void
}) {
  return (
    <div className="rounded-md border border-border/40">
      <SurfaceHeader tri={tri} label={label} count={`${items.length}`} onToggle={onToggleAll} />
      <ul className="divide-y divide-border/30 border-t border-border/30">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onToggleItem(item.key)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/20"
            >
              <TriCheck state={item.on ? 'on' : 'off'} />
              <span className="truncate text-[0.75rem]">{item.label}</span>
              {item.hint && <span className="ml-auto shrink-0 truncate font-mono text-[0.625rem] text-muted-foreground">{item.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
