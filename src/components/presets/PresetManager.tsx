import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type StoryPresetMeta } from '@/lib/api'
import { parseErrataExport, downloadExportFile, readFileAsText, type FragmentBundleData } from '@/lib/fragment-clipboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyHint, Hint } from '@/components/ui/prose-text'
import { Check, Download, Pencil, Trash2, Upload, X } from 'lucide-react'

function relativeDate(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso)
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function countsSummary(counts: Record<string, number>): string {
  const order = ['character', 'guideline', 'knowledge']
  const parts = order
    .filter((type) => counts[type] > 0)
    .map((type) => `${counts[type]} ${type}${counts[type] !== 1 ? 's' : ''}`)
  return parts.join(', ') || 'empty'
}

function PresetRow({ preset }: { preset: StoryPresetMeta }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(preset.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['presets'] })

  const renameMutation = useMutation({
    mutationFn: (newName: string) => api.presets.update(preset.id, { name: newName }),
    onSuccess: () => { invalidate(); setEditing(false) },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.presets.delete(preset.id),
    onSuccess: invalidate,
  })

  const handleDownload = useCallback(async () => {
    const { bundle } = await api.presets.get(preset.id)
    const safeName = preset.name.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40)
    downloadExportFile(JSON.stringify(bundle, null, 2), `errata-preset-${safeName}.json`)
  }, [preset.id, preset.name])

  return (
    <div className="flex items-center gap-2 py-1.5" data-component-id={`preset-row-${preset.id}`}>
      {editing ? (
        <>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 text-sm flex-1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) renameMutation.mutate(name.trim())
              if (e.key === 'Escape') { setEditing(false); setName(preset.name) }
            }}
            data-component-id={`preset-rename-input-${preset.id}`}
          />
          <Button size="icon" variant="ghost" className="size-6 shrink-0" disabled={!name.trim() || renameMutation.isPending} onClick={() => renameMutation.mutate(name.trim())}>
            <Check className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-6 shrink-0" onClick={() => { setEditing(false); setName(preset.name) }}>
            <X className="size-3.5" />
          </Button>
        </>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">{preset.name}</p>
            <p className="text-[0.6875rem] text-muted-foreground truncate">
              {countsSummary(preset.countsByType)} · {relativeDate(preset.createdAt)}
            </p>
          </div>
          {confirmingDelete ? (
            <>
              <span className="text-[0.6875rem] text-muted-foreground shrink-0">Delete?</span>
              <Button size="sm" variant="destructive" className="h-6 text-[0.6875rem] px-2 shrink-0" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                Delete
              </Button>
              <Button size="icon" variant="ghost" className="size-6 shrink-0" onClick={() => setConfirmingDelete(false)}>
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground" onClick={handleDownload} title="Download .json">
                <Download className="size-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground" onClick={() => setEditing(true)} title="Rename">
                <Pencil className="size-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => setConfirmingDelete(true)} title="Delete">
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
        </>
      )}
    </div>
  )
}

export function PresetManager() {
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['presets'],
    queryFn: api.presets.list,
  })

  const importMutation = useMutation({
    mutationFn: async (text: string) => {
      const parsed = parseErrataExport(text)
      if (!parsed) throw new Error('Not a valid Errata fragment export')
      if (parsed._errata === 'fragment') {
        const bundle: FragmentBundleData = {
          _errata: 'fragment-bundle',
          version: 1,
          source: parsed.source,
          exportedAt: parsed.exportedAt,
          fragments: [{ ...parsed.fragment, attachments: parsed.attachments }],
        }
        return api.presets.create({ name: parsed.fragment.name, bundle: bundle as unknown as Record<string, unknown> })
      }
      return api.presets.create({
        name: parsed.storyName || 'Imported preset',
        bundle: parsed as unknown as Record<string, unknown>,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets'] })
      setImportError(null)
    },
    onError: (err) => {
      setImportError(err instanceof Error ? err.message : 'Failed to import preset')
    },
  })

  const handleFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await readFileAsText(file)
    importMutation.mutate(text)
  }, [importMutation])

  const presets = data?.presets ?? []

  return (
    <div className="space-y-2">
      {isLoading && <Hint>Loading presets...</Hint>}
      {!isLoading && presets.length === 0 && (
        <EmptyHint>No presets yet. Save a selection of fragments as a preset from any story's export panel.</EmptyHint>
      )}
      {presets.length > 0 && (
        <div className="divide-y divide-border/20">
          {presets.map((preset) => <PresetRow key={preset.id} preset={preset} />)}
        </div>
      )}

      {importError && (
        <p className="text-[0.6875rem] text-destructive/80">{importError}</p>
      )}

      <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileInput} />
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs gap-1.5 w-full"
        onClick={() => fileInputRef.current?.click()}
        disabled={importMutation.isPending}
        data-component-id="preset-manager-import"
      >
        <Upload className="size-3.5" />
        Import preset from file
      </Button>
    </div>
  )
}
