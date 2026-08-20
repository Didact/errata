import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { consumeRun } from '@/lib/api/runs'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ProseActionInputProps {
  storyId: string
  fragmentId: string
  mode: 'regenerate' | 'refine'
  onComplete: () => void
  onCancel: () => void
  onStreamStart: () => void
  onStream: (text: string) => void
}

export function ProseActionInput({
  storyId,
  fragmentId,
  mode,
  onComplete,
  onCancel,
  onStreamStart,
  onStream,
}: ProseActionInputProps) {
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isLoading) return

    setIsLoading(true)
    setError(null)
    onStreamStart()

    try {
      const stream = mode === 'regenerate'
        ? await api.generation.regenerate(storyId, fragmentId, input)
        : await api.generation.refine(storyId, fragmentId, input)

      let accumulated = ''
      const result = await consumeRun(storyId, stream, (event) => {
        if (event.type === 'text') {
          accumulated += event.text
          onStream(accumulated)
        }
      })

      if (result.status === 'error') {
        setError(result.error ?? 'Operation failed')
        return
      }

      await queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      await queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setIsLoading(false)
    }
  }, [input, isLoading, storyId, fragmentId, mode, queryClient, onComplete, onStreamStart, onStream])

  const placeholder = mode === 'regenerate'
    ? 'New direction...'
    : 'How to refine...'

  return (
    <div className="mt-3 rounded-lg border border-primary/15 bg-card/30 p-4" data-component-id="prose-action-root">
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder}
        className="min-h-[56px] max-h-[120px] resize-none text-sm bg-transparent border-border/40 placeholder:italic placeholder:text-muted-foreground"
        disabled={isLoading}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onCancel()
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            handleSubmit()
          }
        }}
        data-component-id="prose-action-input"
      />
      {error && (
        <p className="text-sm text-destructive mt-2">{error}</p>
      )}
      <div className="flex items-center justify-between mt-2.5">
        <span className="text-[0.625rem] text-muted-foreground">
          Esc to cancel &middot; Ctrl+Enter to submit
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={isLoading} data-component-id="prose-action-cancel">
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={!input.trim() || isLoading} data-component-id="prose-action-submit">
            {isLoading
              ? (mode === 'regenerate' ? 'Regenerating...' : 'Refining...')
              : (mode === 'regenerate' ? 'Regenerate' : 'Refine')
            }
          </Button>
        </div>
      </div>
    </div>
  )
}
