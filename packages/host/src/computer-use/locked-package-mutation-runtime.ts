import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { isProxy } from 'node:util/types'
import type { SqliteStorage } from '../adapters/storage-sqlite.js'
import {
  createSqliteLockedPackageOperationReceiptPort,
  type HostLockedPackageActivationRecord,
  type HostLockedPackageOperationReceiptPort,
} from './locked-package-receipts-sqlite.js'

const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const CONFIGURATION_FIELDS = [
  'engine',
  'environment',
  'extractor',
  'storeDirectory',
  'verifySignature',
] as const

export type HostLockedPackageEnvironment = Readonly<{
  agnesApiVersion: string
  platform: string
  osVersion: string
}>

export type HostLockedPackageSignatureEvidence = Readonly<{
  verified: true
  keyId: string
  publisher: string
  evidenceId: string
}>

export type HostLockedPackageSignatureVerifier = (input: {
  algorithm: 'ed25519'
  keyId: string
  signature: string
  payload: Uint8Array
  signal: AbortSignal
}) => Promise<HostLockedPackageSignatureEvidence>

export type HostLockedPackageOperation = Readonly<{
  operationId: string
  receipts: HostLockedPackageOperationReceiptPort
}>

export type HostLockedPackageOperationHistory =
  | Readonly<{
      historyOnly: true
      outcome: 'committed' | 'not-applied' | 'unknown'
      record: HostLockedPackageActivationRecord
    }>
  | Readonly<{ historyOnly: true; outcome: 'not-found' }>

export type HostLockedPackageMutationEngine = Readonly<{
  activate(input: {
    sourceDirectory: string
    storeDirectory: string
    manifest: unknown
    sourceArchiveBytes: Uint8Array
    environment: HostLockedPackageEnvironment
    verifySignature: HostLockedPackageSignatureVerifier
    operation: HostLockedPackageOperation
  }): Promise<HostLockedPackageActivationRecord>
  confirmLkg(input: {
    storeDirectory: string
    environment: HostLockedPackageEnvironment
    verifySignature: HostLockedPackageSignatureVerifier
    operation: HostLockedPackageOperation
  }): Promise<HostLockedPackageActivationRecord>
  rollback(input: {
    storeDirectory: string
    environment: HostLockedPackageEnvironment
    verifySignature: HostLockedPackageSignatureVerifier
    operation: HostLockedPackageOperation
  }): Promise<HostLockedPackageActivationRecord>
}>

export type HostLockedPackageSafeExtraction = Readonly<{
  sourceDirectory: string
  manifest: unknown
  release(): Promise<void> | void
}>

export type HostLockedPackageSafeExtractor = (input: {
  archiveBytes: Uint8Array
  signal: AbortSignal
}) => Promise<HostLockedPackageSafeExtraction>

export type HostLockedPackageMutationOptions = Readonly<{
  storeDirectory?: string
  engine?: HostLockedPackageMutationEngine
  environment?: HostLockedPackageEnvironment
  verifySignature?: HostLockedPackageSignatureVerifier
  extractor?: HostLockedPackageSafeExtractor
}>

export type HostLockedPackageMutationBlocker =
  | 'environment-unavailable'
  | 'mutation-engine-unavailable'
  | 'publisher-keyring-unavailable'
  | 'safe-extraction-unavailable'
  | 'store-directory-unavailable'
  | 'trusted-directory-handle-unavailable'

export type HostLockedPackageMutationStatus = Readonly<{
  activationReady: boolean
  recoveryReady: boolean
  blockers: readonly HostLockedPackageMutationBlocker[]
}>

export type HostLockedPackageMutationSession = Readonly<{
  activate(input: {
    operationId: string
    archiveBytes: Uint8Array
    signal?: AbortSignal
  }): Promise<HostLockedPackageActivationRecord>
  confirmLkg(input: { operationId: string; signal?: AbortSignal }): Promise<HostLockedPackageActivationRecord>
  rollback(input: { operationId: string; signal?: AbortSignal }): Promise<HostLockedPackageActivationRecord>
  reconcile(input: { operationId: string; signal?: AbortSignal }): Promise<HostLockedPackageOperationHistory>
}>

export type HostLockedPackageMutationRuntime = Readonly<{
  status(): HostLockedPackageMutationStatus
  session(sessionKey: string): HostLockedPackageMutationSession
  close(): Promise<void>
}>

export class HostLockedPackageMutationRuntimeError extends Error {
  readonly code: 'BLOCKED' | 'BUSY' | 'CANCELLED' | 'CLOSED' | 'EXTRACT' | 'INVALID' | 'RECONCILE' | 'UNKNOWN'

  constructor(code: HostLockedPackageMutationRuntimeError['code']) {
    super(
      code === 'BLOCKED'
        ? 'locked package mutation is blocked by unavailable trusted dependencies'
        : code === 'BUSY'
          ? 'locked package operation is already in progress'
          : code === 'CANCELLED'
            ? 'locked package mutation was cancelled before dispatch'
            : code === 'CLOSED'
              ? 'locked package mutation runtime is closed'
              : code === 'EXTRACT'
                ? 'locked package safe extraction failed'
                : code === 'INVALID'
                  ? 'locked package mutation input is invalid'
                  : code === 'RECONCILE'
                    ? 'locked package reconciliation is unavailable'
                    : 'locked package mutation outcome is unknown; reconciliation is required',
    )
    this.name = 'HostLockedPackageMutationRuntimeError'
    this.code = code
  }
}

type CapturedEngine = {
  activate: HostLockedPackageMutationEngine['activate']
  confirmLkg: HostLockedPackageMutationEngine['confirmLkg']
  rollback: HostLockedPackageMutationEngine['rollback']
}

type CapturedConfiguration = {
  storeDirectory?: string
  engine?: CapturedEngine
  environment?: HostLockedPackageEnvironment
  verifySignature?: HostLockedPackageSignatureVerifier
  extractor?: HostLockedPackageSafeExtractor
}

function invalid(): never {
  throw new HostLockedPackageMutationRuntimeError('INVALID')
}

function plainOwn(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) invalid()
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function ownBoundMethod<T extends object, K extends keyof T>(value: T, key: K): T[K] {
  if (isProxy(value)) invalid()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    !descriptor ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function' ||
    isProxy(descriptor.value)
  )
    invalid()
  return Reflect.apply(Function.prototype.bind, descriptor.value, [value]) as T[K]
}

function requiredFunction<T extends (...args: never[]) => unknown>(value: unknown): T {
  if (typeof value !== 'function' || isProxy(value)) invalid()
  return value as T
}

function textToken(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || value !== value.normalize('NFC')) invalid()
  return value
}

function captureEnvironment(value: unknown): HostLockedPackageEnvironment {
  const input = plainOwn(value, ['agnesApiVersion', 'osVersion', 'platform'])
  if (Object.keys(input).length !== 3) invalid()
  return Object.freeze({
    agnesApiVersion: textToken(input.agnesApiVersion),
    platform: textToken(input.platform),
    osVersion: textToken(input.osVersion),
  })
}

function captureEngine(value: unknown): CapturedEngine {
  const input = plainOwn(value, ['activate', 'confirmLkg', 'rollback'])
  if (Object.keys(input).length !== 3) invalid()
  return Object.freeze({
    activate: ownBoundMethod(input as HostLockedPackageMutationEngine, 'activate'),
    confirmLkg: ownBoundMethod(input as HostLockedPackageMutationEngine, 'confirmLkg'),
    rollback: ownBoundMethod(input as HostLockedPackageMutationEngine, 'rollback'),
  })
}

function captureConfiguration(value: HostLockedPackageMutationOptions | undefined): CapturedConfiguration {
  if (value === undefined) return Object.freeze({})
  const input = plainOwn(value, CONFIGURATION_FIELDS)
  const storeDirectory = input.storeDirectory
  if (storeDirectory !== undefined && (typeof storeDirectory !== 'string' || !isAbsolute(storeDirectory)))
    invalid()
  return Object.freeze({
    ...(storeDirectory === undefined ? {} : { storeDirectory: resolve(storeDirectory) }),
    ...(input.engine === undefined ? {} : { engine: captureEngine(input.engine) }),
    ...(input.environment === undefined ? {} : { environment: captureEnvironment(input.environment) }),
    ...(input.verifySignature === undefined
      ? {}
      : { verifySignature: requiredFunction<HostLockedPackageSignatureVerifier>(input.verifySignature) }),
    ...(input.extractor === undefined
      ? {}
      : { extractor: requiredFunction<HostLockedPackageSafeExtractor>(input.extractor) }),
  })
}

async function availableStoreDirectory(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    const [stat, canonical] = await Promise.all([lstat(path), realpath(path)])
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
    return canonical
  } catch {
    return undefined
  }
}

const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'buffer',
)?.get

function archiveCopy(value: unknown): Uint8Array {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    !typedArrayByteLength ||
    !typedArrayBuffer
  )
    invalid()
  let length: number
  let buffer: ArrayBufferLike
  try {
    length = Reflect.apply(typedArrayByteLength, value, []) as number
    buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike
  } catch {
    invalid()
  }
  if (length < 1 || length > MAX_ARCHIVE_BYTES || buffer instanceof SharedArrayBuffer) invalid()
  const copy = new Uint8Array(length)
  Reflect.apply(Uint8Array.prototype.set, copy, [value])
  return copy
}

function operationId(value: unknown): string {
  return textToken(value)
}

function sessionKey(value: unknown): string {
  return textToken(value)
}

function scopedOperationId(store: string, session: string, operation: string): string {
  return `lp-${createHash('sha256').update(store).update('\0').update(session).update('\0').update(operation).digest('hex')}`
}

function validSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || isProxy(value)) invalid()
  try {
    Reflect.apply(
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get as (
        this: AbortSignal,
      ) => boolean,
      value,
      [],
    )
  } catch {
    invalid()
  }
  return value as AbortSignal
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (!signal) return false
  return Reflect.apply(
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get as (this: AbortSignal) => boolean,
    signal,
    [],
  ) as boolean
}

function relayAbort(from: AbortSignal | undefined, to: AbortController): () => void {
  if (!from) return () => undefined
  if (isAborted(from)) {
    to.abort()
    return () => undefined
  }
  const abort = (): void => to.abort()
  Reflect.apply(EventTarget.prototype.addEventListener, from, ['abort', abort, { once: true }])
  return () => Reflect.apply(EventTarget.prototype.removeEventListener, from, ['abort', abort])
}

function snapshotExtraction(value: unknown): HostLockedPackageSafeExtraction {
  const result = plainOwn(value, ['manifest', 'release', 'sourceDirectory'])
  if (Object.keys(result).length !== 3) invalid()
  if (
    typeof result.sourceDirectory !== 'string' ||
    !isAbsolute(result.sourceDirectory) ||
    result.sourceDirectory.length > 4096
  )
    invalid()
  if (typeof result.release !== 'function' || isProxy(result.release)) invalid()
  return Object.freeze({
    sourceDirectory: resolve(result.sourceDirectory),
    manifest: safeData(result.manifest),
    release: Reflect.apply(Function.prototype.bind, result.release, [value]) as () => Promise<void> | void,
  })
}

function safeData(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1
  if (budget.nodes > 2048 || depth > 8) invalid()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid()
  if (typeof value === 'string')
    return value.length <= 4096 && value === value.normalize('NFC') ? value : invalid()
  if (typeof value !== 'object' || isProxy(value)) invalid()
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > 128) invalid()
    if (Reflect.ownKeys(descriptors).length !== length + 1) invalid()
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) invalid()
      result.push(safeData(descriptor.value, depth + 1, budget))
    }
    return Object.freeze(result)
  }
  const object = plainOwn(value, Object.keys(Object.getOwnPropertyDescriptors(value)))
  if (Object.keys(object).length > 32) invalid()
  return Object.freeze(
    Object.fromEntries(
      Object.entries(object).map(([key, child]) => {
        if (key.length > 128 || key !== key.normalize('NFC')) invalid()
        return [key, safeData(child, depth + 1, budget)]
      }),
    ),
  )
}

function snapshotActivationRecord(value: unknown): HostLockedPackageActivationRecord {
  const record = safeData(value)
  const fields = plainOwn(record, [
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
  if (Object.keys(fields).length !== 10 || fields.schemaVersion !== 1) invalid()
  return record as HostLockedPackageActivationRecord
}

function blockersFor(
  configuration: CapturedConfiguration,
  storeDirectory: string | undefined,
): HostLockedPackageMutationBlocker[] {
  const blockers: HostLockedPackageMutationBlocker[] = []
  if (!storeDirectory) blockers.push('store-directory-unavailable')
  if (!configuration.engine) blockers.push('mutation-engine-unavailable')
  if (!configuration.environment) blockers.push('environment-unavailable')
  if (!configuration.verifySignature) blockers.push('publisher-keyring-unavailable')
  if (!configuration.extractor) blockers.push('safe-extraction-unavailable')
  // The current Base mutation API accepts pathname strings. A creation-time lstat/realpath cannot
  // pin either the store or an extracted source against ancestor replacement, so no combination of
  // pathname and extractor callbacks is production admission. This blocker stays until the engine
  // contract consumes repository-provided, fd-relative trusted directory capabilities.
  blockers.push('trusted-directory-handle-unavailable')
  return blockers
}

function unavailableReceipts(): HostLockedPackageOperationReceiptPort {
  const unavailable = (): never => {
    throw new HostLockedPackageMutationRuntimeError('RECONCILE')
  }
  return Object.freeze({
    read: async () => unavailable(),
    prepare: async () => unavailable(),
    commit: async () => unavailable(),
  })
}

function openLockedPackageReceipts(storage: SqliteStorage): HostLockedPackageOperationReceiptPort {
  try {
    return createSqliteLockedPackageOperationReceiptPort(storage)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E_LOCKED_PACKAGE_RECEIPT_'))
      return unavailableReceipts()
    throw error
  }
}

export async function createHostLockedPackageMutationRuntime(
  storage: SqliteStorage,
  options?: HostLockedPackageMutationOptions,
): Promise<HostLockedPackageMutationRuntime> {
  const receipts = openLockedPackageReceipts(storage)
  const configuration = captureConfiguration(options)
  const storeDirectory = await availableStoreDirectory(configuration.storeDirectory)
  const expectedStoreBindingSha256 =
    storeDirectory === undefined
      ? undefined
      : createHash('sha256').update(`agnes-locked-package-store\0${storeDirectory}`).digest('hex')
  const blockers = Object.freeze(blockersFor(configuration, storeDirectory))
  // Receipt reconciliation does not touch the package filesystem. It is useful while production
  // mutation remains blocked, but still needs the canonical store spelling to derive the same
  // per-store/per-session operation identity after restart.
  const recoveryReady = storeDirectory !== undefined
  const status = Object.freeze({
    activationReady: blockers.length === 0,
    recoveryReady,
    blockers,
  })
  const inflight = new Set<Promise<unknown>>()
  const active = new Set<string>()
  const unknown = new Set<string>()
  const extractionControllers = new Set<AbortController>()
  let closing = false

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work)
    void work.finally(() => inflight.delete(work)).catch(() => undefined)
    return work
  }

  const requireOpen = (): void => {
    if (closing) throw new HostLockedPackageMutationRuntimeError('CLOSED')
  }

  const requireMutationReady = (): void => {
    if (!status.activationReady) throw new HostLockedPackageMutationRuntimeError('BLOCKED')
  }

  const begin = (id: string, signal: AbortSignal | undefined): void => {
    requireOpen()
    if (isAborted(signal)) throw new HostLockedPackageMutationRuntimeError('CANCELLED')
    if (unknown.has(id)) throw new HostLockedPackageMutationRuntimeError('UNKNOWN')
    if (active.has(id)) throw new HostLockedPackageMutationRuntimeError('BUSY')
    active.add(id)
  }

  const mutate = async <T>(id: string, dispatch: () => Promise<T>): Promise<T> => {
    try {
      return await dispatch()
    } catch {
      unknown.add(id)
      throw new HostLockedPackageMutationRuntimeError('UNKNOWN')
    } finally {
      active.delete(id)
    }
  }

  const session = (rawSessionKey: string): HostLockedPackageMutationSession => {
    requireOpen()
    const session = sessionKey(rawSessionKey)
    const context = (): {
      engine: CapturedEngine
      environment: HostLockedPackageEnvironment
      storeDirectory: string
      verifySignature: HostLockedPackageSignatureVerifier
    } => {
      requireOpen()
      requireMutationReady()
      return {
        engine: configuration.engine as CapturedEngine,
        environment: configuration.environment as HostLockedPackageEnvironment,
        storeDirectory: storeDirectory as string,
        verifySignature: configuration.verifySignature as HostLockedPackageSignatureVerifier,
      }
    }
    const scoped = (rawOperationId: string): string =>
      scopedOperationId(storeDirectory ?? '', session, operationId(rawOperationId))
    return Object.freeze({
      activate(input) {
        const task = (async (): Promise<HostLockedPackageActivationRecord> => {
          requireMutationReady()
          const fields = plainOwn(input, ['archiveBytes', 'operationId', 'signal'])
          if (!('archiveBytes' in fields) || !('operationId' in fields)) invalid()
          const signal = validSignal(fields.signal)
          const id = scoped(fields.operationId as string)
          begin(id, signal)
          let extraction: HostLockedPackageSafeExtraction | undefined
          const extractionController = new AbortController()
          extractionControllers.add(extractionController)
          const stopRelay = relayAbort(signal, extractionController)
          try {
            const archiveBytes = archiveCopy(fields.archiveBytes)
            const extractionBytes = new Uint8Array(archiveBytes)
            if (closing || isAborted(signal)) throw new HostLockedPackageMutationRuntimeError('CANCELLED')
            try {
              extraction = snapshotExtraction(
                await (configuration.extractor as HostLockedPackageSafeExtractor)({
                  archiveBytes: extractionBytes,
                  signal: extractionController.signal,
                }),
              )
            } catch {
              if (closing || isAborted(signal)) throw new HostLockedPackageMutationRuntimeError('CANCELLED')
              throw new HostLockedPackageMutationRuntimeError('EXTRACT')
            }
            if (closing || isAborted(signal)) throw new HostLockedPackageMutationRuntimeError('CANCELLED')
            const bound = context()
            return await mutate(id, async () =>
              snapshotActivationRecord(
                await bound.engine.activate({
                  sourceDirectory: extraction?.sourceDirectory as string,
                  storeDirectory: bound.storeDirectory,
                  manifest: extraction?.manifest,
                  sourceArchiveBytes: archiveBytes,
                  environment: bound.environment,
                  verifySignature: bound.verifySignature,
                  operation: { operationId: id, receipts },
                }),
              ),
            )
          } finally {
            stopRelay()
            extractionControllers.delete(extractionController)
            if (active.has(id)) active.delete(id)
            if (extraction)
              try {
                await extraction.release()
              } catch {
                // A staging cleanup failure cannot rewrite a known mutation result.
              }
          }
        })()
        return track(task)
      },
      confirmLkg(input) {
        const task = (async (): Promise<HostLockedPackageActivationRecord> => {
          const fields = plainOwn(input, ['operationId', 'signal'])
          if (!('operationId' in fields)) invalid()
          const signal = validSignal(fields.signal)
          const id = scoped(fields.operationId as string)
          const bound = context()
          begin(id, signal)
          return mutate(id, async () =>
            snapshotActivationRecord(
              await bound.engine.confirmLkg({
                storeDirectory: bound.storeDirectory,
                environment: bound.environment,
                verifySignature: bound.verifySignature,
                operation: { operationId: id, receipts },
              }),
            ),
          )
        })()
        return track(task)
      },
      rollback(input) {
        const task = (async (): Promise<HostLockedPackageActivationRecord> => {
          const fields = plainOwn(input, ['operationId', 'signal'])
          if (!('operationId' in fields)) invalid()
          const signal = validSignal(fields.signal)
          const id = scoped(fields.operationId as string)
          const bound = context()
          begin(id, signal)
          return mutate(id, async () =>
            snapshotActivationRecord(
              await bound.engine.rollback({
                storeDirectory: bound.storeDirectory,
                environment: bound.environment,
                verifySignature: bound.verifySignature,
                operation: { operationId: id, receipts },
              }),
            ),
          )
        })()
        return track(task)
      },
      reconcile(input) {
        const task = (async (): Promise<HostLockedPackageOperationHistory> => {
          const fields = plainOwn(input, ['operationId', 'signal'])
          if (!('operationId' in fields)) invalid()
          const signal = validSignal(fields.signal)
          const id = scoped(fields.operationId as string)
          requireOpen()
          if (!status.recoveryReady) throw new HostLockedPackageMutationRuntimeError('BLOCKED')
          if (isAborted(signal)) throw new HostLockedPackageMutationRuntimeError('CANCELLED')
          if (active.has(id)) throw new HostLockedPackageMutationRuntimeError('BUSY')
          active.add(id)
          try {
            let history: HostLockedPackageOperationHistory
            try {
              const receipt = await receipts.read(id)
              if (receipt !== null && receipt.storeBindingSha256 !== expectedStoreBindingSha256)
                throw new HostLockedPackageMutationRuntimeError('RECONCILE')
              history = receipt
                ? Object.freeze({
                    historyOnly: true,
                    outcome: receipt.phase === 'committed' ? ('committed' as const) : ('unknown' as const),
                    record: snapshotActivationRecord(receipt.result),
                  })
                : Object.freeze({ historyOnly: true, outcome: 'not-found' as const })
            } catch {
              throw new HostLockedPackageMutationRuntimeError('RECONCILE')
            }
            if (history.outcome === 'unknown') unknown.add(id)
            else unknown.delete(id)
            return history
          } finally {
            active.delete(id)
          }
        })()
        return track(task)
      },
    })
  }

  return Object.freeze({
    status: () => status,
    session,
    async close(): Promise<void> {
      if (closing) {
        await Promise.allSettled([...inflight])
        return
      }
      closing = true
      for (const controller of extractionControllers) controller.abort()
      await Promise.allSettled([...inflight])
    },
  })
}
