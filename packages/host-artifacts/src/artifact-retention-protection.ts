import type { DatabaseSync } from 'node:sqlite'
import { extractArtifactRefs } from './artifact-ledger-refs.js'
import {
  cached,
  laneText,
  REF_INDEX_LOCKED_BUDGET,
  REF_INDEX_LOCKED_WAIT_MS,
  type SessionActivity,
  withIndexTransaction,
} from './artifact-ref-index.js'

/** The newest image-bearing tool results a request can send; always protected as a whole. */
const NODE_WINDOW = 3

export type ProtectionSettings = Readonly<{ nowMs: number; ttlMs: number; maxRecent: number }>
type Boundary = Readonly<{ sessionKey: string; seq: number; id: string; digest: string | null }>
export type AncestorProtection = Readonly<{ boundary: Boundary; digests: ReadonlySet<string> }>
export type RetentionProtection = Readonly<{
  digests: ReadonlySet<string>
  ancestors: ReadonlyMap<string, AncestorProtection>
}>

/**
 * Sessions that must keep their recent screenshots, judged only from durable facts other
 * processes can see: an open op whose writer lease is still live, or an event newer than `ttlMs`.
 */
function activeSessions(
  ledger: DatabaseSync,
  activity: ReadonlyMap<string, SessionActivity>,
  settings: ProtectionSettings,
): Set<string> {
  const active = new Set<string>()
  for (const [key, seen] of activity) if (seen.lastTsMs > settings.nowMs - settings.ttlMs) active.add(key)
  const leases = new Map(
    (
      cached(ledger, 'SELECT session_key, until FROM writer_claims').all() as Array<{
        session_key: string
        until: number
      }>
    ).map((row) => [row.session_key, row.until]),
  )
  const open = cached(
    ledger,
    "SELECT DISTINCT session_key FROM registers WHERE register = 'op.state' AND data IS NOT NULL AND data <> 'null'",
  ).all() as Array<{ session_key: string }>
  for (const { session_key: key } of open)
    if ((leases.get(key) ?? Number.NEGATIVE_INFINITY) > settings.nowMs) active.add(key)
  return active
}

/** Digests of the newest `NODE_WINDOW` image rows, plus the newest `maxRecent` candidates. */
function selectRecent(
  latestSeq: ReadonlyMap<string, number>,
  candidates: ReadonlySet<string>,
  maxRecent: number,
): Set<string> {
  const newestSeqs = new Set([...new Set(latestSeq.values())].sort((a, b) => b - a).slice(0, NODE_WINDOW))
  const out = new Set<string>()
  for (const [digest, seq] of latestSeq) if (newestSeqs.has(seq) && candidates.has(digest)) out.add(digest)
  const ranked = [...latestSeq]
    .filter(([digest]) => candidates.has(digest))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [digest] of ranked.slice(0, maxRecent)) out.add(digest)
  return out
}

/** Every ancestor a session can see, with the highest seq it sees there (inclusive, per edge). */
function ancestry(ledger: DatabaseSync, sessionKey: string): Array<Readonly<{ key: string; upTo: number }>> {
  const statement = cached(ledger, 'SELECT parent_key, boundary_seq FROM sessions WHERE session_key = ?')
  const out: Array<{ key: string; upTo: number }> = []
  const seen = new Set([sessionKey])
  let upTo = Number.MAX_SAFE_INTEGER
  let current = sessionKey
  for (;;) {
    const row = statement.get(current) as
      | { parent_key: string | null; boundary_seq: number | null }
      | undefined
    if (!row?.parent_key || row.boundary_seq === null || seen.has(row.parent_key)) return out
    upTo = Math.min(upTo, row.boundary_seq)
    out.push({ key: row.parent_key, upTo })
    seen.add(row.parent_key)
    current = row.parent_key
  }
}

function boundaryRow(ledger: DatabaseSync, key: string, seq: number): Boundary | undefined {
  const row = cached(ledger, 'SELECT id, integrity_digest FROM events WHERE session_key = ? AND seq = ?').get(
    key,
    seq,
  ) as { id: string; integrity_digest: string | null } | undefined
  return row ? { sessionKey: key, seq, id: row.id, digest: row.integrity_digest } : undefined
}

/**
 * An ancestor's protected screenshots, read backwards from what the child can see. It reads the
 * rows themselves, not the index, because the index keeps only each digest's newest occurrence
 * and that may lie past the fork point.
 */
function ancestorDigests(
  ledger: DatabaseSync,
  key: string,
  upTo: number,
  candidates: ReadonlySet<string>,
  maxRecent: number,
): Set<string> {
  const rows = cached(
    ledger,
    `SELECT seq, type, lane, origin, trust, data FROM events
     WHERE session_key = ? AND type = 'tool/result' AND seq <= ? ORDER BY seq DESC`,
  ).iterate(key, upTo) as Iterable<{
    seq: number
    type: string
    lane: Uint8Array | string
    origin: string
    trust: string
    data: string
  }>
  const latestSeq = new Map<string, number>()
  let nodes = 0
  let read = 0
  let bytes = 0
  for (const row of rows) {
    read += 1
    bytes += row.data.length
    if (read > REF_INDEX_LOCKED_BUDGET.rows || bytes > REF_INDEX_LOCKED_BUDGET.bytes) break
    const images = extractArtifactRefs({ ...row, lane: laneText(row.lane) }).toolImage
    if (images.size === 0) continue
    nodes += 1
    for (const digest of images) if (!latestSeq.has(digest)) latestSeq.set(digest, row.seq)
    const found = [...latestSeq.keys()].filter((digest) => candidates.has(digest)).length
    if (nodes >= NODE_WINDOW && found >= maxRecent) break
  }
  return selectRecent(latestSeq, candidates, maxRecent)
}

async function ownLatestSeqs(
  index: DatabaseSync,
  sessions: ReadonlySet<string>,
  waitMs?: number,
): Promise<Map<string, Map<string, number>>> {
  return withIndexTransaction(
    index,
    () => {
      const statement = cached(
        index,
        `SELECT sha256, last_tool_image_seq AS seq FROM artifact_ref
         WHERE session_key = ? AND source = 'ledger' AND last_tool_image_seq IS NOT NULL`,
      )
      return new Map(
        [...sessions].map((key) => [
          key,
          new Map(
            (statement.all(key) as Array<{ sha256: string; seq: number }>).map((row) => [
              row.sha256,
              row.seq,
            ]),
          ),
        ]),
      )
    },
    waitMs,
  )
}

function protect(
  ledger: DatabaseSync,
  active: ReadonlySet<string>,
  own: ReadonlyMap<string, ReadonlyMap<string, number>>,
  activity: ReadonlyMap<string, SessionActivity>,
  candidates: ReadonlySet<string>,
  settings: ProtectionSettings,
  /** `null` skips an ancestor that has no boundary row; `undefined` abandons the whole computation. */
  ancestorFor: (key: string, upTo: number) => AncestorProtection | null | undefined,
): RetentionProtection | undefined {
  const digests = new Set<string>()
  const ancestors = new Map<string, AncestorProtection>()
  for (const key of active) {
    const latestSeq = new Map(own.get(key) ?? [])
    for (const node of activity.get(key)?.toolImages ?? [])
      for (const digest of node.digests) latestSeq.set(digest, Math.max(latestSeq.get(digest) ?? 0, node.seq))
    for (const digest of selectRecent(latestSeq, candidates, settings.maxRecent)) digests.add(digest)
    for (const { key: ancestor, upTo } of ancestry(ledger, key)) {
      const found = ancestorFor(ancestor, upTo)
      if (found === undefined) return undefined
      if (found === null) continue
      ancestors.set(`${ancestor}\u0000${upTo}`, found)
      for (const digest of found.digests) digests.add(digest)
    }
  }
  return { digests, ancestors }
}

/** Plans the protected set on a read-only ledger connection, before any lock is taken. */
export async function planRetentionProtection(
  input: Readonly<{
    ledger: DatabaseSync
    index: DatabaseSync
    activity: ReadonlyMap<string, SessionActivity>
    candidates: ReadonlySet<string>
    settings: ProtectionSettings
  }>,
): Promise<RetentionProtection> {
  const { ledger, index, activity, candidates, settings } = input
  input.ledger.exec('BEGIN')
  try {
    const active = activeSessions(ledger, activity, settings)
    const own = await ownLatestSeqs(index, active)
    const protection = protect(ledger, active, own, activity, candidates, settings, (key, upTo) => {
      const boundary = boundaryRow(ledger, key, upTo)
      return boundary
        ? { boundary, digests: ancestorDigests(ledger, key, upTo, candidates, settings.maxRecent) }
        : null
    })
    return protection ?? { digests: new Set(), ancestors: new Map() }
  } finally {
    ledger.exec('COMMIT')
  }
}

/**
 * Recomputes the protected set while the caller holds the ledger write lock. Ancestor prefixes
 * are append-only, so a planned ancestor is reused once its boundary row still matches; a changed
 * boundary returns undefined and the caller abandons the batch.
 */
export async function recomputeRetentionProtectionLocked(
  input: Readonly<{
    ledger: DatabaseSync
    index: DatabaseSync
    activity: ReadonlyMap<string, SessionActivity>
    candidates: ReadonlySet<string>
    settings: ProtectionSettings
    planned: RetentionProtection
    /** What is left of the locked phase's index-wait budget. */
    waitMs?: number
  }>,
): Promise<RetentionProtection | undefined> {
  const { ledger, index, activity, candidates, settings, planned } = input
  const active = activeSessions(ledger, activity, settings)
  const own = await ownLatestSeqs(index, active, input.waitMs ?? REF_INDEX_LOCKED_WAIT_MS)
  return protect(ledger, active, own, activity, candidates, settings, (key, upTo) => {
    const known = planned.ancestors.get(`${key}\u0000${upTo}`)
    const boundary = boundaryRow(ledger, key, upTo)
    if (!boundary) return known ? undefined : null
    if (!known)
      return { boundary, digests: ancestorDigests(ledger, key, upTo, candidates, settings.maxRecent) }
    const same =
      known.boundary.id === boundary.id &&
      (known.boundary.digest === null ||
        boundary.digest === null ||
        known.boundary.digest === boundary.digest)
    return same ? known : undefined
  })
}

/** Newest reference time per candidate digest across every session that references it. */
export async function readLastReferencedAt(
  index: DatabaseSync,
  candidates: ReadonlySet<string>,
): Promise<Map<string, number>> {
  if (candidates.size === 0) return new Map()
  return withIndexTransaction(index, () => {
    const rows = cached(
      index,
      `SELECT sha256, MAX(last_ts_ms) AS ts FROM artifact_ref
       WHERE sha256 IN (SELECT value FROM json_each(?)) GROUP BY sha256`,
    ).all(JSON.stringify([...candidates])) as Array<{ sha256: string; ts: number }>
    return new Map(rows.map((row) => [row.sha256, Math.max(0, row.ts)]))
  })
}
