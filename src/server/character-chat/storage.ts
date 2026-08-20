import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getContentRoot } from '../fragments/branches'
import { writeJsonAtomic } from '../fs-utils'
import { withKeyLock } from '../async-lock'
import { getRun } from '../runs'

// --- Types ---

export type PersonaMode =
  | { type: 'character'; characterId: string }
  | { type: 'stranger' }
  | { type: 'custom'; prompt: string }

/** Mirrors the librarian's chat turn lifecycle — see `librarian/storage.ts`. */
export type ChatTurnStatus = 'streaming' | 'complete' | 'error' | 'cancelled'

export interface CharacterChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: string
  /** The run that produced (or is producing) this assistant turn. */
  runId?: string
  status?: ChatTurnStatus
  error?: string
}

export interface CharacterChatConversation {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messages: CharacterChatMessage[]
  createdAt: string
  updatedAt: string
}

export interface CharacterChatConversationSummary {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

// --- ID generation ---

export function generateConversationId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `cc-${ts}-${rand}`
}

// --- Path helpers ---

async function characterChatDir(dataDir: string, storyId: string): Promise<string> {
  const root = await getContentRoot(dataDir, storyId)
  return join(root, 'character-chat')
}

async function conversationsDir(dataDir: string, storyId: string): Promise<string> {
  const dir = await characterChatDir(dataDir, storyId)
  return join(dir, 'conversations')
}

async function conversationPath(dataDir: string, storyId: string, conversationId: string): Promise<string> {
  const dir = await conversationsDir(dataDir, storyId)
  return join(dir, `${conversationId}.json`)
}

// --- CRUD ---

export async function saveConversation(
  dataDir: string,
  storyId: string,
  conversation: CharacterChatConversation,
): Promise<void> {
  const dir = await conversationsDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(
    await conversationPath(dataDir, storyId, conversation.id),
    conversation,
  )
}

/** Read the file exactly as stored, with no status reconciliation. */
async function readConversationFile(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<CharacterChatConversation | null> {
  const path = await conversationPath(dataDir, storyId, conversationId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as CharacterChatConversation
}

export async function getConversation(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<CharacterChatConversation | null> {
  const conv = await readConversationFile(dataDir, storyId, conversationId)
  if (!conv) return null

  // A `streaming` turn is only truthful while its run is alive; if the server
  // restarted mid-turn, report it as interrupted rather than perpetually live.
  let changed = false
  const messages = conv.messages.map((m) => {
    if (m.status !== 'streaming') return m
    if (m.runId && getRun(m.runId)?.status === 'running') return m
    changed = true
    return { ...m, status: 'error' as const, error: m.error ?? 'Generation was interrupted' }
  })
  return changed ? { ...conv, messages } : conv
}

/**
 * Append a message to a conversation under a lock, so the user turn, the
 * streaming placeholder, and the final update can't interleave.
 */
export async function appendMessage(
  dataDir: string,
  storyId: string,
  conversationId: string,
  message: CharacterChatMessage,
): Promise<CharacterChatConversation | null> {
  return withKeyLock(`character-chat:${storyId}:${conversationId}`, async () => {
    const conv = await readConversationFile(dataDir, storyId, conversationId)
    if (!conv) return null
    const updated: CharacterChatConversation = {
      ...conv,
      messages: [...conv.messages, message],
      updatedAt: new Date().toISOString(),
    }
    await saveConversation(dataDir, storyId, updated)
    return updated
  })
}

/**
 * Patch an assistant turn in place, addressed by its run id — the character
 * chat equivalent of `updateChatMessageByRunId` in the librarian storage.
 */
export async function updateMessageByRunId(
  dataDir: string,
  storyId: string,
  conversationId: string,
  runId: string,
  patch: Partial<CharacterChatMessage>,
): Promise<CharacterChatConversation | null> {
  return withKeyLock(`character-chat:${storyId}:${conversationId}`, async () => {
    const conv = await readConversationFile(dataDir, storyId, conversationId)
    if (!conv) return null
    const idx = conv.messages.findIndex(m => m.runId === runId)
    if (idx === -1) return conv

    const messages = [...conv.messages]
    messages[idx] = { ...messages[idx], ...patch }
    const updated: CharacterChatConversation = {
      ...conv,
      messages,
      updatedAt: new Date().toISOString(),
    }
    await saveConversation(dataDir, storyId, updated)
    return updated
  })
}

export async function listConversations(
  dataDir: string,
  storyId: string,
  characterId?: string,
): Promise<CharacterChatConversationSummary[]> {
  const dir = await conversationsDir(dataDir, storyId)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const summaries: CharacterChatConversationSummary[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = await readFile(join(dir, entry), 'utf-8')
    const conv = JSON.parse(raw) as CharacterChatConversation

    if (characterId && conv.characterId !== characterId) continue

    summaries.push({
      id: conv.id,
      characterId: conv.characterId,
      persona: conv.persona,
      storyPointFragmentId: conv.storyPointFragmentId,
      title: conv.title,
      messageCount: conv.messages.length,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    })
  }

  // Sort newest first
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

export async function deleteConversation(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<boolean> {
  const path = await conversationPath(dataDir, storyId, conversationId)
  if (!existsSync(path)) return false
  const { unlink } = await import('node:fs/promises')
  await unlink(path)
  return true
}
