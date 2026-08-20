import { describe, it, expect } from 'vitest'
import { toProviderMessages } from '@/server/routes/librarian'
import type { ChatHistoryMessage } from '@/server/librarian/storage'

/**
 * What the model is shown of its own past turns.
 *
 * Getting this wrong is how a single blank reply turns into a conversation
 * that never answers again, and how a turn's edits become invisible to the
 * turn that follows it.
 */
describe('toProviderMessages', () => {
  it('never emits empty assistant content', () => {
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: '', status: 'complete' },
      { role: 'user', content: 'and another' },
    ]
    const sent = toProviderMessages(history)
    expect(sent.every(m => m.content.trim().length > 0)).toBe(true)
    expect(sent[1].content).toContain('No reply was recorded')
  })

  it('replays the edits a silent turn actually made', () => {
    // Persisting the turn isn't enough — if the next turn can't see the tool
    // calls, the model redoes them.
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: 'update Alice' },
      {
        role: 'assistant',
        content: '',
        status: 'complete',
        toolCalls: [{ toolName: 'updateFragment', args: { id: 'ch-alice' }, result: { ok: true } }],
      },
    ]
    const sent = toProviderMessages(history)
    expect(sent[1].content).toContain('Already applied this turn')
    expect(sent[1].content).toContain('updateFragment')
    expect(sent[1].content).toContain('ch-alice')
  })

  it('keeps the model from claiming an interrupted turn finished', () => {
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: 'do five things' },
      {
        role: 'assistant',
        content: '',
        status: 'error',
        error: 'Generation was interrupted',
        toolCalls: [{ toolName: 'updateFragment', args: { id: 'ch-1' }, result: { ok: true } }],
      },
    ]
    const sent = toProviderMessages(history)
    expect(sent[1].content).toContain('ended early')
    expect(sent[1].content).toContain('updateFragment')
  })

  it('truncates a huge tool argument instead of replaying a whole fragment', () => {
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: 'rewrite it' },
      {
        role: 'assistant',
        content: 'Done.',
        toolCalls: [{ toolName: 'updateFragment', args: { content: 'x'.repeat(5000) }, result: {} }],
      },
    ]
    const sent = toProviderMessages(history)
    expect(sent[1].content.length).toBeLessThan(600)
    expect(sent[1].content).toContain('…')
    expect(sent[1].content).toContain('Done.')
  })

  it('leaves an ordinary turn alone apart from its tool summary', () => {
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there.', status: 'complete' },
    ]
    expect(toProviderMessages(history)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there.' },
    ])
  })
})
