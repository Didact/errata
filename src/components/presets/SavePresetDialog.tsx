import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Fragment } from '@/lib/api'
import { serializeBundle } from '@/lib/fragment-clipboard'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AlertCircle, Loader2 } from 'lucide-react'

interface SavePresetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedFragments: Fragment[]
  mediaById: Map<string, Fragment>
  storyName?: string
}

const sectionLabel = 'text-[0.5625rem] text-muted-foreground uppercase tracking-[0.15em] font-medium mb-2'

export function SavePresetDialog({ open, onOpenChange, selectedFragments, mediaById, storyName }: SavePresetDialogProps) {
  const qc = useQueryClient()
  const [name, setName] = useState(storyName ?? '')
  const [description, setDescription] = useState('')

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Presets never carry block/agent configuration — that's the same trust
      // boundary the ref-aware bundle import already enforces server-side.
      const bundle = JSON.parse(serializeBundle(selectedFragments, mediaById, storyName))
      return api.presets.create({
        name: name.trim(),
        description: description.trim() || undefined,
        sourceStoryName: storyName,
        bundle,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets'] })
      onOpenChange(false)
      setName(storyName ?? '')
      setDescription('')
    },
  })

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) saveMutation.reset() }}>
      <DialogContent className="sm:max-w-[440px]" data-component-id="save-preset-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">Save as preset</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Saves the {selectedFragments.length} selected fragment{selectedFragments.length !== 1 ? 's' : ''} as a
            reusable, named preset. Presets copy fragments into a new story — editing a copy never touches this
            preset, and context configuration is not included.
          </p>

          <div>
            <h4 className={sectionLabel}>Name</h4>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Noir Detective Cast"
              autoFocus
              className="h-9"
              data-component-id="save-preset-name"
            />
          </div>

          <div>
            <h4 className={sectionLabel}>Description</h4>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about this preset..."
              rows={3}
              className="text-xs resize-none"
              data-component-id="save-preset-description"
            />
          </div>

          {saveMutation.isError && (
            <div className="flex items-start gap-2 text-xs text-destructive/80 bg-destructive/5 rounded-md px-3 py-2">
              <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
              <span>{saveMutation.error instanceof Error ? saveMutation.error.message : 'Failed to save preset'}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 pt-3 border-t border-border/30">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-xs" data-component-id="save-preset-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!name.trim() || selectedFragments.length === 0 || saveMutation.isPending}
            className="text-xs gap-1.5"
            data-component-id="save-preset-submit"
          >
            {saveMutation.isPending && <Loader2 className="size-3 animate-spin" />}
            Save preset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
