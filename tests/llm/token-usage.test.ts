import { describe, expect, it } from 'vitest'
import { normalizeTokenUsage } from '@/server/llm/usage-normalizer'
import { getSessionUsage, reportUsage } from '@/server/llm/token-tracker'

describe('normalizeTokenUsage', () => {
  it('normalizes AI SDK v6 totalUsage', () => {
    expect(normalizeTokenUsage({ inputTokens: 12, outputTokens: 8 })).toEqual({
      inputTokens: 12,
      outputTokens: 8,
    })
  })

  it('normalizes OpenAI-compatible usage fields', () => {
    expect(normalizeTokenUsage({ prompt_tokens: 21, completion_tokens: 13 })).toEqual({
      inputTokens: 21,
      outputTokens: 13,
    })
  })

  it('ignores non-finite token values', () => {
    expect(normalizeTokenUsage({ inputTokens: Number.NaN, outputTokens: 9 })).toEqual({
      inputTokens: 0,
      outputTokens: 9,
    })
  })
})

describe('reportUsage', () => {
  it('does not let invalid token values poison counters', () => {
    const storyId = `story-token-usage-${Date.now()}`

    reportUsage(
      'unused-data-dir',
      storyId,
      'test.source',
      { inputTokens: Number.NaN, outputTokens: 12 },
      'test-model',
    )

    expect(getSessionUsage(storyId).total).toEqual({
      inputTokens: 0,
      outputTokens: 12,
      calls: 1,
    })
  })
})
