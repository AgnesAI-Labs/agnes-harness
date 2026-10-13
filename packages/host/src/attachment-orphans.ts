import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  catchUpArtifactRefIndex,
  openArtifactRefIndex,
  verifyRootsUnderLedgerLockNow,
} from './artifact-ref-index.js'
import { type AttachmentStore, attachmentReceiptFor, parseUserAttachmentMarker } from './attachment-store.js'

const MARKER = /^[0-9a-f]{64}\.json$/u
const CACHE_MAP = /^[0-9a-f]{32}\.json$/u
/**
 * Objects decided per hold of the ledger write lock, and the longest one hold may take: every hold is
 * synchronous, so these bound how long the event loop and other processes' ledger writes wait.
 */
const BATCH_OBJECTS = 64
const BATCH_MS = 50
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

/** How long a restore or a batch waits for the ledger write lock before leaving its work to later. */
const LEDGER_LOCK_WAIT_MS = 10_000

const isBusy = (error: unknown) => {
  const e = error as { errcode?: unknown; message?: unknown } | null
  return e?.errcode === 5 || e?.errcode === 6 || /database is (locked|busy)/u.test(String(e?.message))
}

/**
 * Takes the ledger write lock without blocking the event loop while another holder (a run of this
 * process among them) finishes; false when it is still held after `waitMs`.
 */
async function lockLedger(ledger: DatabaseSync, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  const until = performance.now() + waitMs
  ledger.exec('PRAGMA busy_timeout=0')
  for (;;) {
    try {
      ledger.exec('BEGIN IMMEDIATE')
      return true
    } catch (error) {
      if (!isBusy(error)) throw error
      if (performance.now() >= until || signal?.aborted) return false
      await new Promise((done) => setTimeout(done, 25))
    }
  }
}

/**
 * Bytes a run set aside and never decided about (it crashed) go back where they were. A run holds the
 * ledger write lock from setting bytes aside until it has decided about them, so this takes the same
 * lock: what it finds aside then is never what a live run (of this or another process) is still
 * deciding about. The moves are synchronous, so the lock is never held across a turn of the event
 * loop that a ledger write of this process would have to wait out. Resolves false when the lock could
 * not be had; the bytes then wait for the next attempt.
 */
export async function restoreSetAsideAttachments(o: {
  dataDir: string
  root: string
  signal?: AbortSignal
}): Promise<boolean> {
  const sweeping = join(o.root, 'sweeping')
  if ((await readdir(sweeping).catch(() => [] as string[])).length === 0) return true
  const ledgerFile = join(o.dataDir, 'sessions.db')
  // Only a run that found a ledger sets bytes aside.
  if (!existsSync(ledgerFile)) return true
  const ledger = new DatabaseSync(ledgerFile)
  try {
    if (!(await lockLedger(ledger, LEDGER_LOCK_WAIT_MS, o.signal))) return false
    try {
      for (const name of readdirSync(sweeping)) {
        const match = /^([0-9a-f]{64})\.[0-9a-f-]+$/u.exec(name)
        if (!match?.[1]) continue
        const sha256 = match[1]
        const objectPath = join(o.root, 'sha256', sha256.slice(0, 2), sha256)
        if (existsSync(objectPath)) rmSync(join(sweeping, name), { force: true })
        else {
          mkdirSync(dirname(objectPath), { recursive: true, mode: 0o700 })
          renameSync(join(sweeping, name), objectPath)
        }
      }
    } finally {
      ledger.exec('ROLLBACK')
    }
    return true
  } finally {
    ledger.close()
  }
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
 * screenshot collection decides about them from then on. Bytes the artifacts seam stored that only
 * something outside the ledger keeps a reference to (no row, request header or screenshot marker
 * names them) cannot be told apart: if they equal an orphaned user attachment, they go with it, as
 * they would with the screenshot collection. A cache map of a session that no longer
 * exists is removed once it is older than the grace period, and its copies with it. The returned
 * counts are the objects whose bytes were deleted.
 *
 * Objects are decided in small batches, each under its own hold of the ledger write lock in which
 * nothing awaits (the roots are proven, then each object judged and deleted, synchronously); the lock
 * is handed back and the event loop runs between batches, so a ledger write of this process never
 * waits for the collection, and another process's waits at most one batch.
 */
export async function collectAttachmentOrphans(
  o: AttachmentOrphanOptions,
): Promise<{ deleted: number; bytes: number }> {
  return collectAttachmentOrphansInternal(o)
}

/** The marker as the store reads it, read synchronously; undefined when it is absent or damaged. */
function markerNow(markers: string, sha256: string) {
  const path = join(markers, sha256.slice(0, 2), `${sha256}.json`)
  try {
    const text = readFileSync(path, 'utf8')
    const seenMs = Math.floor(statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0)
    return parseUserAttachmentMarker(text, sha256, seenMs)
  } catch {
    return undefined
  }
}

/** The collection with a test seam: `afterSetAside` runs, synchronously, once bytes are set aside. */
export async function collectAttachmentOrphansInternal(
  o: AttachmentOrphanOptions & { afterSetAside?(sha256: string): void },
): Promise<{ deleted: number; bytes: number }> {
  const none = { deleted: 0, bytes: 0 }
  const clock = o.clock ?? Date.now
  const now = clock()
  const markers = join(o.store.root, 'user-attachment-meta')
  const sweeping = join(o.store.root, 'sweeping')
  const restored = await restoreSetAsideAttachments({
    dataDir: o.dataDir,
    root: o.store.root,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  if (!restored) return none
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
  // A cache map written after this read names bytes its session has just marked, so the marker
  // judged under the lock keeps them.
  const maps = await readCacheMaps(o.store.root)
  const ledger = new DatabaseSync(ledgerFile)
  const index = await openArtifactRefIndex(o.dataDir).catch((error: unknown) => {
    ledger.close()
    throw error
  })
  let deleted = 0
  let bytes = 0
  let first = true
  try {
    while (candidates.size > 0 && !signal.aborted) {
      if ((await catchUpArtifactRefIndex({ ledger, index, signal })) !== 'complete') break
      if (!(await lockLedger(ledger, LEDGER_LOCK_WAIT_MS, signal))) break
      // From here to the end of the batch nothing awaits: the lock is handed back before this process
      // runs anything else, so a ledger write of this process never waits for the collection.
      const locked = performance.now()
      try {
        const roots = verifyRootsUnderLedgerLockNow({ ledger, index, candidates })
        if (!roots || signal.aborted) {
          ledger.exec('ROLLBACK')
          break
        }
        if (first) {
          first = false
          const live = new Set(
            (ledger.prepare(SESSION_KEYS).all() as Array<{ session_key: string }>).map((row) =>
              attachmentReceiptFor(row.session_key),
            ),
          )
          for (const map of maps) {
            if (!live.has(map.receipt) && now - map.mtimeMs > Math.max(o.graceMs, DAY_MS))
              rmSync(map.path, { force: true })
            else for (const sha256 of map.digests) candidates.delete(sha256)
          }
        }
        let decided = 0
        for (const sha256 of candidates) {
          if (decided >= BATCH_OBJECTS || performance.now() - locked > BATCH_MS) break
          decided++
          candidates.delete(sha256)
          if (roots.ledger.has(sha256) || roots.requestMedia.has(sha256)) continue
          // Stored or marked again since the scan above (an upload of the same bytes): kept.
          const marker = markerNow(markers, sha256)
          if (!marker || clock() - lastSeen(marker) <= o.graceMs) continue
          const markerPath = join(markers, sha256.slice(0, 2), `${sha256}.json`)
          if (existsSync(join(o.store.root, 'computer-use-meta', sha256.slice(0, 2), `${sha256}.json`))) {
            rmSync(markerPath, { force: true })
            continue
          }
          const objectPath = join(o.store.root, 'sha256', sha256.slice(0, 2), sha256)
          const object = statSync(objectPath, { throwIfNoEntry: false })
          if (object?.isFile()) {
            // The bytes are moved aside first and the marker judged once more. A send touches the
            // marker before it checks the bytes, so either it finds them gone and refuses, or this
            // finds the marker fresh and puts them back: a reference never lands on deleted bytes.
            const aside = join(sweeping, `${sha256}.${randomUUID()}`)
            mkdirSync(sweeping, { recursive: true, mode: 0o700 })
            renameSync(objectPath, aside)
            o.afterSetAside?.(sha256)
            const again = markerNow(markers, sha256)
            if (again && clock() - lastSeen(again) <= o.graceMs) {
              renameSync(aside, objectPath)
              continue
            }
            // The bytes before the marker: a marker left behind by a crash makes them a candidate again.
            rmSync(aside, { force: true })
            deleted++
            bytes += object.size
          }
          rmSync(markerPath, { force: true })
        }
        ledger.exec('COMMIT')
      } catch (error) {
        try {
          ledger.exec('ROLLBACK')
        } catch {
          // Preserve the collection failure.
        }
        throw error
      }
      // The event loop runs between batches.
      await new Promise((done) => setImmediate(done))
    }
    return { deleted, bytes }
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
