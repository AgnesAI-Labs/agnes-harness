import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type PackageBlocker,
  type PackageContributionSummary,
  validatePackageAdminData,
} from '@agnes/protocol'
import { renameWriteThroughSync } from '@agnes/system-node'
import { copyPackageTreeSync } from './copy-tree.js'
import { PackageError } from './errors.js'
import {
  canonical,
  capabilityHash,
  freezeData,
  readStaticJson,
  snapshotHash,
  syncDirectory,
} from './integrity.js'
import { type InstalledPackage, isSnapshotPackageEligible, verifyPackageDirectory } from './inventory.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import { hashDirectory, packageDir, parseSource } from './sources.js'
import { type PackageStore, previousPackageDir } from './store.js'

export type RuntimePinPurpose = 'active' | 'candidate' | 'recovery' | 'rollback' | 'turn'

export type RuntimeSnapshotSelector =
  | Readonly<{ kind: 'installed'; expectedIntegrity: string; expectedTreeIntegrity: string }>
  | Readonly<{ kind: 'previous'; expectedIntegrity: string; expectedTreeIntegrity: string }>
  | Readonly<{
      kind: 'snapshot'
      snapshotId: string
      expectedIntegrity: string
      expectedTreeIntegrity: string
    }>

export type RuntimeSnapshot = Readonly<{
  snapshotId: string
  profile: string
  packageId: string
  version: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  directory: string
  contributions: readonly PackageContributionSummary[]
}>

export type RuntimePin = Readonly<{
  pinId: string
  operationId: string
  purpose: RuntimePinPurpose
  snapshot: RuntimeSnapshot
}>

export type RuntimeSnapshotPinRequest = Readonly<{
  pinId: string
  operationId: string
  packageId: string
  purpose: RuntimePinPurpose
  selector: RuntimeSnapshotSelector
}>

export type RuntimeSnapshotCollection = Readonly<{
  removed: readonly string[]
  retained: readonly string[]
}>

export type RuntimeSnapshotStore = PackageStore

type SnapshotRecord = {
  version: 1
  snapshotId: string
  packageId: string
  packageVersion: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  source: LockEntry['source']
  license: string
  releasedAt: string | null
  dependencies: Record<string, string>
  contributions: PackageContributionSummary[]
}
type PinRecord = {
  pinId: string
  operationId: string
  purpose: RuntimePinPurpose
  packageId: string
  snapshotId: string
  requestHash: string
}
type RuntimeState = {
  version: 1
  snapshots: Record<string, SnapshotRecord>
  pins: Record<string, PinRecord>
}
type CreateJournal = {
  version: 1
  kind: 'create'
  transactionId: string
  stage: string
  snapshot: SnapshotRecord
  pin: PinRecord
}
type GcJournal = {
  version: 1
  kind: 'gc'
  transactionId: string
  trash: string
  snapshot: SnapshotRecord
}
type RuntimeJournal = CreateJournal | GcJournal

const SHA256 = /^sha256-[a-f0-9]{64}$/
const INTEGRITY = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const PURPOSES = new Set<RuntimePinPurpose>(['active', 'candidate', 'recovery', 'rollback', 'turn'])
const MAX_RECORDS = 4096
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
    ]) ||
    value.version !== 1 ||
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
  const record = value as unknown as SnapshotRecord
  if (
    record.snapshotId !==
      runtimeSnapshotId({
        packageId: record.packageId,
        version: record.packageVersion,
        integrity: record.integrity,
        treeIntegrity: record.treeIntegrity,
        capabilityHash: record.capabilityHash,
      }) ||
    capabilityHash({ contributions: record.contributions, dependencies: record.dependencies }) !==
      record.capabilityHash
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
  return { version: 1, snapshots, pins }
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
function runtimeSnapshotId(value: {
  packageId: string
  version: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
}): string {
  return `sha256-${snapshotHash(value)}`
}
function recordFromEntry(packageId: string, entry: LockEntry): SnapshotRecord {
  if (!entry.treeIntegrity || !entry.contributions) integrityFailure('snapshot-migration-required')
  const hash = capabilityHash(entry)
  return {
    version: 1,
    snapshotId: runtimeSnapshotId({
      packageId,
      version: entry.version,
      integrity: entry.integrity,
      treeIntegrity: entry.treeIntegrity,
      capabilityHash: hash,
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
  }
}
function trusted(entry: LockEntry, record: SnapshotRecord): boolean {
  return (
    entry.trust === 'builtin' ||
    (entry.state.trusted !== null &&
      entry.trustDecision?.integrity === entry.integrity &&
      entry.trustDecision.capabilityHash === record.capabilityHash)
  )
}
function verifyRecord(s: RuntimeSnapshotStore, record: SnapshotRecord, directory: string): RuntimeSnapshot {
  const checkedRecord = validateRecord(record)
  let root: string, actual: string
  try {
    root = realpathSync(runtimeRoot(s))
    actual = realpathSync(directory)
    if (lstatSync(runtimeRoot(s)).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
      integrityFailure('runtime-path-symlink')
  } catch (error) {
    if (error instanceof PackageError) throw error
    integrityFailure('runtime-path-missing')
  }
  if (!contained(root, actual) || actual === root || basename(actual) !== checkedRecord.snapshotId)
    integrityFailure('runtime-path-escape')
  if (hashDirectory(actual, { exclude: [] }) !== checkedRecord.treeIntegrity)
    integrityFailure('runtime-tree-mismatch')
  const source = parseSource(checkedRecord.source.ref)
  if (canonical(source) !== canonical(checkedRecord.source)) integrityFailure('runtime-source-mismatch')
  verifyPackageDirectory(
    checkedRecord.packageId,
    recordEntry(checkedRecord),
    actual,
    contributionCeiling(checkedRecord),
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
  })
}
function contributionCeiling(record: SnapshotRecord): string[] {
  return [
    ...new Set(
      record.contributions.flatMap((c) => (c.kind === 'extension' ? Object.keys(c.capabilities ?? {}) : [])),
    ),
  ]
}
function recordEntry(record: SnapshotRecord): LockEntry {
  return {
    version: record.packageVersion,
    source: structuredClone(record.source),
    integrity: record.integrity,
    trust: 'trusted',
    license: record.license,
    state: { installed: new Date(0).toISOString(), trusted: null, enabled: false },
    dependencies: structuredClone(record.dependencies),
    previous: null,
    contributions: structuredClone(record.contributions),
    treeIntegrity: record.treeIntegrity,
    ...(record.releasedAt ? { releasedAt: record.releasedAt } : {}),
  } as LockEntry
}
function pinView(s: RuntimeSnapshotStore, state: RuntimeState, pin: PinRecord): RuntimePin {
  const record = state.snapshots[pin.snapshotId]
  if (!record) integrityFailure('pin-snapshot-missing')
  return freezeData({
    pinId: pin.pinId,
    operationId: pin.operationId,
    purpose: pin.purpose,
    snapshot: verifyRecord(s, record, snapshotDir(s, record.snapshotId)),
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
    const row = installedPackage(request.packageId)
    if (!row.directory) stateFailure('installed-directory-missing')
    if (row.blockers.length) throw blocked(row.blockers)
    entry = row.entry
    directory = row.directory
  } else {
    const current = lock.packages[request.packageId]
    if (!current?.previous?.treeIntegrity || !current.previous.source)
      stateFailure('previous-snapshot-missing')
    entry = { ...structuredClone(current.previous), previous: null } as LockEntry
    directory = previousPackageDir(s, request.packageId)
  }
  const record = recordFromEntry(request.packageId, entry)
  if (!trusted(entry, record))
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
  s.runtimeCheckpoint?.('runtime-finished')
}

/** Caller holds the PackageManager Profile lock. Runtime state never decides the active revision. */
export function recoverRuntimeSnapshotStore(s: RuntimeSnapshotStore): void {
  const root = runtimeRoot(s)
  rmSync(`${statePath(s)}.tmp`, { force: true })
  if (!present(journalPath(s))) {
    rmSync(`${journalPath(s)}.tmp`, { force: true })
    assertKnownRuntimeDirectories(s, readState(s))
    return
  }
  const state = readState(s),
    journal = readJournal(s)
  mkdirSync(root, { recursive: true })
  if (journal.kind === 'create') {
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
        rmSync(destination, { recursive: true })
      }
      // The journal owns this UUID stage before copying starts, so a partial copy is safe to remove.
      if (present(stage)) rmSync(stage, { recursive: true })
    }
    clearJournal(s)
    return
  }
  const destination = snapshotDir(s, journal.snapshot.snapshotId),
    trash = join(root, journal.trash),
    committed = !state.snapshots[journal.snapshot.snapshotId]
  if (committed) {
    if (present(destination)) integrityFailure('runtime-gc-destination-after-commit')
    if (present(trash)) {
      exactTree(trash, journal.snapshot.treeIntegrity)
      rmSync(trash, { recursive: true })
    }
  } else if (present(trash)) {
    if (present(destination)) integrityFailure('runtime-gc-path-collision')
    exactTree(trash, journal.snapshot.treeIntegrity)
    renameSync(trash, destination)
  } else verifyRecord(s, journal.snapshot, destination)
  clearJournal(s)
}

function assertKnownRuntimeDirectories(s: RuntimeSnapshotStore, state: RuntimeState): void {
  const root = runtimeRoot(s)
  if (!present(root)) {
    if (Object.keys(state.snapshots).length) integrityFailure('runtime-root-missing')
    return
  }
  if (lstatSync(root).isSymbolicLink()) integrityFailure('runtime-root-symlink')
  const allowed = new Set(Object.keys(state.snapshots))
  for (const entry of readdirSync(root))
    if (!allowed.has(entry)) integrityFailure('unknown-runtime-directory')
  for (const record of Object.values(state.snapshots))
    verifyRecord(s, record, snapshotDir(s, record.snapshotId))
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
  assertKnownRuntimeDirectories(s, state)
  if (!lock.packages[request.packageId]) stateFailure('package-not-installed')
  const prior = state.pins[request.pinId]
  if (prior) {
    if (
      prior.requestHash !== requestHash ||
      prior.operationId !== request.operationId ||
      prior.packageId !== request.packageId ||
      prior.purpose !== request.purpose
    )
      integrityFailure('pin-id-reused')
    return pinView(s, state, prior)
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
  assertKnownRuntimeDirectories(s, state)
  const pin = state.pins[request.pinId]
  if (!pin) stateFailure('pin-not-found')
  if (request.expectedSnapshotId !== undefined && pin.snapshotId !== request.expectedSnapshotId)
    integrityFailure('pin-snapshot-stale')
  if (lock) {
    const current = lock.packages[pin.packageId]
    if (!current) stateFailure('package-not-found')
    if (current.state.trusted === null || (packageEligible && !packageEligible(pin.packageId)))
      stateFailure('package-not-eligible')
  }
  return pinView(s, state, pin)
}

export function releaseRuntimePinStore(
  s: RuntimeSnapshotStore,
  request: Readonly<{ pinId: string; expectedSnapshotId: string }>,
): void {
  validateToken(request.pinId, 'pin-id')
  if (!SHA256.test(request.expectedSnapshotId)) integrityFailure('snapshot-id')
  const state = readState(s)
  assertKnownRuntimeDirectories(s, state)
  const pin = state.pins[request.pinId]
  if (!pin) return
  if (pin.snapshotId !== request.expectedSnapshotId) integrityFailure('pin-snapshot-stale')
  delete state.pins[request.pinId]
  writeState(s, state)
}

export function runtimePinBlockers(s: RuntimeSnapshotStore, packageId: string): PackageBlocker[] {
  const state = readState(s)
  assertKnownRuntimeDirectories(s, state)
  const all = Object.values(state.pins)
    .filter((pin) => pin.packageId === packageId)
    .map((pin) => `runtime-pin:${pin.purpose}:${pin.pinId}`)
    .sort()
  const references = all.length > 128 ? [...all.slice(0, 127), `runtime-pin:more:${all.length - 127}`] : all
  return references.length ? [{ code: 'generation', references }] : []
}

export function listRuntimePinsStore(s: RuntimeSnapshotStore): RuntimePin[] {
  const state = readState(s)
  assertKnownRuntimeDirectories(s, state)
  return Object.values(state.pins).map((pin) => pinView(s, state, pin))
}

export function collectRuntimeSnapshotsStore(
  s: RuntimeSnapshotStore,
  packageId?: string,
): RuntimeSnapshotCollection {
  const state = readState(s)
  assertKnownRuntimeDirectories(s, state)
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
