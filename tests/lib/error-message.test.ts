import { describe, it, expect } from 'vitest'
import { describeError, toError } from '@/server/error-message'

/**
 * The reason this exists: a provider rejected with a JSON payload rather than
 * an Error, `String()` rendered it as the literal "[object Object]", and that
 * string travelled all the way to a red line under a chat message.
 */
describe('describeError', () => {
  it('never returns [object Object], whatever it is handed', () => {
    const nasty: unknown[] = [
      {},
      { foo: 'bar' },
      Object.create(null),
      [],
      new Map(),
      { toString: () => '[object Object]' },
    ]
    for (const value of nasty) {
      const out = describeError(value)
      expect(out).not.toBe('[object Object]')
      expect(out.trim().length).toBeGreaterThan(0)
    }
  })

  it('reads a provider payload that nests the message', () => {
    // The shape OpenAI-compatible APIs actually return.
    expect(describeError({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }))
      .toContain('Rate limit exceeded')
  })

  it('keeps the status code, which is usually the actionable part', () => {
    expect(describeError({ statusCode: 429, error: { message: 'Slow down' } }))
      .toBe('Slow down (HTTP 429)')
  })

  it('reads the AI SDK APICallError shape', () => {
    const apiErr = Object.assign(new Error(''), {
      name: 'AI_APICallError',
      statusCode: 401,
      responseBody: '{"error":"invalid api key"}',
    })
    // A message-less Error still carries the provider's reply; returning just
    // the name would throw away the only useful part.
    const out = describeError(apiErr)
    expect(out).toContain('invalid api key')
    expect(out).toContain('401')
  })

  it('falls back to the name when a message-less Error carries nothing else', () => {
    expect(describeError(Object.assign(new Error(''), { name: 'AbortError' }))).toBe('AbortError')
  })

  it('uses a plain Error message', () => {
    expect(describeError(new Error('connection reset'))).toBe('connection reset')
  })

  it('passes strings through', () => {
    expect(describeError('just a string')).toBe('just a string')
  })

  it('handles null, undefined, and empties', () => {
    expect(describeError(null)).toBe('Unknown error')
    expect(describeError(undefined)).toBe('Unknown error')
    expect(describeError('')).toBe('Unknown error')
    expect(describeError('   ')).toBe('Unknown error')
  })

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const out = describeError(circular)
    expect(out).not.toBe('[object Object]')
    expect(out.length).toBeGreaterThan(0)
  })

  it('truncates instead of dumping a whole response body under a message', () => {
    expect(describeError({ message: 'x'.repeat(5000) }).length).toBeLessThan(320)
  })

  it('falls back to JSON when there is no message field', () => {
    expect(describeError({ code: 'ENOTFOUND', host: 'api.example.com' }))
      .toContain('ENOTFOUND')
  })
})

describe('toError', () => {
  it('passes an Error through untouched', () => {
    const e = new Error('original')
    expect(toError(e)).toBe(e)
  })

  it('wraps a provider payload with a readable message', () => {
    const wrapped = toError({ error: { message: 'model not found' }, statusCode: 404 })
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped.message).toBe('model not found (HTTP 404)')
  })

  it('never produces an [object Object] message', () => {
    expect(toError({}).message).not.toBe('[object Object]')
  })
})
