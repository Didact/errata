import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ChatEvent, type ChatHistory } from '@/lib/api'
import { useRunStream } from '@/hooks/use-run-stream'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Send, Loader2, Square, PlugZap } from 'lucide-react'
import { EmptyHint } from '@/components/ui/prose-text'
import {
  AssistantMessageView,
  type AssistantMessage,
  type ChatMessage,
} from '@/components/chat/ChatMessageParts'

function toLocalChatMessage(m: ChatHistory['messages'][number]): ChatMessage {
  if (m.role === 'assistant') {
    return {
      role: 'assistant' as const,
      content: m.content,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.toolCalls?.length
        ? {
            toolCalls: m.toolCalls.map((tc, i) => ({
              id: `${i}`,
              toolName: tc.toolName,
              args: tc.args,
              result: tc.result,
              ...(tc.error ? { error: tc.error } : {}),
            })),
          }
        : {}),
      ...(m.error ? { error: m.error } : {}),
    }
  }
  return { role: 'user' as const, content: m.content }
}

/** Fold a live run event into the assistant message being built. */
function applyEvent(msg: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case 'text':
      return { ...msg, content: msg.content + event.text }
    case 'reasoning':
      return { ...msg, reasoning: (msg.reasoning ?? '') + event.text }
    case 'tool-call':
      return {
        ...msg,
        toolCalls: [...(msg.toolCalls ?? []), { id: event.id, toolName: event.toolName, args: event.args ?? {} }],
      }
    case 'tool-result':
      return {
        ...msg,
        toolCalls: (msg.toolCalls ?? []).map(tc => tc.id === event.id ? { ...tc, result: event.result } : tc),
      }
    case 'tool-error':
      return {
        ...msg,
        toolCalls: (msg.toolCalls ?? []).map(tc => tc.id === event.id ? { ...tc, error: event.error } : tc),
      }
    case 'error':
      return { ...msg, error: event.error }
    default:
      return msg
  }
}

interface LibrarianChatProps {
  storyId: string
  conversationId?: string | null
  initialInput?: string
}

export function LibrarianChat({ storyId, conversationId, initialInput }: LibrarianChatProps) {
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const initialInputAppliedRef = useRef<string | null>(null)
  const prevConversationIdRef = useRef<string | null | undefined>(undefined)
  /** The assistant turn currently being streamed, kept outside React state. */
  const liveRef = useRef<AssistantMessage | null>(null)

  // Query key depends on whether we're in a conversation or legacy chat
  const historyQueryKey = conversationId
    ? ['librarian-conversation-history', storyId, conversationId]
    : ['librarian-chat-history', storyId]

  const refreshHistory = useCallback(async () => {
    const refreshed = await queryClient.fetchQuery({
      queryKey: historyQueryKey,
      queryFn: () => conversationId
        ? api.librarian.getConversationHistory(storyId, conversationId)
        : api.librarian.getChatHistory(storyId),
    })
    setMessages(refreshed.messages.map(toLocalChatMessage))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, storyId, conversationId])

  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'run-start') {
      // A run we attached to (rather than started) has no local placeholder yet.
      liveRef.current = { role: 'assistant', content: '' }
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant') return prev
        return [...prev, { role: 'assistant', content: '' }]
      })
      return
    }
    if (event.type === 'run-end') return

    const next = applyEvent(liveRef.current ?? { role: 'assistant', content: '' }, event)
    liveRef.current = next
    setMessages(prev => {
      const copy = [...prev]
      if (copy[copy.length - 1]?.role === 'assistant') copy[copy.length - 1] = next
      else copy.push(next)
      return copy
    })
  }, [])

  const handleSettled = useCallback(async (status: string, message?: string) => {
    liveRef.current = null
    if (message) setError(message)
    // The server is the record of what happened; replace local state with it
    // rather than trusting the events we happened to receive.
    try {
      await refreshHistory()
    } catch {
      // Keep the streamed view if the refetch fails.
    }
    await queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
    if (conversationId) {
      await queryClient.invalidateQueries({ queryKey: ['librarian-conversations', storyId] })
    }
    void status
  }, [refreshHistory, queryClient, storyId, conversationId])

  const run = useRunStream({
    storyId,
    kind: 'librarian.chat',
    scopeId: conversationId ?? null,
    onEvent: handleEvent,
    onSettled: handleSettled,
  })
  const isStreaming = run.isStreaming

  // Reset state when conversationId changes
  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId
      setMessages([])
      setLoaded(false)
      setError(null)
      liveRef.current = null
    }
  }, [conversationId])

  // Apply initial input when it changes or when component becomes visible
  useEffect(() => {
    if (initialInput && initialInput !== initialInputAppliedRef.current) {
      setInput(initialInput)
      initialInputAppliedRef.current = initialInput
      // Focus the textarea after setting input
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 0)
    }
  })

  // Load persisted chat history on mount
  const { data: chatHistory } = useQuery({
    queryKey: historyQueryKey,
    queryFn: () => conversationId
      ? api.librarian.getConversationHistory(storyId, conversationId)
      : api.librarian.getChatHistory(storyId),
    staleTime: Infinity,
  })

  useEffect(() => {
    if (chatHistory && !loaded && !isStreaming) {
      if (chatHistory.messages.length > 0) {
        setMessages(chatHistory.messages.map(toLocalChatMessage))
      }
      setLoaded(true)
    }
  }, [chatHistory, loaded, isStreaming])

  const isNearBottomRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Track whether user is near the bottom of the scroll area
  useEffect(() => {
    const scrollArea = messagesEndRef.current?.closest('[data-radix-scroll-area-viewport]')
    if (!scrollArea) return
    const handleScroll = () => {
      const threshold = 80
      isNearBottomRef.current = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < threshold
    }
    scrollArea.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollArea.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll only when already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom()
    }
  }, [messages, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [input])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')
    setError(null)

    // Optimistically show the user turn and a placeholder for the reply. Both
    // are replaced by the server's record once the run settles.
    liveRef.current = { role: 'assistant', content: '' }
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])

    try {
      await run.start((clientRequestId) => conversationId
        ? api.librarian.conversationChat(storyId, conversationId, text, clientRequestId)
        : api.librarian.chat(storyId, text, clientRequestId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed')
      // The user turn is persisted server-side before generation starts, so
      // refetch to show exactly what survived.
      await refreshHistory().catch(() => {})
    } finally {
      textareaRef.current?.focus()
    }
  }, [input, isStreaming, storyId, conversationId, run, refreshHistory])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className="flex flex-col h-full" data-component-id="librarian-chat-root">
      {/* Messages area */}
      <ScrollArea className="flex-1 min-h-0" data-component-id="librarian-chat-scroll">
        <div className="p-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-component-id="librarian-chat-empty">
              <EmptyHint className="max-w-[240px]">
                Ask the librarian to make changes across your story — update characters, adjust guidelines, or reshape knowledge.
              </EmptyHint>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={`${msg.role}-${i}`}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                  msg.role === 'user'
                    ? 'bg-primary/10 text-foreground'
                    : 'bg-card/50 border border-border/30 text-foreground/80'
                }`}
              >
                {msg.role === 'assistant' ? (
                  <AssistantMessageView
                    msg={msg}
                    streaming={isStreaming && i === messages.length - 1}
                  />
                ) : (
                  <div className="break-words whitespace-pre-wrap">{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {/* The run keeps going on the server; this is only about our link to it. */}
          {run.isReconnecting && (
            <div
              className="flex items-center gap-1.5 text-[0.625rem] text-muted-foreground italic"
              data-component-id="librarian-chat-reconnecting"
            >
              <PlugZap className="size-3 shrink-0" />
              Reconnecting — the librarian is still working.
            </div>
          )}

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 rounded-md p-2">
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t border-border/30 p-3 space-y-2">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the librarian..."
            disabled={isStreaming}
            className="min-h-[40px] max-h-[400px] resize-none text-xs bg-transparent placeholder:italic placeholder:text-muted-foreground flex-1"
            rows={1}
            data-component-id="librarian-chat-input"
          />
          {isStreaming && (
            <Button
              size="icon"
              variant="outline"
              className="size-8 shrink-0"
              onClick={() => { void run.cancel() }}
              title="Stop the librarian"
              data-component-id="librarian-chat-stop"
            >
              <Square className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            className="size-8 shrink-0"
            disabled={!input.trim() || isStreaming}
            onClick={handleSend}
            data-component-id="librarian-chat-send"
          >
            {isStreaming ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </Button>
        </div>

        <p className="text-[0.625rem] text-muted-foreground text-center">
          Enter to send, Shift+Enter for newline
        </p>
      </div>
    </div>
  )
}
