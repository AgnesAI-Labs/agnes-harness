import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  catchUpArtifactRefIndex,
  openArtifactRefIndex,
  REF_INDEX_LOCKED_WAIT_MS,
  verifyRootsUnderLedgerLock,
} from './artifact-ref-index.js'
import { type AttachmentStore, attachmentReceiptFor } from './attachment-store.js'

const MARKER = /^[0-9a-f]{64}\.json$/u
const CACHE_MAP = /^[0-9a-f]{32}\.json$/u
/** The ledger write lock is handed back after this long; what is left waits for the next run. */
const LOCKED_LIMIT_MS = 2_000
const DAY_MS = 24 * 60 * 60 * 1000

export type AttachmentOrphanOptions = Readonly<{
  dataDir: string
  store: AttachmentStore
  /** How long a user attachment nothing references is kept after it was last stored or marked. */
  graceMs: number
  clock?: () => number
  signal?: AbortSignal
}>

/** Every session key the ledger knows, from its session table and its events. */
const SESSION_KEYS = `WITH RECURSIVE live(key) AS (
    SELECT MIN(session_key) FROM events
    UNION ALL SELECT (SELECT MIN(session_key) FROM events WHERE session_key > live.key) FROM live
    WHERE live.key IS NOT NULL)
  SELECT key AS session_key FROM live WHERE key IS NOT NULL
  UNION SELECT session_key FROM sessions`

type CacheMap = Readonly<{ path: string; receipt: string; digests: readonly string[]; mtimeMs: number }>

async function readCacheMaps(root: string): Promise<CacheMap[]> {
  const dir = join(root, 'user-attachment-cache')
  const maps: CacheMap[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!CACHE_MAP.test(name)) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) continue
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      value = undefined
    }
    const digests = Object.values(value && typeof value === 'object' ? value : {}).flatMap((entry) =>
      typeof (entry as { sha256?: unknown } | null)?.sha256 === 'string'
        ? [(entry as { sha256: string }).sha256]
        : [],
    )
    maps.push({ path, receipt: name.slice(0, -5), digests, mtimeMs: info.mtimeMs })
  }
  return maps
}

/**
 * Deletes user attachments nobody needs any more. An object goes only when all of these hold:
 *
 * - it is marked as a user attachment and was last stored or marked longer ago than `graceMs`, so an
 *   upload that is not sent yet, or bytes being queued right now, are kept (both refresh the mark);
 * - no ledger row of any session names it (references, thumbnails, `artifact://` links of the
 *   artifacts seam that shares the tree, request media), checked last while holding the ledger write
 *   lock, so a row written meanwhile is seen;
 * - no session's cache of old inline attachments points at it;
 * - its marker, read once more just before the delete, still says it was not seen since.
 *
 * Bytes that are also a Computer Use screenshot lose only their user-attachment marker; the
 * screenshot collection decides about them from then on. A cache map of a session that no longer
 * exists is removed once it is older than the grace period, and its copies with it. The returned
 * counts are the objects whose bytes were deleted.
 */
export async function collectAttachmentOrphans(
  o: AttachmentOrphanOptions,
): Promise<{ deleted: number; bytes: number }> {
  const none = { deleted: 0, bytes: 0 }
  const clock = o.clock ?? Date.now
  const now = clock()
  const markers = join(o.store.root, 'user-attachment-meta')
  const lastSeen = (marker: { firstSeenMs: number; lastSeenMs?: number }) =>
    Math.max(marker.firstSeenMs, marker.lastSeenMs ?? 0)
  const candidates = new Set<string>()
  for (const shard of await readdir(markers).catch(() => [] as string[]))
    for (const name of await readdir(join(markers, shard)).catch(() => [] as string[])) {
      if (!MARKER.test(name)) continue
      // A damaged marker is left alone: nothing here can tell what it was for.
      const marker = await o.store.userAttachment(name.slice(0, -5)).catch(() => undefined)
      if (marker && now - lastSeen(marker) > o.graceMs) candidates.add(marker.sha256)
    }
  if (candidates.size === 0) return none
  const ledgerFile = join(o.dataDir, 'sessions.db')
  // Without a ledger nothing can be proven unreferenced.
  if (!existsSync(ledgerFile)) return none
  const signal = o.signal ?? new AbortController().signal
  const ledger = new DatabaseSync(ledgerFile)
  const index = await openArtifactRefIndex(o.dataDir).catch((error: unknown) => {
    ledger.close()
    throw error
  })
  try {
    if ((await catchUpArtifactRefIndex({ ledger, index, signal })) !== 'complete') return none
    ledger.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    const locked = performance.now()
    try {
      const roots = await verifyRootsUnderLedgerLock({
        ledger,
        index,
        candidates,
        waitMs: REF_INDEX_LOCKED_WAIT_MS,
      })
      if (!roots || signal.aborted) {
        ledger.exec('ROLLBACK')
        return none
      }
      const live = new Set(
        (ledger.prepare(SESSION_KEYS).all() as Array<{ session_key: string }>).map((row) =>
          attachmentReceiptFor(row.session_key),
        ),
      )
      const stale: string[] = []
      for (const map of await readCacheMaps(o.store.root)) {
        if (!live.has(map.receipt) && now - map.mtimeMs > Math.max(o.graceMs, DAY_MS)) stale.push(map.path)
        else for (const sha256 of map.digests) candidates.delete(sha256)
      }
      let deleted = 0
      let bytes = 0
      for (const sha256 of candidates) {
        if (performance.now() - locked > LOCKED_LIMIT_MS || signal.aborted) break
        if (roots.ledger.has(sha256) || roots.requestMedia.has(sha256)) continue
        // Stored or marked again since the scan above (an upload of the same bytes): kept.
        const marker = await o.store.userAttachment(sha256).catch(() => undefined)
        if (!marker || clock() - lastSeen(marker) <= o.graceMs) continue
        const markerPath = join(markers, sha256.slice(0, 2), `${sha256}.json`)
        if (existsSync(join(o.store.root, 'computer-use-meta', sha256.slice(0, 2), `${sha256}.json`))) {
          await rm(markerPath, { force: true })
          continue
        }
        const object = await o.store.stat(sha256)
        // The bytes first: a marker left behind by a crash here makes the object a candidate again.
        await rm(join(o.store.root, 'sha256', sha256.slice(0, 2), sha256), { force: true })
        await rm(markerPath, { force: true })
        if (object) {
          deleted++
          bytes += object.bytes
        }
      }
      for (const path of stale) await rm(path, { force: true })
      ledger.exec('COMMIT')
      return { deleted, bytes }
    } catch (error) {
      try {
        ledger.exec('ROLLBACK')
      } catch {
        // Preserve the collection failure.
      }
      throw error
    }
  } finally {
    index.close()
    ledger.close()
  }
}

/** Runs the collection once a day, the first time five minutes after start; timers never hold the process. */
export function scheduleAttachmentOrphans(o: AttachmentOrphanOptions & { onError?(error: unknown): void }): {
  close(): void
} {
  const abort = new AbortController()
  let running: Promise<unknown> | undefined
  const run = () => {
    if (running || abort.signal.aborted) return
    running = collectAttachmentOrphans({ ...o, signal: abort.signal })
      .catch((error) => o.onError?.(error))
      .finally(() => {
        running = undefined
      })
  }
  const first = setTimeout(run, 5 * 60_000)
  const daily = setInterval(run, DAY_MS)
  first.unref?.()
  daily.unref?.()
  return {
    close() {
      abort.abort()
      clearTimeout(first)
      clearInterval(daily)
    },
  }
}
