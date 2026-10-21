import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isProxy } from 'node:util/types'

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

/**
 * Opens the Host-owned durable receipt state machine used by locked-package mutations, on any
 * persistence provider's metadata port. The owner is fixed here rather than supplied by an
 * installer, so callers cannot alias receipts with another package's state. This port changes no
 * driver-admission state and does not install packages.
 */
export function createMetadataLockedPackageOperationReceiptPort(
  metadata: import('@agnes/extension-api').PersistenceMetadataPort,
): HostLockedPackageOperationReceiptPort {
  const ns = metadata.namespace(OWNER, 'receipts')
  const attestMetadata = (): void => {
    const version = ns.get('version')
    if (version !== undefined && version !== STORE_VERSION) fail('SCHEMA')
    const fences = new Set<string>()
    for (const { key, value } of ns.entries()) {
      if (key === 'version') continue
      const receipt = parseRow(value as ReceiptRow)
      if (!receipt || key !== `receipt:${receipt.operationId}` || fences.has(receipt.fencing)) fail('CORRUPT')
      fences.add(receipt.fencing)
    }
    if (version === undefined) ns.set('version', STORE_VERSION)
  }
  const read = (id: string): HostLockedPackageOperationReceipt | null => {
    const row = ns.get(`receipt:${id}`)
    return row === undefined ? null : parseRow(row as ReceiptRow)
  }
  sanitized('INITIALIZE', () => ns.transaction(attestMetadata))
  return Object.freeze({
    async read(rawId) {
      const id = token(rawId)
      return sanitized('READ', () =>
        ns.transaction(() => {
          attestMetadata()
          return read(id)
        }),
      )
    },
    async prepare(raw) {
      const receipt = proposal(raw)
      return sanitized('PREPARE', () =>
        ns.transaction(() => {
          attestMetadata()
          const prior = read(receipt.operationId)
          if (prior) {
            if (prior.phase !== 'prepared' || !sameProposal(prior, receipt)) fail('CONFLICT')
            return prior
          }
          if (ns.entries().length - 1 >= MAX_RECEIPTS) fail('LIMIT')
          const row: ReceiptRow = {
            operation_id: receipt.operationId,
            kind: receipt.kind,
            phase: 'prepared',
            fencing: randomUUID(),
            store_binding_sha256: receipt.storeBindingSha256,
            request_sha256: receipt.requestSha256,
            before_state_sha256: receipt.beforeStateSha256,
            after_state_sha256: receipt.afterStateSha256,
            result_json: JSON.stringify(receipt.result),
          }
          const prepared = parseRow(row)
          if (!prepared) fail('WRITE')
          ns.set(`receipt:${receipt.operationId}`, row)
          return prepared
        }),
      )
    },
    async commit(raw) {
      const input = operation(raw)
      return sanitized('COMMIT', () =>
        ns.transaction(() => {
          attestMetadata()
          const prior = read(input.operationId)
          if (!prior || prior.fencing !== input.fencing) fail('FENCE')
          if (prior.phase === 'committed') return prior
          const row = ns.get(`receipt:${input.operationId}`) as ReceiptRow
          ns.set(`receipt:${input.operationId}`, { ...row, phase: 'committed' })
          const committed = read(input.operationId)
          if (!committed || !sameReceipt(prior, committed, 'committed')) fail('WRITE')
          return committed
        }),
      )
    },
  })
}
