import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ChatEvent, type Fragment } from '@/lib/api'
import { useRunStream } from '@/hooks/use-run-stream'
import type { PersonaMode, CharacterChatConversationSummary } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Send, Loader2 } from 'lucide-react'
import { Caption, EmptyHint } from '@/components/ui/prose-text'
import {
  AssistantMessageView,
  type AssistantMessage,
  type ChatMessage,
} from '@/components/chat/ChatMessageParts'
import { CharacterAvatar } from '@/components/shared/CharacterAvatar'
import { ChatConfig } from './ChatConfig'
import { ConversationList } from './ConversationList'

interface CharacterChatViewProps {
  storyId: string
  initialCharacterId?: string | null
  onClose: () => void
}

export function CharacterChatView({ storyId, initialCharacterId, onClose }: CharacterChatViewProps) {
  const queryClient = useQueryClient()

  // Config state
  const [characterId, setCharacterId] = useState<string | null>(initialCharacterId ?? null)
  const [persona, setPersona] = useState<PersonaMode>({ type: 'stranger' })
  const [storyPointId, setStoryPointId] = useState<string | null>(null)

  // Conversation state
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showConversations, setShowConversations] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** The assistant turn currently streaming, kept outside React state. */
  const liveRef = useRef<AssistantMessage | null>(null)
  /** Mirrors `conversationId` for callbacks that must not re-bind mid-run. */
  const conversationIdRef = useRef<string | null>(null)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])

  // Data queries
  const { data: allFragments } = useQuery({
    queryKey: ['fragments', storyId],
    queryFn: () => api.fragments.list(storyId),
  })

  const { data: proseChain } = useQuery({
    queryKey: ['prose-chain', storyId],
    queryFn: () => api.proseChain.get(storyId),
  })

  const characters = (allFragments ?? []).filter((f) => f.type === 'character')
  const proseFragments = (allFragments ?? []).filter((f) => f.type === 'prose')

  // Build media lookup for character portraits
  const mediaById = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const f of allFragments ?? []) {
      if (f.type === 'image' || f.type === 'icon') map.set(f.id, f)
    }
    return map
  }, [allFragments])

  // Auto-select first character if none selected
  useEffect(() => {
    if (!characterId && characters.length > 0) {
      setCharacterId(characters[0].id)
    }
  }, [characterId, characters])

  const selectedCharacter = characters.find((c) => c.id === characterId)

  // Scroll to bottom on new messages (only if already near bottom)
  const isNearBottomRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

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

  // Handle character change — reset conversation
  const handleCharacterChange = useCallback((id: string) => {
    setCharacterId(id)
    setConversationId(null)
    setMessages([])
    setError(null)
  }, [])

  // Start new conversation
  const startNewConversation = useCallback(() => {
    setConversationId(null)
    setMessages([])
    setError(null)
    setShowConversations(false)
    textareaRef.current?.focus()
  }, [])

  // Resume a conversation
  const resumeConversation = useCallback(async (conv: CharacterChatConversationSummary) => {
    try {
      const full = await api.characterChat.getConversation(storyId, conv.id)
      setCharacterId(full.characterId)
      setPersona(full.persona)
      setStoryPointId(full.storyPointFragmentId)
      setConversationId(full.id)
      setMessages(full.messages.map((m) => {
        if (m.role === 'assistant') {
          return {
            role: 'assistant' as const,
            content: m.content,
            ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          }
        }
        return { role: 'user' as const, content: m.content }
      }))
      setError(null)
      setShowConversations(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation')
    }
  }, [storyId])

  /** Fold a live run event into the assistant turn being built. */
  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'run-start') {
      liveRef.current = { role: 'assistant', content: '' }
      setMessages(prev => prev[prev.length - 1]?.role === 'assistant'
        ? prev
        : [...prev, { role: 'assistant', content: '' }])
      return
    }
    if (event.type === 'run-end') return

    const current = liveRef.current ?? { role: 'assistant' as const, content: '' }
    let next: AssistantMessage = current
    switch (event.type) {
      case 'text':
        next = { ...current, content: current.content + event.text }
        break
      case 'reasoning':
        next = { ...current, reasoning: (current.reasoning ?? '') + event.text }
        break
      case 'tool-call':
        next = {
          ...current,
          toolCalls: [...(current.toolCalls ?? []), { id: event.id, toolName: event.toolName, args: event.args ?? {} }],
        }
        break
      case 'tool-result':
        next = {
          ...current,
          toolCalls: (current.toolCalls ?? []).map(tc => tc.id === event.id ? { ...tc, result: event.result } : tc),
        }
        break
      case 'tool-error':
        next = {
          ...current,
          toolCalls: (current.toolCalls ?? []).map(tc => tc.id === event.id ? { ...tc, error: event.error } : tc),
        }
        break
      case 'error':
        next = { ...current, error: event.error }
        break
      default:
        return
    }

    liveRef.current = next
    setMessages(prev => {
      const copy = [...prev]
      if (copy[copy.length - 1]?.role === 'assistant') copy[copy.length - 1] = next
      else copy.push(next)
      return copy
    })
  }, [])

  const handleSettled = useCallback(async (_status: string, message?: string) => {
    liveRef.current = null
    if (message) setError(message)
    // The server owns the transcript — reload it rather than trusting what we
    // happened to receive.
    const convId = conversationIdRef.current
    if (convId) {
      try {
        const conv = await api.characterChat.getConversation(storyId, convId)
        setMessages(conv.messages.map((m): ChatMessage => m.role === 'assistant'
          ? {
              role: 'assistant',
              content: m.content,
              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
              ...(m.error ? { error: m.error } : {}),
            }
          : { role: 'user', content: m.content }))
      } catch {
        // Keep the streamed view if the reload fails.
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['character-chat-conversations', storyId] })
  }, [storyId, queryClient])

  const run = useRunStream({
    storyId,
    kind: 'character-chat',
    scopeId: conversationId,
    onEvent: handleEvent,
    onSettled: handleSettled,
  })
  const isStreaming = run.isStreaming

  // Send a message
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming || !characterId) return

    setInput('')
    setError(null)

    liveRef.current = { role: 'assistant', content: '' }
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])

    try {
      // Create conversation on first message if needed
      let activeConvId = conversationId
      if (!activeConvId) {
        const conv = await api.characterChat.createConversation(storyId, {
          characterId,
          persona,
          storyPointFragmentId: storyPointId,
        })
        activeConvId = conv.id
        setConversationId(conv.id)
      }
      conversationIdRef.current = activeConvId

      // Only the new message goes over the wire; the server holds the rest.
      await run.start((clientRequestId) =>
        api.characterChat.chat(storyId, activeConvId, text, clientRequestId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed')
    } finally {
      textareaRef.current?.focus()
    }
  }, [input, isStreaming, characterId, conversationId, storyId, persona, storyPointId, run])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className="flex flex-col h-full relative" data-component-id="character-chat-view">
      {/* Config bar */}
      <ChatConfig
        characters={characters}
        selectedCharacterId={characterId}
        onCharacterChange={handleCharacterChange}
        persona={persona}
        onPersonaChange={setPersona}
        proseChain={proseChain ?? null}
        proseFragments={proseFragments}
        storyPointId={storyPointId}
        onStoryPointChange={setStoryPointId}
        onShowConversations={() => setShowConversations(true)}
        onClose={onClose}
        disabled={isStreaming}
        mediaById={mediaById}
      />

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" data-component-id="character-chat-scroll">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          {/* Empty state */}
          {messages.length === 0 && selectedCharacter && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
              <CharacterAvatar character={selectedCharacter} mediaById={mediaById} size="lg" />
              <div>
                <h3 className="font-display text-xl tracking-tight mb-1">
                  {selectedCharacter.name}
                </h3>
                <Caption className="italic max-w-[280px]">
                  {selectedCharacter.description}
                </Caption>
              </div>
              <p className="text-[0.6875rem] text-muted-foreground max-w-[240px] leading-relaxed">
                Start a conversation. The character will respond in their voice, knowing only the story events up to your selected point.
              </p>
            </div>
          )}

          {/* No character selected */}
          {messages.length === 0 && !selectedCharacter && characters.length > 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <EmptyHint>
                Select a character to begin.
              </EmptyHint>
            </div>
          )}

          {/* No characters in story */}
          {characters.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <EmptyHint className="max-w-[240px]">
                Create character fragments in your story first, then return here to chat with them.
              </EmptyHint>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, i) => {
            const isFirstAssistantInGroup = msg.role === 'assistant' && (i === 1 || (i > 0 && messages[i - 1]?.role === 'user'))
            return (
              <div
                key={`${msg.role}-${i}`}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${
                  isFirstAssistantInGroup ? 'items-start gap-2.5' : msg.role === 'assistant' ? 'pl-[34px]' : ''
                }`}
              >
                {isFirstAssistantInGroup && selectedCharacter && (
                  <CharacterAvatar character={selectedCharacter} mediaById={mediaById} size="sm" />
                )}
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-2.5 text-[0.8125rem] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-primary/8 text-foreground'
                      : 'bg-card/60 border border-border/20 text-foreground/85'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div>
                      {isFirstAssistantInGroup && (
                        <div className="font-display text-[0.6875rem] text-primary/50 mb-1 tracking-wide">
                          {selectedCharacter?.name}
                        </div>
                      )}
                      <div className="font-prose">
                        <AssistantMessageView
                          msg={msg}
                          streaming={isStreaming && i === messages.length - 1}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="break-words whitespace-pre-wrap">{msg.content}</div>
                  )}
                </div>
              </div>
            )
          })}

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 rounded-lg p-3">
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border/20 bg-card/20">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                selectedCharacter
                  ? `Say something to ${selectedCharacter.name}...`
                  : 'Select a character first...'
              }
              disabled={isStreaming || !characterId}
              className="min-h-[44px] max-h-[400px] resize-none text-[0.8125rem] bg-transparent
                placeholder:italic placeholder:text-muted-foreground flex-1 border-border/30
                focus-visible:ring-primary/20"
              rows={1}
              data-component-id="character-chat-input"
            />
            <Button
              size="icon"
              className="size-9 shrink-0"
              disabled={!input.trim() || isStreaming || !characterId}
              onClick={handleSend}
              data-component-id="character-chat-send"
            >
              {isStreaming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>

          <p className="text-[0.625rem] text-muted-foreground text-center mt-2">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>

      {/* Conversation list overlay */}
      {showConversations && (
        <ConversationList
          storyId={storyId}
          characterId={characterId}
          characters={characters}
          mediaById={mediaById}
          onSelect={resumeConversation}
          onNew={startNewConversation}
          onClose={() => setShowConversations(false)}
        />
      )}
    </div>
  )
}
