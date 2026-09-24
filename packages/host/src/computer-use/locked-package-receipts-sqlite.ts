import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isProxy } from 'node:util/types'
import type { SqliteStorage, TableHandle, TableStore } from '../adapters/storage-sqlite.js'

const OWNER = '@agnes/host/locked-package-operation-receipts'
const STORE_VERSION = 1
const MAX_RECEIPTS = 4096
const SHA256 = /^[a-f0-9]{64}$/
const REVISION = /^[a-f0-9]{40}$/
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const KINDS = new Set(['activate', 'confirm-lkg', 'rollback'])
const PHASES = new Set(['prepared', 'committed'])
const RECEIPT_FIELDS = [
  'afterStateSha256',
  'beforeStateSha256',
  'kind',
  'operationId',
  'requestSha256',
  'result',
  'schemaVersion',
  'storeBindingSha256',
] as const

const META_DDL =
  'CREATE TABLE locked_package_receipt_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const RECEIPTS_DDL =
  'CREATE TABLE locked_package_receipts (' +
  'operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 128), ' +
  "kind TEXT NOT NULL CHECK (kind IN ('activate','confirm-lkg','rollback')), " +
  "phase TEXT NOT NULL CHECK (phase IN ('prepared','committed')), " +
  'fencing TEXT NOT NULL CHECK (length(fencing) BETWEEN 1 AND 128), ' +
  'store_binding_sha256 TEXT NOT NULL CHECK (length(store_binding_sha256) = 64), ' +
  'request_sha256 TEXT CHECK (request_sha256 IS NULL OR length(request_sha256) = 64), ' +
  'before_state_sha256 TEXT NOT NULL CHECK (length(before_state_sha256) = 64), ' +
  'after_state_sha256 TEXT NOT NULL CHECK (length(after_state_sha256) = 64), ' +
  'result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 32768))'
const FENCING_INDEX_DDL =
  'CREATE UNIQUE INDEX locked_package_receipts_fencing ON locked_package_receipts (fencing)'

export type HostLockedPackageMutationKind = 'activate' | 'confirm-lkg' | 'rollback'

export type HostLockedPackageActivationRecord = {
  schemaVersion: 1
  packageId: string
  version: string
  packageSha256: string
  manifestSha256: string
  directory: string
  activatedAt: string
  signature: { keyId: string; publisher: string; evidenceId: string }
  provenance: { source: string; revision: string; artifactSha256: string }
  compatibility: { agnesApiVersions: string[]; platforms: string[]; osVersions: string[] }
}

export type HostLockedPackageOperationReceipt = {
  schemaVersion: 1
  operationId: string
  kind: HostLockedPackageMutationKind
  phase: 'prepared' | 'committed'
  fencing: string
  storeBindingSha256: string
  requestSha256: string | null
  beforeStateSha256: string
  afterStateSha256: string
  result: HostLockedPackageActivationRecord
}

export type HostLockedPackageOperationReceiptPort = Readonly<{
  read(operationId: string): Promise<HostLockedPackageOperationReceipt | null>
  prepare(
    receipt: Omit<HostLockedPackageOperationReceipt, 'fencing' | 'phase'>,
  ): Promise<HostLockedPackageOperationReceipt>
  commit(input: { operationId: string; fencing: string }): Promise<HostLockedPackageOperationReceipt>
}>

type ReceiptRow = {
  operation_id: unknown
  kind: unknown
  phase: unknown
  fencing: unknown
  store_binding_sha256: unknown
  request_sha256: unknown
  before_state_sha256: unknown
  after_state_sha256: unknown
  result_json: unknown
}

type SchemaRow = { type: unknown; name: unknown; tbl_name: unknown; sql: unknown }
type ReceiptSql = Pick<TableHandle, 'all' | 'exec' | 'get' | 'run' | 'transaction'>
const receiptStoreErrors = new WeakSet<object>()

class ReceiptStoreError extends Error {
  constructor(code: string) {
    super(`E_LOCKED_PACKAGE_RECEIPT_${code}`)
    this.name = 'ReceiptStoreError'
    receiptStoreErrors.add(this)
  }
}

function fail(code: string): never {
  throw new ReceiptStoreError(code)
}

function sanitized<T>(operation: string, fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (typeof error === 'object' && error !== null && receiptStoreErrors.has(error)) throw error
    throw new ReceiptStoreError(`${operation}_FAILED`)
  }
}

function ownMethod<T extends object, K extends keyof T>(value: T, name: K): T[K] {
  if (!value || typeof value !== 'object' || isProxy(value)) fail('CAPABILITY')
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    !descriptor ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function' ||
    isProxy(descriptor.value)
  )
    fail('CAPABILITY')
  return Reflect.apply(Function.prototype.bind, descriptor.value, [value]) as T[K]
}

function captureSql(storage: Pick<SqliteStorage, 'tables'>): ReceiptSql {
  const tables = Reflect.apply(ownMethod(storage, 'tables'), storage, [OWNER]) as TableStore
  const table = Reflect.apply(ownMethod(tables, 'table'), tables, [
    'locked_package_operation_receipts',
  ]) as TableHandle
  return Object.freeze({
    exec: ownMethod(table, 'exec'),
    run: ownMethod(table, 'run'),
    all: ownMethod(table, 'all'),
    get: ownMethod(table, 'get'),
    transaction: ownMethod(table, 'transaction'),
  })
}

function plain(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail('INPUT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
    fields.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined
    })
  )
    fail('INPUT')
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value]))
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('INPUT')
  return value
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('INPUT')
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 1 || length > 64) fail('INPUT')
  const result: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      !descriptor?.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'string' ||
      !TOKEN.test(descriptor.value) ||
      descriptor.value !== descriptor.value.normalize('NFC')
    )
      fail('INPUT')
    result.push(descriptor.value)
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1 || new Set(result).size !== result.length)
    fail('INPUT')
  return result.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}

function activationRecord(value: unknown): HostLockedPackageActivationRecord {
  const record = plain(value, [
    'activatedAt',
    'compatibility',
    'directory',
    'manifestSha256',
    'packageId',
    'packageSha256',
    'provenance',
    'schemaVersion',
    'signature',
    'version',
  ])
  const signature = plain(record.signature, ['evidenceId', 'keyId', 'publisher'])
  const provenance = plain(record.provenance, ['artifactSha256', 'revision', 'source'])
  const compatibility = plain(record.compatibility, ['agnesApiVersions', 'osVersions', 'platforms'])
  if (record.schemaVersion !== 1) fail('INPUT')
  const directory = record.directory
  if (
    typeof directory !== 'string' ||
    directory.length > 400 ||
    directory !== directory.normalize('NFC') ||
    basename(directory) !== directory
  )
    fail('INPUT')
  if (typeof record.activatedAt !== 'string') fail('INPUT')
  try {
    if (new Date(record.activatedAt).toISOString() !== record.activatedAt) fail('INPUT')
  } catch {
    fail('INPUT')
  }
  if (typeof provenance.source !== 'string' || provenance.source.length > 2048) fail('INPUT')
  let source: URL
  try {
    source = new URL(provenance.source)
  } catch {
    fail('INPUT')
  }
  if (
    source.protocol !== 'https:' ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    provenance.source !== provenance.source.normalize('NFC')
  )
    fail('INPUT')
  if (typeof provenance.revision !== 'string' || !REVISION.test(provenance.revision)) fail('INPUT')
  return Object.freeze({
    schemaVersion: 1,
    packageId: token(record.packageId),
    version: token(record.version),
    packageSha256: digest(record.packageSha256),
    manifestSha256: digest(record.manifestSha256),
    directory,
    activatedAt: record.activatedAt,
    signature: Object.freeze({
      keyId: token(signature.keyId),
      publisher: token(signature.publisher),
      evidenceId: token(signature.evidenceId),
    }),
    provenance: Object.freeze({
      source: source.href,
      revision: provenance.revision,
      artifactSha256: digest(provenance.artifactSha256),
    }),
    compatibility: Object.freeze({
      agnesApiVersions: Object.freeze(stringArray(compatibility.agnesApiVersions)),
      platforms: Object.freeze(stringArray(compatibility.platforms)),
      osVersions: Object.freeze(stringArray(compatibility.osVersions)),
    }),
  }) as HostLockedPackageActivationRecord
}

type Proposal = Omit<HostLockedPackageOperationReceipt, 'fencing' | 'phase'>

function proposal(value: unknown): Proposal {
  const receipt = plain(value, RECEIPT_FIELDS)
  if (receipt.schemaVersion !== 1 || typeof receipt.kind !== 'string' || !KINDS.has(receipt.kind))
    fail('INPUT')
  return Object.freeze({
    schemaVersion: 1,
    operationId: token(receipt.operationId),
    kind: receipt.kind as HostLockedPackageMutationKind,
    storeBindingSha256: digest(receipt.storeBindingSha256),
    requestSha256: receipt.requestSha256 === null ? null : digest(receipt.requestSha256),
    beforeStateSha256: digest(receipt.beforeStateSha256),
    afterStateSha256: digest(receipt.afterStateSha256),
    result: activationRecord(receipt.result),
  })
}

function operation(value: unknown): { operationId: string; fencing: string } {
  const input = plain(value, ['fencing', 'operationId'])
  return Object.freeze({ operationId: token(input.operationId), fencing: token(input.fencing) })
}

function normalizedDdl(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
}

function attest(table: ReceiptSql): void {
  const allowed = new Map<string, Readonly<{ type: 'table' | 'index'; table: string; ddl: string | null }>>([
    ['locked_package_receipt_meta', { type: 'table', table: 'locked_package_receipt_meta', ddl: META_DDL }],
    ['locked_package_receipts', { type: 'table', table: 'locked_package_receipts', ddl: RECEIPTS_DDL }],
    [
      'locked_package_receipts_fencing',
      { type: 'index', table: 'locked_package_receipts', ddl: FENCING_INDEX_DDL },
    ],
    [
      'sqlite_autoindex_locked_package_receipts_1',
      { type: 'index', table: 'locked_package_receipts', ddl: null },
    ],
  ])
  const rows = table.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
  if (rows.length !== allowed.size) fail('SCHEMA')
  for (const row of rows) {
    if (typeof row.name !== 'string') fail('SCHEMA')
    const expected = allowed.get(row.name)
    if (
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.table ||
      (expected.ddl === null
        ? row.sql !== null
        : typeof row.sql !== 'string' || normalizedDdl(row.sql) !== normalizedDdl(expected.ddl))
    )
      fail('SCHEMA')
  }
  if (
    table.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name')
      .length !== 0
  )
    fail('SCHEMA')
  const versions = table.all<{ id: unknown; version: unknown }>(
    'SELECT id, version FROM locked_package_receipt_meta ORDER BY id',
  )
  if (versions.length !== 1 || versions[0]?.id !== 1 || versions[0].version !== STORE_VERSION) fail('SCHEMA')
  const count = table.get<{ count: unknown }>('SELECT count(*) AS count FROM locked_package_receipts')?.count
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_RECEIPTS)
    fail('CORRUPT')
}

function parseRow(row: ReceiptRow | undefined): HostLockedPackageOperationReceipt | null {
  if (!row) return null
  if (
    typeof row.operation_id !== 'string' ||
    !TOKEN.test(row.operation_id) ||
    typeof row.kind !== 'string' ||
    !KINDS.has(row.kind) ||
    typeof row.phase !== 'string' ||
    !PHASES.has(row.phase) ||
    typeof row.fencing !== 'string' ||
    !TOKEN.test(row.fencing) ||
    typeof row.store_binding_sha256 !== 'string' ||
    !SHA256.test(row.store_binding_sha256) ||
    (row.request_sha256 !== null &&
      (typeof row.request_sha256 !== 'string' || !SHA256.test(row.request_sha256))) ||
    typeof row.before_state_sha256 !== 'string' ||
    !SHA256.test(row.before_state_sha256) ||
    typeof row.after_state_sha256 !== 'string' ||
    !SHA256.test(row.after_state_sha256) ||
    typeof row.result_json !== 'string' ||
    row.result_json.length > 32768
  )
    fail('CORRUPT')
  let result: unknown
  try {
    result = JSON.parse(row.result_json)
  } catch {
    fail('CORRUPT')
  }
  let checked: HostLockedPackageActivationRecord
  try {
    checked = activationRecord(result)
  } catch {
    fail('CORRUPT')
  }
  if (row.result_json !== JSON.stringify(checked)) fail('CORRUPT')
  return Object.freeze({
    schemaVersion: 1,
    operationId: row.operation_id,
    kind: row.kind as HostLockedPackageMutationKind,
    phase: row.phase as 'prepared' | 'committed',
    fencing: row.fencing,
    storeBindingSha256: row.store_binding_sha256,
    requestSha256: row.request_sha256,
    beforeStateSha256: row.before_state_sha256,
    afterStateSha256: row.after_state_sha256,
    result: checked,
  })
}

const SELECT_RECEIPT =
  'SELECT operation_id, kind, phase, fencing, store_binding_sha256, request_sha256, ' +
  'before_state_sha256, after_state_sha256, result_json FROM locked_package_receipts WHERE operation_id = ?'

function readRow(table: ReceiptSql, operationId: string): HostLockedPackageOperationReceipt | null {
  return parseRow(table.get<ReceiptRow>(SELECT_RECEIPT, [operationId]))
}

function sameProposal(left: HostLockedPackageOperationReceipt, right: Proposal): boolean {
  return (
    left.operationId === right.operationId &&
    left.kind === right.kind &&
    left.storeBindingSha256 === right.storeBindingSha256 &&
    left.requestSha256 === right.requestSha256 &&
    left.beforeStateSha256 === right.beforeStateSha256 &&
    left.afterStateSha256 === right.afterStateSha256 &&
    JSON.stringify(left.result) === JSON.stringify(right.result)
  )
}

function sameReceipt(
  left: HostLockedPackageOperationReceipt,
  right: HostLockedPackageOperationReceipt,
  phase: HostLockedPackageOperationReceipt['phase'],
): boolean {
  return (
    right.phase === phase &&
    left.fencing === right.fencing &&
    sameProposal(right, {
      schemaVersion: 1,
      operationId: left.operationId,
      kind: left.kind,
      storeBindingSha256: left.storeBindingSha256,
      requestSha256: left.requestSha256,
      beforeStateSha256: left.beforeStateSha256,
      afterStateSha256: left.afterStateSha256,
      result: left.result,
    })
  )
}

function initialize(table: ReceiptSql): void {
  table.transaction(() => {
    if (
      table.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name')
        .length !== 0
    )
      fail('SCHEMA')
    const objects = table.all<{ name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY type, name",
    )
    if (objects.length === 0) {
      table.exec(META_DDL)
      table.exec(RECEIPTS_DDL)
      table.exec(FENCING_INDEX_DDL)
      table.run('INSERT INTO locked_package_receipt_meta (id, version) VALUES (1, ?)', [STORE_VERSION])
    }
    attest(table)
    for (const row of table.all<ReceiptRow>(
      'SELECT operation_id, kind, phase, fencing, store_binding_sha256, request_sha256, ' +
        'before_state_sha256, after_state_sha256, result_json FROM locked_package_receipts ORDER BY operation_id',
    ))
      parseRow(row)
  })
}

/**
 * Opens the Host-owned durable receipt state machine used by locked-package mutations. The owner is
 * fixed here rather than supplied by an installer, so callers cannot alias receipts with another
 * package's tables. This port changes no driver-admission state and does not install packages.
 */
export function createSqliteLockedPackageOperationReceiptPort(
  storage: Pick<SqliteStorage, 'tables'>,
): HostLockedPackageOperationReceiptPort {
  const table = sanitized('OPEN', () => captureSql(storage))
  sanitized('INITIALIZE', () => initialize(table))
  return Object.freeze({
    async read(rawOperationId) {
      const operationId = token(rawOperationId)
      return sanitized('READ', () =>
        table.transaction(() => {
          attest(table)
          return readRow(table, operationId)
        }),
      )
    },
    async prepare(rawReceipt) {
      const receipt = proposal(rawReceipt)
      return sanitized('PREPARE', () =>
        table.transaction(() => {
          attest(table)
          const existing = readRow(table, receipt.operationId)
          if (existing) {
            if (existing.phase !== 'prepared' || !sameProposal(existing, receipt)) fail('CONFLICT')
            return existing
          }
          const count = table.get<{ count: unknown }>(
            'SELECT count(*) AS count FROM locked_package_receipts',
          )?.count
          if (count === MAX_RECEIPTS) fail('LIMIT')
          if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_RECEIPTS)
            fail('CORRUPT')
          const fencing = randomUUID()
          const resultJson = JSON.stringify(receipt.result)
          const changed = table.run(
            'INSERT INTO locked_package_receipts (' +
              'operation_id, kind, phase, fencing, store_binding_sha256, request_sha256, ' +
              'before_state_sha256, after_state_sha256, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              receipt.operationId,
              receipt.kind,
              'prepared',
              fencing,
              receipt.storeBindingSha256,
              receipt.requestSha256,
              receipt.beforeStateSha256,
              receipt.afterStateSha256,
              resultJson,
            ],
          ).changes
          if (changed !== 1) fail('WRITE')
          const prepared = readRow(table, receipt.operationId)
          if (
            prepared?.phase !== 'prepared' ||
            prepared.fencing !== fencing ||
            !sameProposal(prepared, receipt)
          )
            fail('WRITE')
          return prepared
        }),
      )
    },
    async commit(rawInput) {
      const input = operation(rawInput)
      return sanitized('COMMIT', () =>
        table.transaction(() => {
          attest(table)
          const existing = readRow(table, input.operationId)
          if (!existing || existing.fencing !== input.fencing) fail('FENCE')
          if (existing.phase === 'committed') return existing
          const changed = table.run(
            "UPDATE locked_package_receipts SET phase = 'committed' " +
              "WHERE operation_id = ? AND fencing = ? AND phase = 'prepared'",
            [input.operationId, input.fencing],
          ).changes
          if (changed !== 1) fail('FENCE')
          const committed = readRow(table, input.operationId)
          if (!committed || !sameReceipt(existing, committed, 'committed')) fail('WRITE')
          return committed
        }),
      )
    },
  })
}
