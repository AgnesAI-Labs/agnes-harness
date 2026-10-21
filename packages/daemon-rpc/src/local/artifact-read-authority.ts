import { types as utilTypes } from 'node:util'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { type ArtifactRef, validateAgainst } from '@agnes/protocol'
import { ArtifactRef as ArtifactRefSchema } from '@agnes/protocol/gen/agnes-v1'
import type { ArtifactReadAuthorityPort } from './artifact-read.js'

// Historical index rows admitted this bounded MIME range, independently of the public maxLength.
const LEGACY_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u
const HASH = /^[0-9a-f]{64}$/u

export type ArtifactAuthorityBinding = Readonly<{
  sessionId: string
  laneId: string
  ownerId: string
  artifact: ArtifactRef
}>

export type ArtifactAuthorityWriter = Readonly<{
  permission: 'append' | 'replace' | 'revoke'
  sessionId: string
  laneId: string
  principalId: string
}>

export type ArtifactAuthorityWriteResult = Readonly<{
  ok: boolean
  code:
    | 'appended'
    | 'already_present'
    | 'replaced'
    | 'revoked'
    | 'unchanged'
    | 'invalid'
    | 'forbidden'
    | 'conflict'
    | 'storage_unavailable'
}>

type Row = {
  session_id: unknown
  lane_id: unknown
  owner_id: unknown
  sha256: unknown
  size: unknown
  mime: unknown
}

type SchemaRow = { type: unknown; name: unknown; tbl_name: unknown; sql: unknown }
type SqlCapabilities = Pick<TableHandle, 'exec' | 'get' | 'all' | 'transaction'>
// The table keeps its v1 name; schema version 3 is the only accepted layout.
const TABLE = 'artifact_read_authority_v1'
const META = 'artifact_read_authority_meta'
const VERSION = 3
const MAX_ROWS = 4096
// Protocol integers are JS numbers, including values outside SQLite's safe integer → JS range.
// Keep malformed SQL values malformed rather than coercing text/blob metadata into a valid zero.
const COLUMNS = `session_id, lane_id, owner_id, sha256,
  CASE WHEN typeof(size) IN ('integer', 'real') THEN CAST(size AS REAL) ELSE NULL END AS size, mime`
const META_DDL =
  'CREATE TABLE artifact_read_authority_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const TABLE_DDL =
  'CREATE TABLE artifact_read_authority_v1 (' +
  'session_id TEXT NOT NULL, lane_id TEXT NOT NULL, owner_id TEXT NOT NULL, ' +
  'sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, ' +
  'PRIMARY KEY (session_id, lane_id, sha256, mime))'
const INDEX_DDL =
  'CREATE INDEX artifact_read_authority_v1_lane ON artifact_read_authority_v1 (session_id, lane_id)'

const result = (ok: boolean, code: ArtifactAuthorityWriteResult['code']): ArtifactAuthorityWriteResult =>
  Object.freeze({ ok, code })

function exactOwn(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field]
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      })
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const field of fields) copy[field] = descriptors[field]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.normalize('NFC') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function snapshotRef(value: unknown): ArtifactRef | undefined {
  const ref = exactOwn(value, ['sha256', 'size', 'mime'])
  if (!ref) return undefined
  // Storage metadata follows the public contract. HTTP header safety belongs to the read adapter.
  const mime = ref.mime
  if (typeof mime !== 'string') return undefined
  // Preserve the old index's valid MIME bounds for historical roots, without changing HTTP policy.
  const checked = validateAgainst<ArtifactRef>(
    ArtifactRefSchema,
    LEGACY_MIME.test(mime) ? { ...ref, mime: '' } : ref,
  )
  if (!checked.ok) return undefined
  return Object.freeze({ sha256: checked.value.sha256, size: checked.value.size, mime })
}

function snapshotBinding(value: unknown): ArtifactAuthorityBinding | undefined {
  const binding = exactOwn(value, ['sessionId', 'laneId', 'ownerId', 'artifact'])
  if (
    !binding ||
    !boundedIdentity(binding.sessionId) ||
    !boundedIdentity(binding.laneId) ||
    !boundedIdentity(binding.ownerId)
  )
    return undefined
  const artifact = snapshotRef(binding.artifact)
  if (!artifact) return undefined
  return Object.freeze({
    sessionId: binding.sessionId,
    laneId: binding.laneId,
    ownerId: binding.ownerId,
    artifact,
  })
}

function snapshotWriter(value: unknown): ArtifactAuthorityWriter | undefined {
  const writer = exactOwn(value, ['permission', 'sessionId', 'laneId', 'principalId'])
  if (
    !writer ||
    (writer.permission !== 'append' && writer.permission !== 'replace' && writer.permission !== 'revoke') ||
    !boundedIdentity(writer.sessionId) ||
    !boundedIdentity(writer.laneId) ||
    !boundedIdentity(writer.principalId)
  )
    return undefined
  return Object.freeze({
    permission: writer.permission,
    sessionId: writer.sessionId,
    laneId: writer.laneId,
    principalId: writer.principalId,
  })
}

function sameBinding(left: ArtifactAuthorityBinding, right: ArtifactAuthorityBinding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.laneId === right.laneId &&
    left.ownerId === right.ownerId &&
    left.artifact.sha256 === right.artifact.sha256 &&
    left.artifact.size === right.artifact.size &&
    left.artifact.mime === right.artifact.mime
  )
}

function permits(
  writer: ArtifactAuthorityWriter,
  permission: ArtifactAuthorityWriter['permission'],
  binding: ArtifactAuthorityBinding,
): boolean {
  return (
    writer.permission === permission &&
    writer.sessionId === binding.sessionId &&
    writer.laneId === binding.laneId &&
    writer.principalId === binding.ownerId
  )
}

function decodeRow(row: Row): ArtifactAuthorityBinding | undefined {
  let mime: unknown = row.mime
  if (typeof mime !== 'string') return undefined
  try {
    mime = JSON.parse(mime)
    if (JSON.stringify(mime) !== row.mime) return undefined
  } catch {
    return undefined
  }
  return snapshotBinding({
    sessionId: row.session_id,
    laneId: row.lane_id,
    ownerId: row.owner_id,
    artifact: { sha256: row.sha256, size: row.size, mime },
  })
}

function normalizedDdl(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),=])\s*/gu, '$1')
    .toLowerCase()
}

function requireSchema(sql: SqlCapabilities): void {
  const allowed = new Map<string, Readonly<{ type: 'table' | 'index'; table: string; ddl: string | null }>>([
    [META, { type: 'table', table: META, ddl: META_DDL }],
    [TABLE, { type: 'table', table: TABLE, ddl: TABLE_DDL }],
    [`sqlite_autoindex_${TABLE}_1`, { type: 'index', table: TABLE, ddl: null }],
    ['artifact_read_authority_v1_lane', { type: 'index', table: TABLE, ddl: INDEX_DDL }],
  ])
  const rows = sql.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
  if (rows.length !== allowed.size) throw new Error('unexpected schema inventory')
  for (const row of rows) {
    if (typeof row.name !== 'string') throw new Error('malformed schema inventory')
    const expected = allowed.get(row.name)
    if (
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.table ||
      (expected.ddl === null
        ? row.sql !== null
        : typeof row.sql !== 'string' || normalizedDdl(row.sql) !== normalizedDdl(expected.ddl))
    )
      throw new Error('incompatible schema inventory')
  }
}

function requireTempSchemaEmpty(sql: SqlCapabilities): void {
  const rows = sql.all<SchemaRow>(
    'SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name',
  )
  if (rows.length !== 0) throw new Error('unexpected temporary schema inventory')
}

function requireSoleVersion(sql: SqlCapabilities): void {
  const versions = sql.all<{ id: unknown; version: unknown }>(`SELECT id, version FROM ${META} ORDER BY id`)
  if (versions.length !== 1 || versions[0]?.id !== 1 || versions[0].version !== VERSION)
    throw new Error('incompatible schema version')
}

function attestStore(sql: SqlCapabilities): void {
  requireSchema(sql)
  requireTempSchemaEmpty(sql)
  requireSoleVersion(sql)
}

function initialize(sql: SqlCapabilities): void {
  sql.transaction(() => {
    requireTempSchemaEmpty(sql)
    const existing = sql.all<{ name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY type, name",
    )
    if (existing.length === 0) {
      sql.exec(META_DDL)
      sql.exec(TABLE_DDL)
      sql.exec(INDEX_DDL)
      sql.exec(`INSERT INTO ${META} (id, version) VALUES (?, ?)`, [1, VERSION])
    }
    attestStore(sql)
    const rows = sql.all<Row>(
      `SELECT ${COLUMNS} FROM ${TABLE}
       ORDER BY session_id, lane_id, sha256 LIMIT ${MAX_ROWS + 1}`,
    )
    if (rows.length > MAX_ROWS) throw new Error('authority row inventory exceeds limit')
    const identities = new Map<string, ArtifactAuthorityBinding>()
    for (const row of rows) {
      const binding = decodeRow(row)
      if (!binding) throw new Error('invalid authority row')
      const key = JSON.stringify([binding.sessionId, binding.laneId, binding.artifact.sha256])
      const prior = identities.get(key)
      if (prior && (prior.ownerId !== binding.ownerId || prior.artifact.size !== binding.artifact.size))
        throw new Error('conflicting content identity')
      identities.set(key, binding)
    }
  })
}

/**
 * Durable ownership index for artifact reads. The supplied handle must own a dedicated SQLite
 * connection/file whose complete main schema belongs to this index; unrelated objects fail
 * attestation. Each operation performs schema checks and data access synchronously inside one
 * transaction, with no await point for same-connection TEMP schema mutation between check and use.
 * Request payloads are never write authority and no filesystem path is stored.
 */
export class PersistentArtifactReadAuthorityIndex {
  private readonly sql: SqlCapabilities

  constructor(table: TableHandle) {
    try {
      if (!table || typeof table !== 'object' || utilTypes.isProxy(table))
        throw new Error('invalid table capability')
      const descriptors = Object.getOwnPropertyDescriptors(table)
      const method = (name: keyof SqlCapabilities) => {
        const value = descriptors[name]?.value
        if (typeof value !== 'function' || utilTypes.isProxy(value))
          throw new Error('invalid table capability')
        return value.bind(table)
      }
      this.sql = Object.freeze({
        exec: method('exec'),
        get: method('get'),
        all: method('all'),
        transaction: method('transaction'),
      }) as SqlCapabilities
      initialize(this.sql)
    } catch {
      throw new Error('artifact read authority index unavailable')
    }
  }

  append(writerValue: unknown, bindingValue: unknown): ArtifactAuthorityWriteResult {
    const writer = snapshotWriter(writerValue)
    const binding = snapshotBinding(bindingValue)
    if (!writer || !binding) return result(false, 'invalid')
    if (!permits(writer, 'append', binding)) return result(false, 'forbidden')
    try {
      return this.sql.transaction(() => {
        attestStore(this.sql)
        if (this.hasConflict(binding)) return result(false, 'conflict')
        const existing = this.read(
          binding.sessionId,
          binding.laneId,
          binding.artifact.sha256,
          binding.artifact.mime,
        )
        if (existing)
          return sameBinding(existing, binding) ? result(true, 'already_present') : result(false, 'conflict')
        const count = this.sql.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${TABLE}`)?.n
        if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) >= MAX_ROWS)
          throw new Error('authority row inventory limit reached')
        this.insert(binding)
        const inserted = this.read(
          binding.sessionId,
          binding.laneId,
          binding.artifact.sha256,
          binding.artifact.mime,
        )
        if (!inserted || !sameBinding(inserted, binding)) throw new Error('authority append lost its row')
        return result(true, 'appended')
      })
    } catch {
      return result(false, 'storage_unavailable')
    }
  }

  replace(
    writerValue: unknown,
    expectedValue: unknown,
    replacementValue: unknown,
  ): ArtifactAuthorityWriteResult {
    const writer = snapshotWriter(writerValue)
    const expected = snapshotBinding(expectedValue)
    const replacement = snapshotBinding(replacementValue)
    if (!writer || !expected || !replacement) return result(false, 'invalid')
    if (
      !permits(writer, 'replace', expected) ||
      !permits(writer, 'replace', replacement) ||
      expected.sessionId !== replacement.sessionId ||
      expected.laneId !== replacement.laneId ||
      expected.ownerId !== replacement.ownerId
    )
      return result(false, 'forbidden')
    try {
      return this.sql.transaction(() => {
        attestStore(this.sql)
        const current = this.read(
          expected.sessionId,
          expected.laneId,
          expected.artifact.sha256,
          expected.artifact.mime,
        )
        if (!current || !sameBinding(current, expected)) return result(false, 'conflict')
        if (sameBinding(expected, replacement)) return result(true, 'unchanged')
        if (
          this.read(
            replacement.sessionId,
            replacement.laneId,
            replacement.artifact.sha256,
            replacement.artifact.mime,
          )
        )
          return result(false, 'conflict')
        this.sql.exec(
          `DELETE FROM ${TABLE}
           WHERE session_id = ? AND lane_id = ? AND owner_id = ? AND sha256 = ? AND size = ? AND mime = ?`,
          [
            expected.sessionId,
            expected.laneId,
            expected.ownerId,
            expected.artifact.sha256,
            expected.artifact.size,
            JSON.stringify(expected.artifact.mime),
          ],
        )
        if (this.read(expected.sessionId, expected.laneId, expected.artifact.sha256, expected.artifact.mime))
          return result(false, 'conflict')
        if (this.hasConflict(replacement)) throw new Error('conflicting content identity')
        this.insert(replacement)
        const inserted = this.read(
          replacement.sessionId,
          replacement.laneId,
          replacement.artifact.sha256,
          replacement.artifact.mime,
        )
        if (!inserted || !sameBinding(inserted, replacement))
          throw new Error('authority replacement lost its row')
        return result(true, 'replaced')
      })
    } catch {
      return result(false, 'storage_unavailable')
    }
  }

  /** Revoke one exact binding. Stale or cross-scope writers are refused. */
  revoke(writerValue: unknown, bindingValue: unknown): ArtifactAuthorityWriteResult {
    const writer = snapshotWriter(writerValue)
    const binding = snapshotBinding(bindingValue)
    if (!writer || !binding) return result(false, 'invalid')
    if (!permits(writer, 'revoke', binding)) return result(false, 'forbidden')
    try {
      return this.sql.transaction(() => {
        attestStore(this.sql)
        const existing = this.read(
          binding.sessionId,
          binding.laneId,
          binding.artifact.sha256,
          binding.artifact.mime,
        )
        if (!existing) return result(true, 'unchanged')
        if (!sameBinding(existing, binding)) return result(false, 'conflict')
        this.sql.exec(
          `DELETE FROM ${TABLE}
           WHERE session_id = ? AND lane_id = ? AND owner_id = ? AND sha256 = ? AND size = ? AND mime = ?`,
          [
            binding.sessionId,
            binding.laneId,
            binding.ownerId,
            binding.artifact.sha256,
            binding.artifact.size,
            JSON.stringify(binding.artifact.mime),
          ],
        )
        if (this.read(binding.sessionId, binding.laneId, binding.artifact.sha256, binding.artifact.mime))
          throw new Error('authority revoke left its row behind')
        return result(true, 'revoked')
      })
    } catch {
      return result(false, 'storage_unavailable')
    }
  }

  resolve(
    sessionId: unknown,
    laneId: unknown,
    sha256: unknown,
    mime?: string,
  ): ArtifactAuthorityBinding | undefined {
    if (
      !boundedIdentity(sessionId) ||
      !boundedIdentity(laneId) ||
      typeof sha256 !== 'string' ||
      !HASH.test(sha256) ||
      (mime !== undefined && !snapshotRef({ sha256, size: 0, mime }))
    )
      return undefined
    try {
      return this.sql.transaction(() => {
        attestStore(this.sql)
        return this.read(sessionId, laneId, sha256, mime)
      })
    } catch {
      throw new Error('artifact read authority index unavailable')
    }
  }

  private read(
    sessionId: string,
    laneId: string,
    sha256: string,
    mime?: string,
  ): ArtifactAuthorityBinding | undefined {
    // Inspect this digest's bounded aliases so malformed metadata cannot hide behind another key.
    const rows = this.sql.all<Row>(
      `SELECT ${COLUMNS} FROM ${TABLE}
       WHERE session_id = ? AND lane_id = ? AND sha256 = ? LIMIT ${MAX_ROWS + 1}`,
      [sessionId, laneId, sha256],
    )
    if (rows.length > MAX_ROWS) throw new Error('artifact read authority index unavailable')
    const bindings = rows.map((row) => {
      const binding = decodeRow(row)
      if (!binding) throw new Error('artifact read authority index unavailable')
      return binding
    })
    const first = bindings[0]
    if (
      first &&
      bindings.some(
        (binding) => binding.ownerId !== first.ownerId || binding.artifact.size !== first.artifact.size,
      )
    )
      throw new Error('artifact read authority index unavailable')
    // Digest-only legacy callers must never choose an arbitrary MIME alias.
    return mime === undefined
      ? bindings.length === 1
        ? first
        : undefined
      : bindings.find((binding) => binding.artifact.mime === mime)
  }

  private hasConflict(binding: ArtifactAuthorityBinding): boolean {
    return !!this.sql.get<{ found: number }>(
      `SELECT 1 AS found FROM ${TABLE}
       WHERE session_id = ? AND lane_id = ? AND sha256 = ? AND (owner_id <> ? OR size <> ?) LIMIT 1`,
      [binding.sessionId, binding.laneId, binding.artifact.sha256, binding.ownerId, binding.artifact.size],
    )
  }

  private insert(binding: ArtifactAuthorityBinding): void {
    this.sql.exec(
      `INSERT INTO ${TABLE} (session_id, lane_id, owner_id, sha256, size, mime)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        binding.sessionId,
        binding.laneId,
        binding.ownerId,
        binding.artifact.sha256,
        binding.artifact.size,
        JSON.stringify(binding.artifact.mime),
      ],
    )
  }
}

/** Adapter for the authenticated artifact-read boundary. It preserves not-found indistinguishability. */
export function createArtifactReadAuthorityPort(
  index: PersistentArtifactReadAuthorityIndex,
): ArtifactReadAuthorityPort {
  const resolve = index.resolve.bind(index)
  return Object.freeze({
    async resolve(sessionId: string, laneId: string, sha256: string, signal: AbortSignal, mime?: string) {
      if (signal.aborted) throw new Error('artifact read authority lookup unavailable')
      const binding = resolve(sessionId, laneId, sha256, mime)
      if (signal.aborted) throw new Error('artifact read authority lookup unavailable')
      if (!binding) return undefined
      return Object.freeze({
        sessionId: binding.sessionId,
        laneId: binding.laneId,
        ownerId: binding.ownerId,
        artifact: binding.artifact,
      })
    },
  })
}
