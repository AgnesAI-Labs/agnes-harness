import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { ToolContext } from '@agnes/extension-api'

// What each session last saw of each file, so `write` can tell "the file I read" from "a file that
// changed since". A whole-file write composed from a read that is no longer true silently discards
// whatever was changed in between; the check refuses exactly that and nothing else. It is a
// detector of lost updates, not a lock: it never waits, and a file the session has not looked at
// is never refused.
//
// The table lives in this module, like the file-lock chains, so it has the same lifetime as the
// process and is not saved anywhere. After a restart it is empty and the check lets the write
// through, which fails towards "allowed" rather than towards a refusal the model cannot explain.

// The table is bounded: a long session touches many files and each entry is only a short string.
// The least recently recorded one is dropped first, and a dropped entry means "not seen".
export const MAX_OBSERVED_ENTRIES = 4096

const table = new Map<string, string>()

// A path that is no longer there is a version too, so a file that was read and then deleted is
// "changed" like any other. It never collides with a recorded version.
export const ABSENT = 'absent'

const dec = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
const enc = new TextEncoder()

function keyOf(sessionKey: string, abs: string): string {
  return `${sessionKey}\0${abs}`
}

export function observedVersion(sessionKey: string, abs: string): string | undefined {
  return table.get(keyOf(sessionKey, abs))
}

/** Records what `sessionKey` now knows of `abs`; `undefined` forgets it. */
export function observe(sessionKey: string, abs: string, version: string | undefined): void {
  const key = keyOf(sessionKey, abs)
  table.delete(key)
  if (version === undefined) return
  table.set(key, version)
  if (table.size > MAX_OBSERVED_ENTRIES) {
    const oldest = table.keys().next()
    if (!oldest.done) table.delete(oldest.value)
  }
}

// `read` shows the model text, and the real file adapter hands a windowed read back as decoded and
// re-encoded text, so a byte that is not valid UTF-8 comes back as U+FFFD while a plain read of the
// same file returns it untouched. Hashing each side as it arrives would make a file with such a byte
// differ from itself and be refused for ever. Both sides therefore hash the bytes the same
// decode-and-re-encode gives, which is the identity for text and a fixed point for the rest.
function normalized(bytes: Uint8Array): Uint8Array {
  return isUtf8(bytes) ? bytes : enc.encode(dec.decode(bytes))
}

/**
 * The version of `bytes`, which are the content of the file at `path`: the SHA-256 of the text, or,
 * when the content is longer than `hashLimit` bytes, `size:mtimeMs` from the file system. A large
 * file is not hashed because `read` does not return all of it, so the two sides could not agree on
 * a hash. Returns `undefined` when no version can be named (the stat failed, or the name is a
 * symlink, whose stat describes the link and not the file), and the caller then does not check.
 */
export async function versionOf(
  ctx: Pick<ToolContext, 'fs'>,
  path: string,
  bytes: Uint8Array,
  hashLimit: number,
): Promise<string | undefined> {
  const text = normalized(bytes)
  if (text.byteLength <= hashLimit) return `sha256:${createHash('sha256').update(text).digest('hex')}`
  try {
    const st = await ctx.fs.stat(path)
    return st.kind === 'file' ? `stat:${st.size}:${st.mtimeMs}` : undefined
  } catch {
    return undefined
  }
}
