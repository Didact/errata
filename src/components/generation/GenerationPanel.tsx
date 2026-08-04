import { useState, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useRunStream } from '@/hooks/use-run-stream'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import {
  Panel,
  PanelActions,
  PanelHeader,
  PanelHeaderText,
  PanelTitle,
} from '@/components/ui/panel'
import { DebugPanel } from './DebugPanel'
import { QuestionCard } from './QuestionCard'
import { Send, Eye, Square, Bug, ArrowLeft } from 'lucide-react'
import type { ChatEvent, ClarifyQuestion, Clarification } from '@/lib/api/types'

interface GenerationPanelProps {
  storyId: string
  onBack?: () => void
}

// A round number high enough that the server withholds the ask tool and must
// write — used by "Skip & write" to proceed without answering.
const FORCE_PROCEED_ROUND = 99

export function GenerationPanel({ storyId, onBack }: GenerationPanelProps) {
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [streamedText, setStreamedText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const [pendingQuestions, setPendingQuestions] = useState<ClarifyQuestion[] | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  // Streaming scratch state, kept out of React so a token doesn't cost a render.
  const accumulatedRef = useRef('')
  const askedRef = useRef<ClarifyQuestion[] | null>(null)
  const rafScheduledRef = useRef(false)
  // In-flight generation context, preserved across the clarify round trip.
  const genCtxRef = useRef<{ input: string; saveResult: boolean; clarifications: Clarification[]; round: number }>({
    input: '',
    saveResult: true,
    clarifications: [],
    round: 0,
  })

  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'run-start') {
      accumulatedRef.current = ''
      askedRef.current = null
      return
    }
    if (event.type === 'text') {
      accumulatedRef.current += event.text
    } else if (event.type === 'clarify-questions') {
      askedRef.current = event.questions
    } else if (event.type === 'error') {
      setError(event.error)
      return
    } else {
      return
    }

    if (!rafScheduledRef.current && accumulatedRef.current) {
      rafScheduledRef.current = true
      const snapshot = accumulatedRef.current
      requestAnimationFrame(() => {
        setStreamedText(snapshot)
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
        rafScheduledRef.current = false
      })
    }
  }, [])

  const handleSettled = useCallback(async () => {
    if (askedRef.current) {
      setPendingQuestions(askedRef.current)
      return // wait for the author's answers before finalizing
    }
    setStreamedText(accumulatedRef.current)
    if (genCtxRef.current.saveResult) {
      await queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      await queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
      setInput('')
    }
  }, [queryClient, storyId])

  const run = useRunStream({
    storyId,
    kind: 'generation',
    onEvent: handleEvent,
    onSettled: handleSettled,
  })
  const isGenerating = run.isStreaming

  const runGeneration = useCallback(async (
    genInput: string,
    saveResult: boolean,
    clarifications: Clarification[],
    round: number,
  ) => {
    if (!genInput.trim()) return

    setError(null)
    setPendingQuestions(null)
    if (round === 0) setStreamedText('')
    accumulatedRef.current = ''
    askedRef.current = null
    // Preserve the prompt that started this round so answering/skipping reruns
    // against it, even if the author edits the textarea while questions show.
    genCtxRef.current = { input: genInput, saveResult, clarifications, round }

    try {
      await run.start((clientRequestId) => {
        const opts = { clarifications, clarifyRound: round, clientRequestId }
        return saveResult
          ? api.generation.generateAndSave(storyId, genInput, undefined, opts)
          : api.generation.stream(storyId, genInput, undefined, opts)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    }
  }, [storyId, run])

  const handleGenerate = useCallback((saveResult: boolean) => {
    if (isGenerating) return
    runGeneration(input, saveResult, [], 0)
  }, [isGenerating, runGeneration, input])

  const handleAnswers = useCallback((answers: Clarification[]) => {
    const { input: gi, saveResult, clarifications, round } = genCtxRef.current
    runGeneration(gi, saveResult, [...clarifications, ...answers], round + 1)
  }, [runGeneration])

  const handleSkipQuestions = useCallback(() => {
    const { input: gi, saveResult, clarifications } = genCtxRef.current
    runGeneration(gi, saveResult, clarifications, FORCE_PROCEED_ROUND)
  }, [runGeneration])

  // Stopping is now a server-side cancel, not a local fetch abort: the
  // generation lives on the server, so only the server can end it.
  const handleStop = useCallback(() => {
    void run.cancel()
    setPendingQuestions(null)
  }, [run])

  return (
    <Panel data-component-id="generation-panel-root">
      <PanelHeader>
        <PanelHeaderText>
          <PanelTitle>Generate</PanelTitle>
        </PanelHeaderText>
        <PanelActions>
          <Button
            size="sm"
            variant={showDebug ? 'secondary' : 'ghost'}
            className="h-7 text-xs gap-1"
            onClick={() => setShowDebug(!showDebug)}
            data-component-id="generation-debug-toggle"
          >
            <Bug className="size-3" />
            Debug
          </Button>
          {onBack && (
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onBack} data-component-id="generation-back">
              <ArrowLeft className="size-3" />
              Back
            </Button>
          )}
        </PanelActions>
      </PanelHeader>

      {showDebug ? (
        <DebugPanel
          storyId={storyId}
          onClose={() => setShowDebug(false)}
        />
      ) : (
        <>
          {/* Streaming output area */}
          {streamedText && (
            <>
              <div ref={outputRef} className="flex-1 overflow-auto px-6 py-6" data-component-id="generation-output">
                <div className="max-w-[38rem] mx-auto">
                  <StreamMarkdown content={streamedText} streaming={isGenerating} variant="prose" />
                </div>
              </div>
              <div className="h-px bg-border/30" />
            </>
          )}

          {error && (
            <div className="px-6 py-2 text-sm text-destructive bg-destructive/5 border-b border-border/50">
              {error}
            </div>
          )}

          {/* Clarifying questions from the prewriter */}
          {pendingQuestions && (
            <QuestionCard
              questions={pendingQuestions}
              onSubmit={handleAnswers}
              onCancel={handleSkipQuestions}
              disabled={isGenerating}
            />
          )}

          {/* Input area */}
          <div className="px-6 py-5 space-y-3">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe what should happen next in the story..."
              className="min-h-[80px] resize-none text-sm bg-transparent placeholder:italic placeholder:text-muted-foreground"
              disabled={isGenerating}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  handleGenerate(true)
                }
              }}
              data-component-id="generation-input"
            />
            <div className="flex items-center justify-between">
              <div className="flex gap-1.5">
                {isGenerating ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={handleStop} data-component-id="generation-stop">
                    <Square className="size-3" />
                    Stop
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => handleGenerate(true)}
                      disabled={!input.trim()}
                      data-component-id="generation-submit"
                    >
                      <Send className="size-3" />
                      Generate & Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs gap-1.5 text-muted-foreground"
                      onClick={() => handleGenerate(false)}
                      disabled={!input.trim()}
                      data-component-id="generation-preview"
                    >
                      <Eye className="size-3" />
                      Preview
                    </Button>
                  </>
                )}
              </div>
              <span className="text-[0.625rem] text-muted-foreground">
                Ctrl+Enter to generate & save
              </span>
            </div>
          </div>
        </>
      )}
    </Panel>
  )
}
