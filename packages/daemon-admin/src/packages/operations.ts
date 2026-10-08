import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  jcs,
  type PackageAdminDataName,
  type PackageAdminError,
  type PackageInstalledDescriptor,
  type PackageOperation,
  type PackagePreview,
  validatePackageAdminData,
} from '@agnes/protocol'
import { renameWriteThrough } from '@agnes/system-node'

export type PackageOperationKind = PackageOperation['operation']
export type PackageOperationState = PackageOperation['state']
export type PackageOperationIdentity = Readonly<{
  principalId: string
  clientId: string
  commandId: string
}>
export type PackageOperationRequest = Readonly<{
  kind: PackageOperationKind
  params: Record<string, unknown>
}>
export type PackageOperationRecovery = Readonly<{
  /** The version/integrity fact which proves a rollback committed before a crash. */
  rollbackTargetIntegrity?: string
  /** The installed fact recorded before a destructive remove can begin. */
  removeTargetIntegrity?: string
}>
export type StoredPackageOperation = Readonly<{
  operation: PackageOperation
  identity: PackageOperationIdentity
  payloadHash: string
  request: PackageOperationRequest
  recovery?: PackageOperationRecovery
  cancelRequested?: boolean
}>

type StoredCancel = Readonly<{
  identity: PackageOperationIdentity
  payloadHash: string
  operationId: string
  params: Record<string, unknown>
}>
type Journal = { version: 1; operations: StoredPackageOperation[]; cancels: StoredCancel[] }

const terminal = new Set<PackageOperationState>(['completed', 'failed', 'cancelled', 'rolled-back'])
export const packageOperationTerminal = (state: PackageOperationState): boolean => terminal.has(state)

const paramsDataName: Record<PackageOperationKind, PackageAdminDataName> = {
  inspect: 'PackageInspectParams',
  install: 'PackageInstallParams',
  trust: 'PackageTrustParams',
  untrust: 'PackageUntrustParams',
  enable: 'PackageEnableParams',
  disable: 'PackageDisableParams',
  update: 'PackageUpdateParams',
  rollback: 'PackageRollbackParams',
  remove: 'PackageRemoveParams',
}
const action = (value: unknown): value is PackageOperationKind =>
  typeof value === 'string' && Object.hasOwn(paramsDataName, value)
const identity = (value: unknown): value is PackageOperationIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.principalId === 'string' &&
    row.principalId.length > 0 &&
    row.principalId.length <= 256 &&
    typeof row.clientId === 'string' &&
    row.clientId.length > 0 &&
    row.clientId.length <= 128 &&
    typeof row.commandId === 'string' &&
    row.commandId.length > 0 &&
    row.commandId.length <= 128
  )
}
const payloadHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const integrity = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/.test(value)
const methodByKind: Record<PackageOperationKind, string> = {
  inspect: '_agnes/v1/packages.inspect',
  install: '_agnes/v1/packages.install',
  trust: '_agnes/v1/packages.trust',
  untrust: '_agnes/v1/packages.untrust',
  enable: '_agnes/v1/packages.enable',
  disable: '_agnes/v1/packages.disable',
  update: '_agnes/v1/packages.update',
  rollback: '_agnes/v1/packages.rollback',
  remove: '_agnes/v1/packages.remove',
}
function computedPayloadHash(kind: PackageOperationKind, params: Record<string, unknown>): string {
  const { clientId: _clientId, commandId: _commandId, ...payload } = params
  return createHash('sha256')
    .update(jcs({ method: methodByKind[kind], payload }), 'utf8')
    .digest('hex')
}
function computedCancelPayloadHash(params: Record<string, unknown>): string {
  const { clientId: _clientId, commandId: _commandId, ...payload } = params
  return createHash('sha256')
    .update(jcs({ method: '_agnes/v1/packages.operation.cancel', payload }), 'utf8')
    .digest('hex')
}
const request = (value: unknown): value is PackageOperationRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    action(row.kind) &&
    !!row.params &&
    typeof row.params === 'object' &&
    !Array.isArray(row.params) &&
    validatePackageAdminData(paramsDataName[row.kind], row.params).ok
  )
}
const validOperation = (value: unknown): value is PackageOperation =>
  validatePackageAdminData('PackageOperation', value).ok
const clone = <T>(value: T): T => structuredClone(value)

function validStoredOperation(value: unknown): value is StoredPackageOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const stored = row.request as PackageOperationRequest
  const current = row.operation as PackageOperation
  const actor = row.identity as PackageOperationIdentity
  const params = stored.params
  return (
    Object.keys(row).every((key) =>
      ['operation', 'identity', 'payloadHash', 'request', 'recovery', 'cancelRequested'].includes(key),
    ) &&
    validOperation(row.operation) &&
    identity(row.identity) &&
    payloadHash(row.payloadHash) &&
    request(row.request) &&
    computedPayloadHash(stored.kind, params) === row.payloadHash &&
    current.operation === stored.kind &&
    current.profile === params.profile &&
    actor.clientId === params.clientId &&
    actor.commandId === params.commandId &&
    (row.recovery === undefined ||
      (!!row.recovery &&
        typeof row.recovery === 'object' &&
        !Array.isArray(row.recovery) &&
        Object.keys(row.recovery as Record<string, unknown>).every((key) =>
          ['rollbackTargetIntegrity', 'removeTargetIntegrity'].includes(key),
        ) &&
        ((row.recovery as Record<string, unknown>).rollbackTargetIntegrity === undefined ||
          integrity((row.recovery as Record<string, unknown>).rollbackTargetIntegrity)) &&
        ((row.recovery as Record<string, unknown>).removeTargetIntegrity === undefined ||
          integrity((row.recovery as Record<string, unknown>).removeTargetIntegrity)))) &&
    (row.cancelRequested === undefined || typeof row.cancelRequested === 'boolean')
  )
}

function validCancel(value: unknown): value is StoredCancel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    Object.keys(row).every((key) => ['identity', 'payloadHash', 'operationId', 'params'].includes(key)) &&
    identity(row.identity) &&
    payloadHash(row.payloadHash) &&
    typeof row.operationId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.operationId) &&
    !!row.params &&
    typeof row.params === 'object' &&
    !Array.isArray(row.params) &&
    validatePackageAdminData('PackageOperationCancelParams', row.params).ok &&
    (row.params as Record<string, unknown>).operationId === row.operationId &&
    (row.params as Record<string, unknown>).clientId ===
      (row.identity as PackageOperationIdentity).clientId &&
    (row.params as Record<string, unknown>).commandId ===
      (row.identity as PackageOperationIdentity).commandId &&
    computedCancelPayloadHash(row.params as Record<string, unknown>) === row.payloadHash
  )
}

function validJournal(value: unknown): value is Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    Object.keys(row).every((key) => ['version', 'operations', 'cancels'].includes(key)) &&
    row.version === 1 &&
    Array.isArray(row.operations) &&
    row.operations.length <= 10_000 &&
    row.operations.every(validStoredOperation) &&
    Array.isArray(row.cancels) &&
    row.cancels.length <= 10_000 &&
    row.cancels.every(validCancel) &&
    new Set(row.operations.map((entry) => entry.operation.operationId)).size === row.operations.length
  )
}

export type OperationAdmission =
  | Readonly<{ state: 'new'; record: StoredPackageOperation }>
  | Readonly<{ state: 'existing'; record: StoredPackageOperation }>
  | Readonly<{ state: 'conflict' }>
export type CancelAdmission =
  | Readonly<{ state: 'new'; operationId: string }>
  | Readonly<{ state: 'existing'; operationId: string }>
  | Readonly<{ state: 'conflict' }>

export interface PackageOperationStore {
  admit(input: {
    operation: PackageOperation
    identity: PackageOperationIdentity
    payloadHash: string
    request: PackageOperationRequest
  }): Promise<OperationAdmission>
  admitCancel(input: {
    identity: PackageOperationIdentity
    payloadHash: string
    operationId: string
    params: Record<string, unknown>
  }): Promise<CancelAdmission>
  get(profile: string, operationId: string): Promise<StoredPackageOperation | undefined>
  pending(): Promise<StoredPackageOperation[]>
  update(
    operationId: string,
    mutate: (current: StoredPackageOperation) => StoredPackageOperation,
  ): Promise<StoredPackageOperation>
}

/** A compact, atomic package-operation journal. It records coordination facts, never desired state. */
export class FilePackageOperationStore implements PackageOperationStore {
  private journal: Journal | undefined
  private tail = Promise.resolve()

  constructor(private readonly directory: string) {}

  async admit(input: {
    operation: PackageOperation
    identity: PackageOperationIdentity
    payloadHash: string
    request: PackageOperationRequest
  }): Promise<OperationAdmission> {
    return this.write(async (journal) => {
      const existing = journal.operations.find(
        (entry) =>
          entry.identity.principalId === input.identity.principalId &&
          entry.identity.clientId === input.identity.clientId &&
          entry.identity.commandId === input.identity.commandId,
      )
      if (existing) {
        if (existing.request.kind !== input.request.kind || existing.payloadHash !== input.payloadHash)
          return { state: 'conflict' }
        return { state: 'existing', record: clone(existing) }
      }
      if (journal.operations.length >= 10_000) throw new Error('package operation journal is full')
      const record: StoredPackageOperation = {
        operation: clone(input.operation),
        identity: clone(input.identity),
        payloadHash: input.payloadHash,
        request: clone(input.request),
      }
      if (!validStoredOperation(record)) throw new Error('package operation admission is invalid')
      journal.operations.push(record)
      return { state: 'new', record: clone(record) }
    })
  }

  async admitCancel(input: {
    identity: PackageOperationIdentity
    payloadHash: string
    operationId: string
    params: Record<string, unknown>
  }): Promise<CancelAdmission> {
    return this.write(async (journal) => {
      const existing = journal.cancels.find(
        (entry) =>
          entry.identity.principalId === input.identity.principalId &&
          entry.identity.clientId === input.identity.clientId &&
          entry.identity.commandId === input.identity.commandId,
      )
      if (existing) {
        if (existing.operationId !== input.operationId || existing.payloadHash !== input.payloadHash)
          return { state: 'conflict' }
        return { state: 'existing', operationId: existing.operationId }
      }
      if (journal.cancels.length >= 10_000) throw new Error('package operation journal is full')
      const record: StoredCancel = clone(input)
      if (!validCancel(record)) throw new Error('package cancellation admission is invalid')
      journal.cancels.push(record)
      return { state: 'new', operationId: input.operationId }
    })
  }

  async get(profile: string, operationId: string): Promise<StoredPackageOperation | undefined> {
    return this.read((journal) => {
      const found = journal.operations.find(
        (entry) => entry.operation.profile === profile && entry.operation.operationId === operationId,
      )
      return found ? clone(found) : undefined
    })
  }

  async pending(): Promise<StoredPackageOperation[]> {
    return this.read((journal) =>
      journal.operations.filter((entry) => !packageOperationTerminal(entry.operation.state)).map(clone),
    )
  }

  async update(
    operationId: string,
    mutate: (current: StoredPackageOperation) => StoredPackageOperation,
  ): Promise<StoredPackageOperation> {
    return this.write(async (journal) => {
      const index = journal.operations.findIndex((entry) => entry.operation.operationId === operationId)
      if (index < 0) throw new Error('package operation is missing')
      const next = mutate(clone(journal.operations[index] as StoredPackageOperation))
      if (!validStoredOperation(next) || next.operation.operationId !== operationId)
        throw new Error('package operation update is invalid')
      journal.operations[index] = clone(next)
      return clone(next)
    })
  }

  private async read<T>(fn: (journal: Journal) => T): Promise<T> {
    return this.serial(async () => fn(await this.load()))
  }

  private async write<T>(fn: (journal: Journal) => Promise<T> | T): Promise<T> {
    return this.serial(async () => {
      // A failed flush can follow a committed rename. Discard the cache on failure so the next
      // operation reloads disk; writes (including idempotent retries) still persist before replying.
      const journal = clone(await this.load())
      const value = await fn(journal)
      try {
        await this.save(journal)
      } catch (error) {
        this.journal = undefined
        throw error
      }
      this.journal = journal
      return value
    })
  }

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async load(): Promise<Journal> {
    if (this.journal) return this.journal
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, 'operations.json')
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!validJournal(parsed)) throw new Error('invalid package operation journal')
      this.journal = parsed
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        this.journal = { version: 1, operations: [], cancels: [] }
      else throw new Error('package operation journal is unavailable')
    }
    return this.journal
  }

  private async save(journal: Journal): Promise<void> {
    const file = join(this.directory, 'operations.json')
    const temporary = join(this.directory, `.operations-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(journal), 'utf8')
      await handle.sync()
      await handle.close()
      await renameWriteThrough(temporary, file)
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}

export function makePackageOperation(input: {
  profile: string
  kind: PackageOperationKind
  now: string
  packageId?: string
}): PackageOperation {
  return {
    operationId: `pkg-${randomUUID()}`,
    profile: input.profile,
    operation: input.kind,
    ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
    state: 'received',
    cancellable: true,
    retryable: false,
    progress: 0,
    startedAt: input.now,
    updatedAt: input.now,
  }
}

export function withOperationState(
  current: StoredPackageOperation,
  next: {
    state: PackageOperationState
    progress?: number
    now: string
    preview?: PackagePreview
    installed?: PackageInstalledDescriptor
    error?: PackageAdminError
    recovery?: PackageOperationRecovery
    cancelRequested?: boolean
  },
): StoredPackageOperation {
  const operation: PackageOperation = {
    ...current.operation,
    ...(current.operation.packageId
      ? {}
      : next.installed
        ? { packageId: next.installed.id }
        : next.preview
          ? { packageId: next.preview.id }
          : {}),
    state: next.state,
    cancellable: !packageOperationTerminal(next.state) && !['switching', 'draining'].includes(next.state),
    retryable: next.state === 'failed' && next.error?.code === 'E_PACKAGE_PREVIEW_STALE',
    progress: next.progress ?? current.operation.progress,
    updatedAt: next.now,
    ...(next.preview ? { preview: next.preview } : {}),
    ...(next.installed ? { installed: next.installed } : {}),
    ...(next.error ? { error: next.error } : {}),
  }
  return {
    ...current,
    operation,
    ...(next.recovery ? { recovery: next.recovery } : {}),
    ...(next.cancelRequested === undefined ? {} : { cancelRequested: next.cancelRequested }),
  }
}
