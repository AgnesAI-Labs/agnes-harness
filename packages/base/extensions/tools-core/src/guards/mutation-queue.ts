// One queue per file, so that two writers to the same file inside one process cannot interleave
// their read-modify-write. Both a `write` and an `edit` read the current content before deciding
// what to put back, and two of them running at once each decide against content the other is about
// to replace: the truncation guard is satisfied by a state that no longer exists, and whichever
// finishes last silently wins.
//
// The key has to be the file, not the string the caller wrote. This queue is in-process only; two
// processes writing one file are held apart by the sandbox's write domain and the shadow git
// checkpoint, not by this map.

const chains = new Map<string, Promise<unknown>>()

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // Both settlements continue the chain: a writer that failed must not stall the queue behind it.
  const next = prev.then(fn, fn)
  // What the next writer waits on never rejects, and the cleanup hangs off that same swallowing
  // promise rather than off `next`. Chaining the cleanup onto `next` would create a second
  // rejection with no handler, and an unhandled rejection ends the process on a failure the caller
  // already dealt with.
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, settled)
  void settled.then(() => {
    // Only if nothing has queued behind this one; otherwise the later writer's chain is dropped and
    // the serialization it was promised is gone.
    if (chains.get(key) === settled) chains.delete(key)
  })
  return next
}
