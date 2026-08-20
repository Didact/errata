/**
 * Turn an unknown thrown value into something worth showing a person.
 *
 * `String(err)` renders a plain object as the literal `"[object Object]"`, and
 * providers routinely reject with a JSON payload rather than an `Error` — a
 * rate limit, a bad key, a model that doesn't exist. That is exactly how
 * `[object Object]` ends up under a chat message in red, telling the author
 * nothing about what went wrong.
 *
 * Never returns an empty string, and never returns `"[object Object]"`.
 */

const MAX_LENGTH = 300

function truncate(s: string): string {
  return s.length > MAX_LENGTH ? s.slice(0, MAX_LENGTH) + '…' : s
}

/** Providers put the useful status on the envelope, not the message. */
function withStatus(message: string, source: Record<string, unknown>): string {
  const status = source.statusCode ?? source.status
  return typeof status === 'number' ? `${message} (HTTP ${status})` : message
}

export function describeError(err: unknown, depth = 0): string {
  if (typeof err === 'string') {
    return truncate(err.trim()) || 'Unknown error'
  }

  if (err instanceof Error) {
    const message = err.message.trim()
    if (message) return truncate(withStatus(message, err as unknown as Record<string, unknown>))
    // No message: fall through to the object handling below, which can still
    // read a provider's `responseBody` off an APICallError. `err.name` is the
    // last resort, applied at the end — returning it here would short-circuit
    // that branch, since an Error is also an object.
  }

  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>

    // Provider payloads commonly nest one level: { error: { message, type } }.
    if (depth < 3 && o.error !== undefined && o.error !== err) {
      const nested = describeError(o.error, depth + 1)
      if (nested !== 'Unknown error') return truncate(withStatus(nested, o))
    }

    if (typeof o.message === 'string' && o.message.trim()) {
      return truncate(withStatus(o.message.trim(), o))
    }

    // The AI SDK's APICallError keeps the provider's raw reply here.
    if (typeof o.responseBody === 'string' && o.responseBody.trim()) {
      return truncate(withStatus(o.responseBody.trim(), o))
    }

    // An Error that got this far has no message and no provider body. Its name
    // still says something (AbortError, TypeError…) and beats dumping whatever
    // own enumerable properties it happens to carry.
    if (err instanceof Error && err.name) return err.name

    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}' && json !== 'null') return truncate(json)
    } catch {
      // Circular or otherwise unserializable — fall through.
    }
  }

  if (err === null || err === undefined) return 'Unknown error'

  try {
    const asString = String(err)
    // The whole point: never hand this back to the UI.
    return asString === '[object Object]' ? 'Unknown error' : truncate(asString) || 'Unknown error'
  } catch {
    // `String()` throws on a null-prototype object, which has no `toString`.
    return 'Unknown error'
  }
}

/** Wrap an unknown thrown value as an Error without losing its message. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(describeError(err))
}
