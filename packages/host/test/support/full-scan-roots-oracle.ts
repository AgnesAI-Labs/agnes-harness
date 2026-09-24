import { DatabaseSync } from 'node:sqlite'
import { extractArtifactRefs } from '../../src/artifact-ledger-refs.js'

export type OracleRef = Readonly<{
  sha256: string
  session_key: string
  source: 'ledger' | 'request-media'
  last_seq: number
  last_ts_ms: number
  last_tool_image_seq: number | null
}>
export type OracleCursor = Readonly<{
  session_key: string
  last_seq: number
  anchor_id: string
  anchor_digest: string | null
  last_ts_ms: number
  open_lanes: string
}>

const tsMs = (ts: string) => {
  const value = Date.parse(ts)
  return Number.isFinite(value) ? value : 0
}

/**
 * Test-only reference: the full-table scan the reference index replaces, aggregated row by row
 * with the same shared extraction rule. Production code has no full-scan path.
 */
export function fullScanRefIndex(file: string): {
  refs: OracleRef[]
  cursors: OracleCursor[]
  ledger: Set<string>
  requestMedia: Set<string>
} {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const refs = new Map<string, OracleRef>()
    const cursors = new Map<string, OracleCursor>()
    const lanes = new Map<string, Set<string>>()
    const rows = database
      .prepare(
        'SELECT session_key, seq, id, ts, type, lane, origin, trust, data, integrity_digest FROM events ORDER BY session_key, seq',
      )
      .iterate() as Iterable<{
      session_key: string
      seq: number
      id: string
      ts: string
      type: string
      lane: Uint8Array
      origin: string
      trust: string
      data: string
      integrity_digest: string | null
    }>
    for (const row of rows) {
      const lane = new TextDecoder().decode(row.lane)
      const extracted = extractArtifactRefs({ ...row, lane })
      const open = lanes.get(row.session_key) ?? new Set<string>()
      lanes.set(row.session_key, open)
      if (extracted.turn?.kind === 'start') open.add(extracted.turn.lane)
      if (extracted.turn?.kind === 'end') open.delete(extracted.turn.lane)
      const put = (sha256: string, source: OracleRef['source'], toolImage: boolean) => {
        const key = `${sha256}|${row.session_key}|${source}`
        const previous = refs.get(key)
        refs.set(key, {
          sha256,
          session_key: row.session_key,
          source,
          last_seq: row.seq,
          last_ts_ms: tsMs(row.ts),
          last_tool_image_seq: toolImage ? row.seq : (previous?.last_tool_image_seq ?? null),
        })
      }
      for (const sha256 of extracted.ledger) put(sha256, 'ledger', extracted.toolImage.has(sha256))
      for (const sha256 of extracted.requestMedia) put(sha256, 'request-media', false)
      cursors.set(row.session_key, {
        session_key: row.session_key,
        last_seq: row.seq,
        anchor_id: row.id,
        anchor_digest: row.integrity_digest,
        last_ts_ms: tsMs(row.ts),
        open_lanes: JSON.stringify([...open].sort()),
      })
    }
    const sortedRefs = [...refs.values()].sort((a, b) =>
      `${a.sha256}|${a.session_key}|${a.source}`.localeCompare(`${b.sha256}|${b.session_key}|${b.source}`),
    )
    return {
      refs: sortedRefs,
      cursors: [...cursors.values()].sort((a, b) => a.session_key.localeCompare(b.session_key)),
      ledger: new Set(sortedRefs.filter((ref) => ref.source === 'ledger').map((ref) => ref.sha256)),
      requestMedia: new Set(
        sortedRefs.filter((ref) => ref.source === 'request-media').map((ref) => ref.sha256),
      ),
    }
  } finally {
    database.close()
  }
}

/** The index tables in the oracle's order, for field-by-field comparison. */
export function indexTables(index: DatabaseSync): { refs: OracleRef[]; cursors: OracleCursor[] } {
  const refs = (
    index
      .prepare(
        'SELECT sha256, session_key, source, last_seq, last_ts_ms, last_tool_image_seq FROM artifact_ref',
      )
      .all() as OracleRef[]
  )
    .map((row) => ({ ...row }))
    .sort((a, b) =>
      `${a.sha256}|${a.session_key}|${a.source}`.localeCompare(`${b.sha256}|${b.session_key}|${b.source}`),
    )
  const cursors = (
    index
      .prepare(
        'SELECT session_key, last_seq, anchor_id, anchor_digest, last_ts_ms, open_lanes FROM session_cursor',
      )
      .all() as OracleCursor[]
  )
    .map((row) => ({ ...row }))
    .sort((a, b) => a.session_key.localeCompare(b.session_key))
  return { refs, cursors }
}
