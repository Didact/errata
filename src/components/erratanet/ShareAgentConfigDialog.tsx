import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ErratapackManifest } from '@/lib/erratanet/pack-schema'
import { GLOBAL_PACK_ID_REGEX, packPageUrl } from '@/lib/erratanet/pack-schema'
import { slugify, bumpVersion, type BumpKind } from '@/lib/erratanet/publish-utils'
import type { AgentConfigSnapshotResponse } from '@/lib/api/types'
import {
  AgentConfigSelector,
  fullSelection,
  restrictToSurfaces,
  toSelectionPayload,
  selectionIsEmpty,
  selectedScripts,
  type AgentConfigSelectionState,
} from './AgentConfigSelector'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  UploadCloud,
  Loader2,
  Check,
  AlertTriangle,
  X,
  ExternalLink,
  Code2,
} from 'lucide-react'

interface ShareAgentConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  storyId: string
  storyName?: string
  /** Pre-fill the slug to re-publish (sync) an already-shared config. */
  defaultSlug?: string
  /** Pre-select the surfaces a synced config previously bundled. */
  defaultIncludes?: string[]
}

const LICENSES = [
  { value: 'CC0-1.0', label: 'CC0 1.0 (public domain)' },
  { value: 'CC-BY-4.0', label: 'CC BY 4.0 (attribution)' },
  { value: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0 (share-alike)' },
  { value: 'proprietary', label: 'Proprietary (all rights reserved)' },
] as const

const sectionLabel = 'text-[0.5625rem] text-muted-foreground uppercase tracking-[0.15em] font-medium mb-2'

/** Trail the live input so the latest-version lookup isn't fired per keystroke. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/**
 * Publish the current story's agent configuration as a shareable `agent-config`
 * pack. The user picks which surfaces to include; a scripts notice appears when
 * any bundled block is executable (the pack is then flagged "runs code", and
 * importers must review + consent before it applies).
 */
export function ShareAgentConfigDialog({ open, onOpenChange, storyId, storyName, defaultSlug, defaultIncludes }: ShareAgentConfigDialogProps) {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [readme, setReadme] = useState('')
  const [license, setLicense] = useState<string>(LICENSES[1].value)
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public')
  const [bump, setBump] = useState<BumpKind>('patch')
  const [selection, setSelection] = useState<AgentConfigSelectionState>({
    agents: {},
    providers: [],
    modelRoles: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [publishedId, setPublishedId] = useState<string | null>(null)
  const [publishedVersion, setPublishedVersion] = useState<string | null>(null)

  const { data: account } = useQuery({
    queryKey: ['erratanet-account'],
    queryFn: () => api.erratanet.getAccount(),
    enabled: open,
  })
  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
    enabled: open,
  })

  // Snapshot the story's config so we can show what's available + a preview.
  const { data: snapshot, isLoading: loadingSnapshot } = useQuery<AgentConfigSnapshotResponse>({
    queryKey: ['agent-config-snapshot', storyId],
    queryFn: () => api.erratanet.agentConfig.snapshot(storyId),
    enabled: open,
  })

  const handle = account?.handle ?? null
  const available = snapshot?.summary.includes ?? []
  const effectiveSlug = slug.trim() || slugify(title)
  const packId = handle && effectiveSlug ? `@${handle}/${effectiveSlug}` : null
  // Debounced: the slug derives from the live title input, and each new packId
  // is a fresh queryKey — without trailing it, every keystroke hits the hub.
  const debouncedPackId = useDebouncedValue(packId, 400)

  const { data: existingPack } = useQuery({
    queryKey: ['erratanet-pack', debouncedPackId],
    queryFn: async () => {
      if (!debouncedPackId) return null
      try { return await api.erratanet.getPack(debouncedPackId) } catch { return null }
    },
    enabled: open && !!debouncedPackId,
    staleTime: 30_000,
  })
  const latestVersion = existingPack?.version ?? null
  const nextVersion = useMemo(() => bumpVersion(latestVersion, bump), [latestVersion, bump])

  // Reset on open. A defaultSlug means "sync": seed the slug to re-publish the
  // same pack; its metadata is seeded from the published manifest below.
  const seededRef = useRef(false)
  const selectionSeededRef = useRef(false)
  useEffect(() => {
    if (!open) return
    setError(null)
    setPublishedId(null)
    setPublishedVersion(null)
    setSlug(defaultSlug ?? '')
    setTitle(defaultSlug ? '' : storyName ? `${storyName} setup` : '')
    setDescription('')
    setReadme('')
    setTags([])
    setLicense(LICENSES[1].value)
    seededRef.current = false
    selectionSeededRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Default the selection: a synced config restores the surfaces it bundled
  // before; a new share selects everything. Individual blocks can be unpicked.
  // Seeded once per open — the snapshot refetches on window focus (its
  // exportedAt stamp defeats structural sharing), and re-seeding would silently
  // discard the user's deselections right before they publish.
  useEffect(() => {
    if (!open || !snapshot || selectionSeededRef.current) return
    selectionSeededRef.current = true
    const full = fullSelection(snapshot.preview)
    setSelection(defaultIncludes && defaultIncludes.length > 0 ? restrictToSurfaces(full, defaultIncludes) : full)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot, defaultIncludes])

  // On sync, seed metadata from the existing pack's manifest so the update keeps
  // its title, description, tags, license, and readme. Once per open.
  useEffect(() => {
    if (!open || seededRef.current) return
    const manifest = (existingPack as { manifest?: Record<string, unknown> } | null | undefined)?.manifest
    if (!manifest) return
    seededRef.current = true
    if (Array.isArray(manifest.tags)) setTags(manifest.tags.filter((t): t is string => typeof t === 'string'))
    if (typeof manifest.description === 'string' && manifest.description) setDescription(manifest.description)
    if (typeof manifest.license === 'string' && manifest.license) setLicense(manifest.license)
    if (typeof manifest.readme === 'string') setReadme(manifest.readme)
    if (typeof manifest.title === 'string' && manifest.title) setTitle(manifest.title)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingPack])

  // Does the current selection still carry scripts? Only selected script blocks
  // count, so unpicking them drops the "runs code" flag.
  const willHaveScripts = snapshot ? selectedScripts(selection, snapshot.preview).length > 0 : false

  const addTag = useCallback(() => {
    const tag = tagDraft.trim().toLowerCase()
    if (tag && !tags.includes(tag)) setTags((prev) => [...prev, tag])
    setTagDraft('')
  }, [tagDraft, tags])

  const publishMut = useMutation({
    mutationFn: async () => {
      if (!handle) throw new Error('Connect a hub account in Settings first.')
      const cleanSlug = slug.trim() || slugify(title)
      const id = `@${handle}/${cleanSlug}`
      if (!GLOBAL_PACK_ID_REGEX.test(id)) throw new Error('Slug must be lowercase letters, numbers, and dashes.')
      if (!title.trim()) throw new Error('Enter a title.')
      if (description.length > 250) throw new Error('Description must be 250 characters or fewer.')
      if (selectionIsEmpty(selection)) throw new Error('Select at least one part of the configuration.')

      const manifest = {
        errataPack: 1 as const,
        id,
        version: nextVersion,
        title: title.trim(),
        description: description.trim(),
        license,
        // The server derives contentKind, capabilities, the agentConfig summary,
        // fragment fields, and the payload hash from the snapshot.
        contentKind: 'agent-config' as const,
        errataFormatVersion: 1,
        fragmentTypes: [] as string[],
        fragmentCount: 0,
        tags,
        nsfw: false,
        ...(readme.trim() ? { readme: readme.trim() } : {}),
        capabilities: [] as string[],
        dependencies: [] as ErratapackManifest['dependencies'],
        payloadHash: '',
        publisher: `@${handle}`,
        createdAt: new Date().toISOString(),
      } as ErratapackManifest
      return api.erratanet.agentConfig.publish({
        storyId,
        selection: toSelectionPayload(selection),
        manifest,
        unlisted: visibility === 'unlisted',
      })
    },
    onSuccess: (res) => {
      setPublishedId(res.id)
      setPublishedVersion(res.version)
      setError(null)
      qc.invalidateQueries({ queryKey: ['erratanet-pack', debouncedPackId] })
      // The publish stamps provenance on the story; refresh so the panel's
      // "Shared configs" list (and its sync button) picks up the new version.
      qc.invalidateQueries({ queryKey: ['story', storyId] })
      qc.invalidateQueries({ queryKey: ['stories'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Publish failed.'),
  })

  const descOver = description.length > 250
  const nothingToShare = !loadingSnapshot && available.length === 0
  const canPublish =
    !!handle && !!effectiveSlug && !!title.trim() && !descOver && !selectionIsEmpty(selection) && !publishMut.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[88vh] flex flex-col overflow-hidden" data-component-id="share-agent-config-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg flex items-center gap-2">
            <UploadCloud className="size-4 text-muted-foreground" />
            Share agent configuration
          </DialogTitle>
          <DialogDescription>
            Publish how you&apos;ve tuned this story&apos;s agents as a config others can adopt.
          </DialogDescription>
        </DialogHeader>

        {publishedId ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-11 place-items-center rounded-full bg-primary/10">
              <Check className="size-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Shared</p>
              <p className="mt-1 font-mono text-[0.8125rem] text-muted-foreground">{publishedId}</p>
              <p className="mt-1 text-[0.6875rem] text-muted-foreground">version {publishedVersion}</p>
            </div>
            {(() => {
              const url = packPageUrl(config?.hubUrl, publishedId)
              return url ? (
                <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border/40 px-3 py-1.5 text-[0.75rem] text-foreground/80 transition-colors hover:border-border hover:text-foreground">
                  View on ErrataNet
                  <ExternalLink className="size-3.5" />
                </a>
              ) : null
            })()}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-5 py-1 pr-1">
            {!handle && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500/80" />
                <p className="text-[0.6875rem] leading-snug text-amber-600/80 dark:text-amber-400/80">
                  No hub account connected. Sign in from the ErrataNet panel before sharing.
                </p>
              </div>
            )}

            {/* What to include — down to individual agents and blocks. */}
            <div>
              <h4 className={sectionLabel}>Include</h4>
              {loadingSnapshot ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Reading this story&apos;s config…
                </p>
              ) : nothingToShare || !snapshot ? (
                <p className="text-xs text-muted-foreground">
                  This story has no custom agent configuration yet. Tune some blocks, instructions, or
                  model assignments first.
                </p>
              ) : (
                <AgentConfigSelector preview={snapshot.preview} value={selection} onChange={setSelection} />
              )}
            </div>

            {/* Scripts notice */}
            {willHaveScripts && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground">
                  <Code2 className="size-4 text-amber-500" />
                  This config runs code
                </p>
                <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
                  It includes executable script blocks. The pack will be flagged &ldquo;runs code&rdquo;, and
                  importers must review the script source and confirm before it applies.
                </p>
              </div>
            )}

            {/* Slug + title */}
            <div>
              <h4 className={sectionLabel}>Slug</h4>
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground">@{handle ?? 'handle'}/</span>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder={slugify(title) || 'cozy-writer'}
                  className="h-9 font-mono"
                  data-component-id="share-config-slug"
                />
              </div>
            </div>

            <div>
              <h4 className={sectionLabel}>Title</h4>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Cozy Writer" maxLength={120} className="h-9" />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <h4 className={sectionLabel}>Description</h4>
                <span className={cn('text-[0.625rem] tabular-nums', descOver ? 'text-destructive' : 'text-muted-foreground')}>{description.length}/250</span>
              </div>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this configuration is good for…" rows={3} className="text-xs resize-y min-h-16 max-h-40" aria-invalid={descOver} />
            </div>

            <div>
              <h4 className={sectionLabel}>Information</h4>
              <Textarea value={readme} onChange={(e) => setReadme(e.target.value.slice(0, 8000))} placeholder="Setup notes, what it pairs well with, credits… Markdown supported." rows={4} className="text-xs resize-y min-h-20 max-h-56" />
            </div>

            <div>
              <h4 className={sectionLabel}>License</h4>
              <select value={license} onChange={(e) => setLicense(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]">
                {LICENSES.map((l) => (<option key={l.value} value={l.value}>{l.label}</option>))}
              </select>
            </div>

            <div>
              <h4 className={sectionLabel}>Tags</h4>
              {tags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 text-xs">
                      {tag}
                      <button type="button" onClick={() => setTags((p) => p.filter((t) => t !== tag))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${tag}`}>
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
                onBlur={addTag}
                placeholder="Add a tag and press Enter"
                className="h-9"
              />
            </div>

            <div>
              <h4 className={sectionLabel}>Visibility</h4>
              <div className="flex w-fit gap-[3px] rounded-lg bg-muted/25 p-[3px]">
                {(['public', 'unlisted'] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setVisibility(v)} className={cn('rounded-md px-3 py-[6px] text-[0.6875rem] font-medium capitalize transition-all duration-150', visibility === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{v}</button>
                ))}
              </div>
            </div>

            <div>
              <h4 className={sectionLabel}>Version</h4>
              <div className="flex items-center gap-3">
                <div className="flex rounded-lg bg-muted/25 p-[3px] gap-[3px]">
                  {(['patch', 'minor', 'major'] as const).map((kind) => (
                    <button key={kind} type="button" onClick={() => setBump(kind)} className={cn('px-3 py-[6px] rounded-md text-[0.6875rem] font-medium capitalize transition-all duration-150', bump === kind ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{kind}</button>
                  ))}
                </div>
                <span className="font-mono text-sm tabular-nums">{nextVersion}</span>
              </div>
              <p className="mt-1.5 text-[0.625rem] text-muted-foreground">{latestVersion ? `Latest published: ${latestVersion}` : 'New config, starting at 1.0.0'}</p>
            </div>

            <p className="text-[0.625rem] leading-snug text-muted-foreground">
              API keys are never shared. Provider shape carries only the provider name, base URL, and model.
            </p>

            {error && <p className="text-[0.6875rem] text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2 pt-3 border-t border-border/30">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-xs">
            {publishedId ? 'Done' : 'Cancel'}
          </Button>
          {!publishedId && (
            <Button onClick={() => publishMut.mutate()} disabled={!canPublish} className="text-xs gap-1.5" data-component-id="share-config-submit">
              {publishMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
              Share {nextVersion}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
