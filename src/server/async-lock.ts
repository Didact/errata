/**
 * Per-key async mutex.
 *
 * Serializes async critical sections that share a key so concurrent callers
 * never interleave a read-modify-write. Used to guard the filesystem
 * read-modify-write paths (prose chain, librarian state/index, token usage)
 * that would otherwise lose updates under concurrent access in a single process.
 *
 * Scope: in-process only. The app is a single Bun process with filesystem
 * storage, so an in-memory lock is sufficient for the races it guards.
 */

const tails = new Map<string, Promise<unknown>>()

/**
 * Run `fn` while holding the lock for `key`. Calls with the same key run one at
 * a time, in arrival order; different keys run concurrently. The lock is always
 * released, even if `fn` (or a previously queued holder) rejects.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  // Chain after the previous holder regardless of whether it resolved or rejected.
  const result = prev.then(fn, fn)
  // The tail settles (never rejects) when this holder is done, so the next
  // caller waits for us without inheriting our rejection.
  const tail = result.then(
    () => {},
    () => {},
  )
  tails.set(key, tail)
  // Drop the entry once we're the last holder, to keep the map from growing.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
