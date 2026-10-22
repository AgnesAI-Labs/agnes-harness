import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type PackageBlocker, validatePackageAdminData, validatePluginMetadata } from '@agnes/protocol'
import { renameWriteThroughSync } from '@agnes/system-node'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { validAgentDeclarations, validApplicationDeclaration } from './agent-declarations.js'
import { collectRead, collectReadAsync, directoryDigestSteps, type ReadSteps } from './cooperative-read.js'
import { copyPackageTreeSync } from './copy-tree.js'
import { PackageError } from './errors.js'
import { mapFileChecks } from './file-read-pool.js'
import {
  canonical,
  capabilityHash,
  freezeData,
  own,
  readStaticJson,
  snapshotHash,
  syncDirectory,
} from './integrity.js'
import {
  type InstalledPackage,
  type InventoryVerificationCache,
  isSnapshotPackageEligible,
  verifyHashedPackageDirectory,
  verifyPackageDirectory,
} from './inventory.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { assertCurrentBinding, hasSnapshotTrust } from './runtime-snapshot-binding.js'
import { contributionCeiling, recordEntry, runtimeSnapshotId } from './runtime-snapshot-entry.js'
import type {
  CreateJournal,
  GcJournal,
  PinRecord,
  RuntimeJournal,
  RuntimePin,
  RuntimePinPurpose,
  RuntimeSnapshot,
  RuntimeSnapshotCollection,
  RuntimeSnapshotPinRequest,
  RuntimeSnapshotStore,
  RuntimeState,
  SnapshotRecord,
} from './runtime-snapshot-types.js'
import { hashDirectory, packageDir, parseSource } from './sources.js'
import { previousPackageDir } from './store.js'
import { invalidatePackageVerification } from './verification-operation.js'

export type {
  RuntimePin,
  RuntimePinPurpose,
  RuntimeSnapshot,
  RuntimeSnapshotCollection,
  RuntimeSnapshotPinRequest,
  RuntimeSnapshotSelector,
  RuntimeSnapshotStore,
} from './runtime-snapshot-types.js'

const SHA256 = /^sha256-[a-f0-9]{64}$/
const INTEGRITY = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const PURPOSES = new Set<RuntimePinPurpose>(['active', 'candidate', 'recovery', 'rollback', 'turn'])
const MAX_RECORDS = 4096
// Parsing/shape/identity validation is pure for this complete JSON value. Disk, directory trees and
// current trust are still read every time; callers receive a clone so writers cannot poison reuse.
const decodedStates = new Map<string, RuntimeState>()
let decodedStateBytes = 0
const statePath = (s: RuntimeSnapshotStore) => join(s.profileDir, '.agnes-runtime-snapshots.json')
const journalPath = (s: RuntimeSnapshotStore) => join(s.profileDir, '.agnes-runtime-transaction.json')
const runtimeRoot = (s: RuntimeSnapshotStore) =>
  join(dirname(packageDir(s.dataDir, s.profile, 'runtime-root')), '.runtime-snapshots')
const snapshotDir = (s: RuntimeSnapshotStore, snapshotId: string) => join(runtimeRoot(s), snapshotId)

function integrityFailure(reason: string): never {
  throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot store requires recovery', {
    detail: { reason },
  })
}
function stateFailure(reason: string): never {
  throw new PackageError('E_EXT_LOAD', 'runtime snapshot state is unavailable', { detail: { reason } })
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort()) === canonical([...keys].sort())
}
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function validateToken(value: unknown, reason: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !TOKEN.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    integrityFailure(reason)
}
function validateRecord(raw: unknown): SnapshotRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrityFailure('snapshot-shape')
  const value = raw as Record<string, unknown>
  assertCurrentPackageFormat(value)
  if (value.version !== 2)
    throw new PackageError(
      'E_LOCK_MISMATCH',
      'Retired runtime snapshot format; select a new, empty AGH_HOME (clean home).',
      { detail: { reason: 'clean-home-required' } },
    )
  if (
    !exactKeys(value, [
      'version',
      'snapshotId',
      'packageId',
      'packageVersion',
      'integrity',
      'treeIntegrity',
      'capabilityHash',
      'source',
      'license',
      'releasedAt',
      'dependencies',
      'contributions',
      ...(value.metadata === undefined ? [] : ['metadata']),
      ...(value.agents === undefined ? [] : ['agents']),
      ...(value.application === undefined ? [] : ['application']),
      ...(value.declaredCapabilities === undefined ? [] : ['declaredCapabilities']),
    ]) ||
    (value.declaredCapabilities !== undefined &&
      !validatePackageAdminData('PluginCapabilities', value.declaredCapabilities).ok) ||
    (value.metadata !== undefined && !validatePluginMetadata(value.metadata).ok) ||
    typeof value.snapshotId !== 'string' ||
    !SHA256.test(value.snapshotId) ||
    typeof value.packageId !== 'string' ||
    typeof value.packageVersion !== 'string' ||
    value.packageVersion.length > 64 ||
    typeof value.integrity !== 'string' ||
    !INTEGRITY.test(value.integrity) ||
    typeof value.treeIntegrity !== 'string' ||
    !SHA256.test(value.treeIntegrity) ||
    typeof value.capabilityHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.capabilityHash) ||
    typeof value.license !== 'string' ||
    value.license.length > 64 ||
    (value.releasedAt !== null &&
      (typeof value.releasedAt !== 'string' || !Number.isFinite(Date.parse(value.releasedAt)))) ||
    !validatePackageAdminData('PackageSource', value.source).ok ||
    !value.dependencies ||
    typeof value.dependencies !== 'object' ||
    Array.isArray(value.dependencies) ||
    !Array.isArray(value.contributions) ||
    value.contributions.length > 128
  )
    integrityFailure('snapshot-shape')
  for (const [id, range] of Object.entries(value.dependencies as Record<string, unknown>))
    if (!id || id.length > 256 || typeof range !== 'string' || range.length > 1024)
      integrityFailure('snapshot-dependencies')
  for (const contribution of value.contributions)
    if (!validatePackageAdminData('PackageContributionSummary', contribution).ok)
      integrityFailure('snapshot-contribution')
  if (
    !validApplicationDeclaration(value.application) ||
    !validAgentDeclarations(value.agents, String(value.packageId))
  )
    integrityFailure('snapshot-launch-declarations')
  const record = value as unknown as SnapshotRecord
  if (
    record.snapshotId !==
      runtimeSnapshotId({
        packageId: record.packageId,
        version: record.packageVersion,
        integrity: record.integrity,
        treeIntegrity: record.treeIntegrity,
        capabilityHash: record.capabilityHash,
        recordVersion: 2,
      }) ||
    capabilityHash(record) !== record.capabilityHash
  )
    integrityFailure('snapshot-identity')
  return structuredClone(record)
}
function validatePin(raw: unknown): PinRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrityFailure('pin-shape')
  const value = raw as Record<string, unknown>
  if (!exactKeys(value, ['pinId', 'operationId', 'purpose', 'packageId', 'snapshotId', 'requestHash']))
    integrityFailure('pin-shape')
  validateToken(value.pinId, 'pin-id')
  validateToken(value.operationId, 'operation-id')
  if (typeof value.purpose !== 'string' || !PURPOSES.has(value.purpose as RuntimePinPurpose))
    integrityFailure('pin-purpose')
  if (
    typeof value.packageId !== 'string' ||
    typeof value.snapshotId !== 'string' ||
    !SHA256.test(value.snapshotId) ||
    typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestHash)
  )
    integrityFailure('pin-shape')
  return structuredClone(value as unknown as PinRecord)
}
function readState(s: RuntimeSnapshotStore): RuntimeState {
  const file = statePath(s)
  if (!present(file)) return { version: 1, snapshots: {}, pins: {} }
  if (lstatSync(file).isSymbolicLink()) integrityFailure('runtime-state-symlink')
  const raw = readStaticJson(file)
  const key = JSON.stringify(raw)
  const cached = decodedStates.get(key)
  if (cached) return structuredClone(cached)
  if (!exactKeys(raw, ['version', 'snapshots', 'pins']) || raw.version !== 1)
    integrityFailure('runtime-state-shape')
  if (
    !raw.snapshots ||
    typeof raw.snapshots !== 'object' ||
    Array.isArray(raw.snapshots) ||
    !raw.pins ||
    typeof raw.pins !== 'object' ||
    Array.isArray(raw.pins)
  )
    integrityFailure('runtime-state-shape')
  const snapshotEntries = Object.entries(raw.snapshots as Record<string, unknown>)
  const pinEntries = Object.entries(raw.pins as Record<string, unknown>)
  if (snapshotEntries.length > MAX_RECORDS || pinEntries.length > MAX_RECORDS)
    integrityFailure('runtime-state-size')
  const snapshots: RuntimeState['snapshots'] = {}
  for (const [key, entry] of snapshotEntries) {
    const checked = validateRecord(entry)
    if (key !== checked.snapshotId) integrityFailure('snapshot-key')
    snapshots[key] = checked
  }
  const pins: RuntimeState['pins'] = {}
  for (const [key, entry] of pinEntries) {
    const checked = validatePin(entry),
      snapshot = snapshots[checked.snapshotId]
    if (key !== checked.pinId || !snapshot || snapshot.packageId !== checked.packageId)
      integrityFailure('pin-key')
    pins[key] = checked
  }
  const state: RuntimeState = { version: 1, snapshots, pins }
  while (decodedStates.size >= 4 || decodedStateBytes + key.length * 2 > 4 * 1024 * 1024) {
    const oldest = decodedStates.keys().next().value
    if (oldest === undefined) break
    decodedStates.delete(oldest)
    decodedStateBytes -= oldest.length * 2
  }
  decodedStates.set(key, freezeData(structuredClone(state)))
  decodedStateBytes += key.length * 2
  return state
}
function writeState(s: RuntimeSnapshotStore, state: RuntimeState): void {
  const file = statePath(s),
    tmp = `${file}.tmp`,
    serialized = `${JSON.stringify(state)}\n`
  if (Buffer.byteLength(serialized) > 1048576) integrityFailure('runtime-state-size')
  mkdirSync(s.profileDir, { recursive: true })
  writeFileSync(tmp, serialized, { mode: 0o600, flush: true })
  renameWriteThroughSync(resolve(tmp), resolve(file))
}
function recordFromEntry(packageId: string, entry: LockEntry): SnapshotRecord {
  if (!entry.treeIntegrity || !entry.contributions) integrityFailure('snapshot-migration-required')
  const hash = capabilityHash(entry)
  return {
    version: 2,
    snapshotId: runtimeSnapshotId({
      packageId,
      version: entry.version,
      integrity: entry.integrity,
      treeIntegrity: entry.treeIntegrity,
      capabilityHash: hash,
      recordVersion: 2,
    }),
    packageId,
    packageVersion: entry.version,
    integrity: entry.integrity,
    treeIntegrity: entry.treeIntegrity,
    capabilityHash: hash,
    source: structuredClone(entry.source),
    license: entry.license,
    releasedAt: entry.releasedAt ?? null,
    dependencies: structuredClone(entry.dependencies),
    contributions: structuredClone(entry.contributions),
    ...(entry.metadata ? { metadata: structuredClone(entry.metadata) } : {}),
    ...(entry.agents ? { agents: structuredClone(entry.agents) } : {}),
    ...(entry.application ? { application: structuredClone(entry.application) } : {}),
    ...(entry.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: structuredClone(entry.declaredCapabilities) }),
  }
}
function* verifyRecordSteps(
  s: RuntimeSnapshotStore,
  record: SnapshotRecord,
  directory: string,
  verificationCache?: InventoryVerificationCache,
): ReadSteps<RuntimeSnapshot> {
  const checkedRecord = validateRecord(record)
  let root: string, actual: string
  try {
    root = nativeRealpathSync(runtimeRoot(s))
    actual = nativeRealpathSync(directory)
    if (lstatSync(runtimeRoot(s)).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
      integrityFailure('runtime-path-symlink')
  } catch (error) {
    if (error instanceof PackageError) throw error
    integrityFailure('runtime-path-missing')
  }
  if (!contained(root, actual) || actual === root || basename(actual) !== checkedRecord.snapshotId)
    integrityFailure('runtime-path-escape')
  const treeIntegrity = yield* directoryDigestSteps(actual, {
    ...checkedRecord,
    version: checkedRecord.packageVersion,
  })
  if (treeIntegrity !== checkedRecord.treeIntegrity) integrityFailure('runtime-tree-mismatch')
  const source = parseSource(checkedRecord.source.ref)
  if (canonical(source) !== canonical(checkedRecord.source)) integrityFailure('runtime-source-mismatch')
  // Reuse only static interpretation after this read has verified every byte. The cache key
  // includes the record, canonical directory, digest and ceiling; execution/recovery omit it.
  verifyHashedPackageDirectory(
    checkedRecord.packageId,
    recordEntry(checkedRecord),
    actual,
    contributionCeiling(checkedRecord),
    treeIntegrity,
    verificationCache,
  )
  return freezeData({
    snapshotId: checkedRecord.snapshotId,
    profile: s.profile,
    packageId: checkedRecord.packageId,
    version: checkedRecord.packageVersion,
    integrity: checkedRecord.integrity,
    treeIntegrity: checkedRecord.treeIntegrity,
    capabilityHash: checkedRecord.capabilityHash,
    directory: actual,
    contributions: structuredClone(checkedRecord.contributions),
    ...(checkedRecord.metadata ? { metadata: structuredClone(checkedRecord.metadata) } : {}),
    ...(checkedRecord.agents ? { agents: structuredClone(checkedRecord.agents) } : {}),
    ...(checkedRecord.application ? { application: structuredClone(checkedRecord.application) } : {}),
  })
}
function verifyRecord(s: RuntimeSnapshotStore, record: SnapshotRecord, directory: string): RuntimeSnapshot {
  return collectRead(verifyRecordSteps(s, record, directory))
}
function pinView(
  s: RuntimeSnapshotStore,
  state: RuntimeState,
  pin: PinRecord,
  verified?: RuntimeSnapshot,
  current?: LockEntry,
): RuntimePin {
  const record = state.snapshots[pin.snapshotId]
  if (!record) integrityFailure('pin-snapshot-missing')
  assertCurrentBinding(record, current)
  return freezeData({
    pinId: pin.pinId,
    operationId: pin.operationId,
    purpose: pin.purpose,
    snapshot: verified ?? verifyRecord(s, record, snapshotDir(s, record.snapshotId)),
  })
}
function validateRequest(s: RuntimeSnapshotStore, request: RuntimeSnapshotPinRequest): string {
  if (!request || typeof request !== 'object' || !request.selector || typeof request.selector !== 'object')
    integrityFailure('pin-request')
  if (
    !exactKeys(request as unknown as Record<string, unknown>, [
      'pinId',
      'operationId',
      'packageId',
      'purpose',
      'selector',
    ])
  )
    integrityFailure('pin-request')
  validateToken(request.pinId, 'pin-id')
  validateToken(request.operationId, 'operation-id')
  if (!PURPOSES.has(request.purpose) || typeof request.packageId !== 'string') integrityFailure('pin-request')
  if (!['installed', 'previous', 'snapshot'].includes(request.selector.kind)) integrityFailure('pin-selector')
  const selectorKeys =
    request.selector.kind === 'snapshot'
      ? ['kind', 'snapshotId', 'expectedIntegrity', 'expectedTreeIntegrity']
      : ['kind', 'expectedIntegrity', 'expectedTreeIntegrity']
  if (!exactKeys(request.selector as unknown as Record<string, unknown>, selectorKeys))
    integrityFailure('pin-selector')
  if (
    !INTEGRITY.test(request.selector.expectedIntegrity) ||
    !SHA256.test(request.selector.expectedTreeIntegrity) ||
    (request.selector.kind === 'snapshot' && !SHA256.test(request.selector.snapshotId))
  )
    integrityFailure('pin-selector')
  try {
    packageDir(s.dataDir, s.profile, request.packageId)
  } catch {
    integrityFailure('package-id')
  }
  return snapshotHash(request)
}
function select(
  s: RuntimeSnapshotStore,
  lock: Lockfile,
  state: RuntimeState,
  request: RuntimeSnapshotPinRequest,
  installedPackage: (id: string) => InstalledPackage,
  ceiling: readonly string[],
): { record: SnapshotRecord; directory: string; existing: boolean } {
  let live: InstalledPackage
  try {
    live = installedPackage(request.packageId)
  } catch {
    stateFailure('package-not-found')
  }
  if (!isSnapshotPackageEligible(live))
    throw blocked(
      live.blockers.length ? live.blockers : [{ code: 'policy', references: ['package-not-eligible'] }],
    )
  if (request.selector.kind === 'snapshot') {
    const record = state.snapshots[request.selector.snapshotId]
    if (!record || record.packageId !== request.packageId) stateFailure('snapshot-not-found')
    assertCurrentBinding(record, live.entry)
    if (
      record.integrity !== request.selector.expectedIntegrity ||
      record.treeIntegrity !== request.selector.expectedTreeIntegrity
    )
      integrityFailure('snapshot-selector-stale')
    verifyRecord(s, record, snapshotDir(s, record.snapshotId))
    const verified = verifyPackageDirectory(
      record.packageId,
      recordEntry(record),
      snapshotDir(s, record.snapshotId),
      ceiling,
    )
    if (verified.blockers.length) throw blocked(verified.blockers)
    return { record, directory: snapshotDir(s, record.snapshotId), existing: true }
  }
  let entry: LockEntry | undefined
  let directory: string
  if (request.selector.kind === 'installed') {
    // `live` came from this same synchronous call; asking again would re-hash every installed
    // package for an identical answer.
    if (!live.directory) stateFailure('installed-directory-missing')
    if (live.blockers.length) throw blocked(live.blockers)
    entry = live.entry
    directory = live.directory
  } else {
    const current = own(lock.packages, request.packageId)
    if (!current?.previous?.treeIntegrity || !current.previous.source)
      stateFailure('previous-snapshot-missing')
    entry = { ...structuredClone(current.previous), previous: null } as LockEntry
    directory = previousPackageDir(s, request.packageId)
  }
  const record = recordFromEntry(request.packageId, entry)
  if (!hasSnapshotTrust(entry, record))
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'runtime snapshot has no valid trust decision')
  if (
    record.integrity !== request.selector.expectedIntegrity ||
    record.treeIntegrity !== request.selector.expectedTreeIntegrity
  )
    integrityFailure('snapshot-selector-stale')
  if (request.selector.kind === 'previous' && !present(directory)) stateFailure('previous-directory-missing')
  if (request.selector.kind === 'previous') {
    const verified = verifyPackageDirectory(request.packageId, entry, directory, ceiling)
    if (verified.blockers.length) throw blocked(verified.blockers)
  }
  return { record, directory, existing: false }
}
function blocked(blockers: readonly PackageBlocker[]): PackageError {
  return new PackageError('E_API_RANGE', 'runtime snapshot is blocked', {
    detail: { blockers: structuredClone(blockers) },
  })
}
function writeJournal(s: RuntimeSnapshotStore, journal: RuntimeJournal): void {
  const file = journalPath(s),
    tmp = `${file}.tmp`,
    serialized = `${JSON.stringify(journal)}\n`
  if (Buffer.byteLength(serialized) > 1048576) integrityFailure('runtime-journal-size')
  writeFileSync(tmp, serialized, { mode: 0o600, flush: true })
  renameWriteThroughSync(resolve(tmp), resolve(file))
}
function readJournal(s: RuntimeSnapshotStore): RuntimeJournal {
  if (lstatSync(journalPath(s)).isSymbolicLink()) integrityFailure('runtime-journal-symlink')
  const raw = readStaticJson(journalPath(s))
  if (
    raw.version !== 1 ||
    typeof raw.transactionId !== 'string' ||
    !UUID.test(raw.transactionId) ||
    (raw.kind !== 'create' && raw.kind !== 'gc')
  )
    integrityFailure('runtime-journal-shape')
  if (raw.kind === 'create') {
    if (!exactKeys(raw, ['version', 'kind', 'transactionId', 'stage', 'snapshot', 'pin']))
      integrityFailure('runtime-journal-shape')
    if (
      typeof raw.stage !== 'string' ||
      raw.stage !== `.stage-${raw.transactionId}` ||
      !raw.snapshot ||
      !raw.pin
    )
      integrityFailure('runtime-journal-shape')
    const snapshot = validateRecord(raw.snapshot),
      pin = validatePin(raw.pin)
    if (pin.snapshotId !== snapshot.snapshotId || pin.packageId !== snapshot.packageId)
      integrityFailure('runtime-journal-identity')
    return {
      version: 1,
      kind: 'create',
      transactionId: raw.transactionId,
      stage: raw.stage,
      snapshot,
      pin,
    }
  }
  if (!exactKeys(raw, ['version', 'kind', 'transactionId', 'trash', 'snapshot']))
    integrityFailure('runtime-journal-shape')
  if (typeof raw.trash !== 'string' || raw.trash !== `.trash-${raw.transactionId}` || !raw.snapshot)
    integrityFailure('runtime-journal-shape')
  return {
    version: 1,
    kind: 'gc',
    transactionId: raw.transactionId,
    trash: raw.trash,
    snapshot: validateRecord(raw.snapshot),
  }
}
function exactTree(path: string, expected: string): void {
  if (!present(path) || hashDirectory(path, { exclude: [] }) !== expected)
    integrityFailure('runtime-transaction-tree')
}
function clearJournal(s: RuntimeSnapshotStore): void {
  rmSync(journalPath(s))
  rmSync(`${journalPath(s)}.tmp`, { force: true })
  syncDirectory(s.profileDir)
  invalidatePackageVerification()
  s.runtimeCheckpoint?.('runtime-finished')
}

/** Caller holds the PackageManager Profile lock. Runtime state never decides the active revision. */
function* runtimeRecoverySteps(s: RuntimeSnapshotStore): ReadSteps<void> {
  const root = runtimeRoot(s)
  rmSync(`${statePath(s)}.tmp`, { force: true })
  if (!present(journalPath(s))) {
    rmSync(`${journalPath(s)}.tmp`, { force: true })
    yield* knownRuntimeDirectoryReadSteps(s, readState(s))
    return
  }
  invalidatePackageVerification()
  const state = readState(s),
    journal = readJournal(s),
    trash = join(root, `.trash-${journal.transactionId}`)
  mkdirSync(root, { recursive: true })
  if (journal.kind === 'create') {
    // Only a verified abandoned copy enters this journal's trash; a partial delete of it is expected.
    rmSync(trash, { recursive: true, force: true })
    const destination = snapshotDir(s, journal.snapshot.snapshotId),
      stage = join(root, journal.stage),
      committed = state.pins[journal.pin.pinId]
    if (committed) {
      if (
        canonical(committed) !== canonical(journal.pin) ||
        canonical(state.snapshots[journal.snapshot.snapshotId]) !== canonical(journal.snapshot)
      )
        integrityFailure('runtime-journal-state-mismatch')
      verifyRecord(s, journal.snapshot, destination)
      if (present(stage)) integrityFailure('runtime-stage-after-commit')
    } else {
      if (state.snapshots[journal.snapshot.snapshotId]) integrityFailure('runtime-journal-state-mismatch')
      if (present(destination)) {
        exactTree(destination, journal.snapshot.treeIntegrity)
        renameSync(destination, trash)
        rmSync(trash, { recursive: true })
      }
      // The journal owns this UUID stage before copying starts, so a partial copy is safe to remove.
      if (present(stage)) rmSync(stage, { recursive: true })
    }
    clearJournal(s)
    return
  }
  const destination = snapshotDir(s, journal.snapshot.snapshotId),
    committed = !state.snapshots[journal.snapshot.snapshotId]
  if (committed) {
    if (present(destination)) integrityFailure('runtime-gc-destination-after-commit')
    // Collected and verified before the state commit; a crash part-way through its delete is expected.
    rmSync(trash, { recursive: true, force: true })
  } else if (present(trash)) {
    if (present(destination)) integrityFailure('runtime-gc-path-collision')
    exactTree(trash, journal.snapshot.treeIntegrity)
    renameSync(trash, destination)
  } else verifyRecord(s, journal.snapshot, destination)
  clearJournal(s)
}

export function recoverRuntimeSnapshotStore(s: RuntimeSnapshotStore): void {
  collectRead(runtimeRecoverySteps(s))
}
export function recoverRuntimeSnapshotStoreAsync(s: RuntimeSnapshotStore): Promise<void> {
  return collectReadAsync(runtimeRecoverySteps(s), false)
}

function* knownRuntimeDirectoryReadSteps(
  s: RuntimeSnapshotStore,
  state: RuntimeState,
): ReadSteps<Map<string, RuntimeSnapshot>> {
  const verified = new Map<string, RuntimeSnapshot>()
  assertRuntimeDirectoryEntries(s, state)
  for (const record of Object.values(state.snapshots))
    verified.set(record.snapshotId, yield* verifyRecordSteps(s, record, snapshotDir(s, record.snapshotId)))
  return verified
}

function assertRuntimeDirectoryEntries(s: RuntimeSnapshotStore, state: RuntimeState): void {
  const root = runtimeRoot(s)
  if (!present(root)) {
    if (Object.keys(state.snapshots).length) integrityFailure('runtime-root-missing')
    return
  }
  if (lstatSync(root).isSymbolicLink()) integrityFailure('runtime-root-symlink')
  for (const entry of readdirSync(root))
    if (!Object.hasOwn(state.snapshots, entry)) integrityFailure('unknown-runtime-directory')
}

export function pinRuntimeSnapshotStore(
  s: RuntimeSnapshotStore,
  lock: Lockfile,
  request: RuntimeSnapshotPinRequest,
  installedPackage: (id: string) => InstalledPackage,
  ceiling: readonly string[],
): RuntimePin {
  const requestHash = validateRequest(s, request),
    state = readState(s)
  collectRead(knownRuntimeDirectoryReadSteps(s, state))
  if (!own(lock.packages, request.packageId)) stateFailure('package-not-installed')
  const prior = state.pins[request.pinId]
  if (prior) {
    if (
      prior.requestHash !== requestHash ||
      prior.operationId !== request.operationId ||
      prior.packageId !== request.packageId ||
      prior.purpose !== request.purpose
    )
      integrityFailure('pin-id-reused')
    return pinView(s, state, prior, undefined, own(lock.packages, prior.packageId))
  }
  if (Object.keys(state.pins).length >= MAX_RECORDS) integrityFailure('runtime-state-size')
  const selected = select(s, lock, state, request, installedPackage, ceiling),
    pin: PinRecord = {
      pinId: request.pinId,
      operationId: request.operationId,
      purpose: request.purpose,
      packageId: request.packageId,
      snapshotId: selected.record.snapshotId,
      requestHash,
    }
  const existing = state.snapshots[selected.record.snapshotId]
  if (existing) {
    if (canonical(existing) !== canonical(selected.record)) integrityFailure('snapshot-id-collision')
    state.pins[pin.pinId] = pin
    writeState(s, state)
    return pinView(s, state, pin)
  }
  if (selected.existing) integrityFailure('snapshot-state-missing')
  if (Object.keys(state.snapshots).length >= MAX_RECORDS) integrityFailure('runtime-state-size')
  const root = runtimeRoot(s),
    transactionId = randomUUID(),
    stageName = `.stage-${transactionId}`,
    stage = join(root, stageName),
    destination = snapshotDir(s, selected.record.snapshotId),
    journal: CreateJournal = {
      version: 1,
      kind: 'create',
      transactionId,
      stage: stageName,
      snapshot: selected.record,
      pin,
    }
  mkdirSync(root, { recursive: true })
  if (present(stage) || present(destination) || present(journalPath(s)))
    integrityFailure('runtime-path-collision')
  writeJournal(s, journal)
  s.runtimeCheckpoint?.('runtime-prepared')
  copyPackageTreeSync(selected.directory, stage)
  verifyPackageDirectory(
    selected.record.packageId,
    recordEntry(selected.record),
    stage,
    contributionCeiling(selected.record),
  )
  renameSync(stage, destination)
  syncDirectory(root)
  s.runtimeCheckpoint?.('runtime-snapshot-moved')
  state.snapshots[selected.record.snapshotId] = selected.record
  state.pins[pin.pinId] = pin
  writeState(s, state)
  s.runtimeCheckpoint?.('runtime-state-written')
  clearJournal(s)
  return pinView(s, state, pin)
}

export function resolveRuntimePinStore(
  s: RuntimeSnapshotStore,
  request: Readonly<{ pinId: string; expectedSnapshotId?: string }>,
  lock?: Lockfile,
  packageEligible?: (packageId: string) => boolean,
): RuntimePin {
  validateToken(request.pinId, 'pin-id')
  if (request.expectedSnapshotId !== undefined && !SHA256.test(request.expectedSnapshotId))
    integrityFailure('snapshot-id')
  const state = readState(s)
  collectRead(knownRuntimeDirectoryReadSteps(s, state))
  const pin = state.pins[request.pinId]
  if (!pin) stateFailure('pin-not-found')
  if (request.expectedSnapshotId !== undefined && pin.snapshotId !== request.expectedSnapshotId)
    integrityFailure('pin-snapshot-stale')
  if (lock) {
    const current = own(lock.packages, pin.packageId)
    if (!current) stateFailure('package-not-found')
    if (current.state.trusted === null || (packageEligible && !packageEligible(pin.packageId)))
      stateFailure('package-not-eligible')
  }
  return pinView(s, state, pin, undefined, lock && own(lock.packages, pin.packageId))
}

export function releaseRuntimePinStore(
  s: RuntimeSnapshotStore,
  request: Readonly<{ pinId: string; expectedSnapshotId: string }>,
): void {
  validateToken(request.pinId, 'pin-id')
  if (!SHA256.test(request.expectedSnapshotId)) integrityFailure('snapshot-id')
  const state = readState(s)
  collectRead(knownRuntimeDirectoryReadSteps(s, state))
  const pin = state.pins[request.pinId]
  if (!pin) return
  if (pin.snapshotId !== request.expectedSnapshotId) integrityFailure('pin-snapshot-stale')
  delete state.pins[request.pinId]
  writeState(s, state)
}

export function runtimePinBlockers(s: RuntimeSnapshotStore, packageId: string): PackageBlocker[] {
  const state = readState(s)
  collectRead(knownRuntimeDirectoryReadSteps(s, state))
  const all = Object.values(state.pins)
    .filter((pin) => pin.packageId === packageId)
    .map((pin) => `runtime-pin:${pin.purpose}:${pin.pinId}`)
    .sort()
  const references = all.length > 128 ? [...all.slice(0, 127), `runtime-pin:more:${all.length - 127}`] : all
  return references.length ? [{ code: 'generation', references }] : []
}

export function listRuntimePinsStore(s: RuntimeSnapshotStore): RuntimePin[] {
  const state = readState(s)
  const verified = collectRead(knownRuntimeDirectoryReadSteps(s, state))
  return Object.values(state.pins).map((pin) => pinView(s, state, pin, verified.get(pin.snapshotId)))
}
export async function listRuntimePinsStoreAsync(
  s: RuntimeSnapshotStore,
  lock?: Lockfile,
  verificationCache?: InventoryVerificationCache,
): Promise<RuntimePin[]> {
  const state = readState(s)
  assertRuntimeDirectoryEntries(s, state)
  // Independent immutable trees may overlap IO. The existing pool bounds work and settles every
  // started validator on failure; all paths, bytes, identities and bindings are still verified.
  const snapshots = await mapFileChecks(Object.values(state.snapshots), (record) =>
    collectReadAsync(verifyRecordSteps(s, record, snapshotDir(s, record.snapshotId), verificationCache)),
  )
  const verified = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]))
  return Object.values(state.pins).map((pin) =>
    pinView(s, state, pin, verified.get(pin.snapshotId), lock && own(lock.packages, pin.packageId)),
  )
}

export function collectRuntimeSnapshotsStore(
  s: RuntimeSnapshotStore,
  packageId?: string,
): RuntimeSnapshotCollection {
  const state = readState(s)
  collectRead(knownRuntimeDirectoryReadSteps(s, state))
  const pinned = new Set(Object.values(state.pins).map((pin) => pin.snapshotId)),
    removed: string[] = [],
    retained: string[] = []
  for (const record of Object.values(state.snapshots).sort((a, b) =>
    a.snapshotId.localeCompare(b.snapshotId),
  )) {
    if (packageId !== undefined && record.packageId !== packageId) continue
    if (pinned.has(record.snapshotId)) {
      retained.push(record.snapshotId)
      continue
    }
    const transactionId = randomUUID(),
      trashName = `.trash-${transactionId}`,
      trash = join(runtimeRoot(s), trashName),
      destination = snapshotDir(s, record.snapshotId),
      journal: GcJournal = {
        version: 1,
        kind: 'gc',
        transactionId,
        trash: trashName,
        snapshot: record,
      }
    writeJournal(s, journal)
    s.runtimeCheckpoint?.('runtime-gc-prepared')
    renameSync(destination, trash)
    syncDirectory(runtimeRoot(s))
    s.runtimeCheckpoint?.('runtime-gc-moved')
    delete state.snapshots[record.snapshotId]
    writeState(s, state)
    s.runtimeCheckpoint?.('runtime-gc-state-written')
    exactTree(trash, record.treeIntegrity)
    rmSync(trash, { recursive: true })
    clearJournal(s)
    removed.push(record.snapshotId)
  }
  return freezeData({ removed, retained })
}
