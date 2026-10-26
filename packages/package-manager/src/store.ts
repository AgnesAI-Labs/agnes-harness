import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { type PermissionEffectAdmission, validateLockfile } from '@agnes/protocol'
import { renameWriteThroughSync, syncTreeBatchedSync } from '@agnes/system-node'
import { appendPackageAudit, type PackageAuditSink } from './audit.js'
import { PackageError } from './errors.js'
import { canonical, own, readStaticJson, snapshotHash, syncDirectory } from './integrity.js'
import { type LockEntry, type Lockfile, prepareLockPublication, readLock } from './lockfile.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { hashDirectory, packageDir } from './sources.js'

export type PackageCommitPoint =
  | 'prepared'
  | 'old-moved'
  | 'new-moved'
  | 'lock-written'
  | 'audit-written'
  | 'previous-saved'
  | 'finished'
export type RuntimeSnapshotCommitPoint =
  | 'runtime-prepared'
  | 'runtime-snapshot-moved'
  | 'runtime-state-written'
  | 'runtime-gc-prepared'
  | 'runtime-gc-moved'
  | 'runtime-gc-state-written'
  | 'runtime-finished'
export type PackageStore = {
  admission?: PermissionEffectAdmission
  dataDir: string
  profileDir: string
  profile: string
  agnesVersion: string
  now: () => string
  audit?: PackageAuditSink
  actor?: string
  checkpoint?: (point: PackageCommitPoint) => void
  runtimeCheckpoint?: (point: RuntimeSnapshotCommitPoint) => void
}
type Journal = {
  version: 1
  transactionId: string
  id: string
  operation: string
  at: string
  actor: string
  stage: string | null
  old: LockEntry | null
  next: LockEntry | null
  oldTree: string | null
  nextTree: string | null
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const TREE = /^sha256-[a-f0-9]{64}$/
const journalPath = (s: PackageStore) => join(s.profileDir, '.agnes-package-transaction.json')
export const previousPackageDir = (s: Pick<PackageStore, 'dataDir' | 'profile'>, id: string) =>
  join(dirname(packageDir(s.dataDir, s.profile, id)), `.previous-${snapshotHash(id)}`)
function fail(reason: string, path?: string): never {
  // The path stays in the detail: hashed directory names would make the message read as a secret.
  throw new PackageError('E_LOCK_MISMATCH', 'package store requires recovery', {
    detail: { reason, ...(path ? { path } : {}) },
  })
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
function tree(path: string): string | null {
  return present(path) ? hashDirectory(path, { exclude: [] }) : null
}
function exact(path: string, expected: string | null): void {
  if (tree(path) !== expected) fail('tree-mismatch', path)
}
function state(entry: LockEntry | null): string {
  return entry === null
    ? 'removed'
    : entry.state.enabled
      ? 'enabled-desired'
      : entry.state.trusted
        ? 'installed-disabled-trusted'
        : 'installed-disabled-untrusted'
}
function paths(s: PackageStore, j: Journal) {
  const dest = packageDir(s.dataDir, s.profile, j.id),
    root = dirname(dest)
  return {
    dest,
    backup: join(root, `.transaction-${j.transactionId}`),
    stage: j.stage === null ? null : join(root, j.stage),
    previous: previousPackageDir(s, j.id),
    trash: join(root, `.trash-${j.transactionId}`),
  }
}
/**
 * Deletes a tree the caller has just verified. It is first renamed to this journal's trash, so a
 * crash part-way through the recursive delete leaves only a tree recovery may drop unchecked.
 */
function discard(p: ReturnType<typeof paths>, path: string): void {
  renameSync(path, p.trash)
  rmSync(p.trash, { recursive: true })
}
function checked(s: PackageStore, lock: Lockfile, raw: Record<string, unknown>): Journal {
  if (
    canonical(Object.keys(raw).sort()) !==
      canonical(
        [
          'version',
          'transactionId',
          'id',
          'operation',
          'at',
          'actor',
          'stage',
          'old',
          'next',
          'oldTree',
          'nextTree',
        ].sort(),
      ) ||
    raw.version !== 1 ||
    typeof raw.transactionId !== 'string' ||
    !UUID.test(raw.transactionId) ||
    typeof raw.id !== 'string' ||
    typeof raw.operation !== 'string' ||
    !['install', 'add', 'trust', 'untrust', 'enable', 'disable', 'update', 'rollback', 'remove'].includes(
      raw.operation,
    ) ||
    typeof raw.actor !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(raw.actor) ||
    typeof raw.at !== 'string' ||
    !Number.isFinite(Date.parse(raw.at))
  )
    fail('journal-shape')
  if (
    raw.stage !== null &&
    (typeof raw.stage !== 'string' || !raw.stage.startsWith('.stage-') || !UUID.test(raw.stage.slice(7)))
  )
    fail('journal-path')
  for (const key of ['oldTree', 'nextTree'])
    if (raw[key] !== null && (typeof raw[key] !== 'string' || !TREE.test(raw[key] as string)))
      fail('journal-tree')
  for (const key of ['old', 'next']) assertCurrentPackageFormat(raw[key])
  for (const key of ['old', 'next'])
    if (raw[key] !== null && !validateLockfile({ ...lock, packages: { [raw.id]: raw[key] } }).ok)
      fail('journal-entry')
  if (
    (raw.old === null && raw.oldTree !== null) ||
    (raw.next === null && raw.nextTree !== null) ||
    (raw.stage === null && raw.next !== null && raw.nextTree !== raw.oldTree)
  )
    fail('journal-consistency')
  // Also validates the package/profile path grammar without trusting any path stored in JSON.
  packageDir(s.dataDir, s.profile, raw.id)
  return raw as unknown as Journal
}
function finish(s: PackageStore, j: Journal): void {
  const p = paths(s, j),
    moves = j.stage !== null || j.next === null
  exact(p.dest, j.nextTree)
  appendPackageAudit(
    s.profileDir,
    {
      eventId: j.transactionId,
      at: j.at,
      actor: j.actor,
      profile: s.profile,
      operation: j.operation,
      id: j.id,
      source: (j.next ?? j.old)?.source.type ?? 'unknown',
      sourceHash: snapshotHash((j.next ?? j.old)?.source ?? null),
      version: (j.next ?? j.old)?.version ?? null,
      capabilityDiff: {
        old: j.old
          ? snapshotHash([j.old.contributions ?? j.old.capabilities ?? null, j.old.dependencies])
          : null,
        next: j.next
          ? snapshotHash([j.next.contributions ?? j.next.capabilities ?? null, j.next.dependencies])
          : null,
      },
      integrity: (j.next ?? j.old)?.integrity ?? null,
      old: state(j.old),
      next: state(j.next),
      result: 'committed',
    },
    s.audit,
  )
  s.checkpoint?.('audit-written')
  if (moves && present(p.backup)) {
    exact(p.backup, j.oldTree)
    if (j.next !== null && j.old !== null) {
      // This directory is exclusively owned by PackageManager. Its identity is pinned by the old lock.
      if (present(p.previous)) {
        const previousExpected = j.old.previous?.treeIntegrity
        if (!previousExpected || tree(p.previous) !== previousExpected) fail('previous-mismatch', p.previous)
        discard(p, p.previous)
      }
      renameSync(p.backup, p.previous)
    } else discard(p, p.backup)
  }
  if (j.next === null && present(p.previous)) {
    const expected = j.old?.previous?.treeIntegrity
    if (!expected || tree(p.previous) !== expected) fail('previous-mismatch', p.previous)
    discard(p, p.previous)
  }
  if (moves && j.next !== null && j.old !== null) exact(p.previous, j.oldTree)
  syncDirectory(dirname(p.dest))
  s.checkpoint?.('previous-saved')
  if (p.stage && present(p.stage)) {
    exact(p.stage, j.nextTree)
    discard(p, p.stage)
  }
}
function complete(s: PackageStore): void {
  rmSync(journalPath(s))
  syncDirectory(s.profileDir)
  s.checkpoint?.('finished')
}
/** Caller holds the unique Profile lock. No decision uses operation labels or UI state. */
export function recoverPackageStore(s: PackageStore): void {
  if (!existsSync(journalPath(s))) return
  const lock = readLock(s.profileDir, { profile: s.profile, agnesVersion: s.agnesVersion })
  const raw = readStaticJson(journalPath(s))
  let entries: Journal[]
  if (raw.version === 2) {
    if (
      Object.keys(raw).sort().join(',') !== 'entries,version' ||
      !Array.isArray(raw.entries) ||
      raw.entries.length < 2 ||
      raw.entries.length > 33
    )
      fail('journal-group')
    entries = raw.entries.map((entry) => checked(s, lock, entry))
    if (
      new Set(entries.map((j) => j.id)).size !== entries.length ||
      new Set(entries.map((j) => paths(s, j).dest)).size !== entries.length ||
      new Set(entries.map((j) => j.transactionId)).size !== entries.length
    )
      fail('journal-group-identity')
  } else entries = [checked(s, lock, raw)]
  for (const j of entries) rmSync(paths(s, j).trash, { recursive: true, force: true })
  const matches = (key: 'old' | 'next') =>
    entries.every((j) => canonical(own(lock.packages, j.id) ?? null) === canonical(j[key]))
  if (matches('next')) {
    for (const j of entries) finish(s, j)
  } else {
    if (!matches('old')) fail('lock-mismatch')
    for (const j of [...entries].reverse()) restore(s, j)
  }
  complete(s)
}
function restore(s: PackageStore, j: Journal): void {
  const p = paths(s, j)
  // Only this journal names its trash, and only verified trees enter it: a partial delete is expected.
  rmSync(p.trash, { recursive: true, force: true })
  if (j.stage !== null || j.next === null) {
    if (present(p.backup)) {
      exact(p.backup, j.oldTree)
      if (present(p.dest)) {
        exact(p.dest, j.nextTree)
        discard(p, p.dest)
      }
      renameSync(p.backup, p.dest)
    } else if (j.old === null) {
      if (present(p.dest)) {
        exact(p.dest, j.nextTree)
        discard(p, p.dest)
      }
    } else exact(p.dest, j.oldTree)
    if (p.stage && present(p.stage)) {
      exact(p.stage, j.nextTree)
      discard(p, p.stage)
    }
  } else exact(p.dest, j.oldTree)
}
/** Retains crash fixtures at each point; subsequent calls recover from lock+digest. */
export function commitPackage(
  s: PackageStore,
  lock: Lockfile,
  id: string,
  next: LockEntry | null,
  operation: string,
  stage?: string,
): void {
  commitPackages(s, lock, [{ id, next, operation, ...(stage ? { stage } : {}) }])
}
export type PackageChange = { id: string; next: LockEntry | null; operation: string; stage?: string }
/** One atomic lock publication, with digest-checked rollback before it and roll-forward after it. */
export function commitPackages(s: PackageStore, lock: Lockfile, changes: readonly PackageChange[]): void {
  if (s.admission) throw new Error('Admitted package mutations require the asynchronous transaction')
  for (const _ of packageTransaction(s, lock, changes)) {
    /* synchronous human path */
  }
}

export async function commitPackagesAdmitted(
  s: PackageStore,
  lock: Lockfile,
  changes: readonly PackageChange[],
): Promise<void> {
  const transaction = packageTransaction(s, lock, changes)
  try {
    for (;;) {
      await s.admission?.verify()
      s.admission?.assertActive()
      if (transaction.next().done) return
    }
  } catch (error) {
    transaction.throw(error)
    throw error
  }
}

function* packageTransaction(
  s: PackageStore,
  lock: Lockfile,
  changes: readonly PackageChange[],
): Generator<void, void> {
  if (!changes.length || changes.length > 33 || new Set(changes.map((c) => c.id)).size !== changes.length)
    fail('transaction-group')
  if (existsSync(journalPath(s))) fail('pending-transaction', journalPath(s))
  const draft = { ...lock, packages: { ...lock.packages } }
  const entries = changes.map((change) => {
    const j = prepare(s, lock, change)
    if (j.next) draft.packages[j.id] = j.next
    else delete draft.packages[j.id]
    return j
  })
  if (new Set(entries.map((j) => paths(s, j).dest)).size !== entries.length) fail('package-path-collision')
  assertCurrentPackageFormat(draft)
  if (!validateLockfile(draft).ok) fail('new-lock')
  const serialized = `${JSON.stringify(entries.length === 1 ? entries[0] : { version: 2, entries })}\n`
  if (Buffer.byteLength(serialized) > 1048576) fail('journal-size')
  const file = journalPath(s),
    tmp = `${file}.tmp`
  s.admission?.assertActive()
  let published = false
  try {
    mkdirSync(dirname(paths(s, entries[0]!).dest), { recursive: true })
    // Staged trees reach the disk before the journal names them: after power loss a published tree
    // must still hash to the digest the lockfile records.
    const staged = entries.flatMap((j) => paths(s, j).stage ?? [])
    if (staged.length) syncTreeBatchedSync(...staged)
    writeFileSync(tmp, serialized, { mode: 0o600, flush: true })
    yield
    s.admission?.assertActive()
    renameWriteThroughSync(resolve(tmp), resolve(file))
    s.checkpoint?.('prepared')
    for (const j of entries) {
      yield
      s.admission?.assertActive()
      const p = paths(s, j)
      if ((j.stage || j.next === null) && j.oldTree !== null) renameSync(p.dest, p.backup)
      s.checkpoint?.('old-moved')
      yield
      s.admission?.assertActive()
      if (p.stage) renameSync(p.stage, p.dest)
      s.checkpoint?.('new-moved')
    }
    const pending = prepareLockPublication(s.profileDir, draft)
    try {
      yield
      s.admission?.assertActive()
      pending.publish()
      published = true
    } finally {
      pending.discard()
    }
  } catch (error) {
    if (s.admission && !published) {
      if (existsSync(file)) {
        // A directory flush can fail after rename. Preserve the journal for roll-forward if
        // the lock already names the new trees; never restore trees behind a published lock.
        const disk = readLock(s.profileDir, { profile: s.profile, agnesVersion: s.agnesVersion })
        const committed = entries.every(
          (j) => canonical(own(disk.packages, j.id) ?? null) === canonical(j.next),
        )
        if (!committed) {
          for (const j of [...entries].reverse()) restore(s, j)
          const { checkpoint: _checkpoint, ...recovery } = s
          complete(recovery)
        }
      }
      rmSync(tmp, { force: true })
    }
    throw error
  }
  s.checkpoint?.('lock-written')
  for (const j of entries) finish(s, j)
  complete(s)
}
function prepare(s: PackageStore, lock: Lockfile, change: PackageChange): Journal {
  const { id, operation, stage } = change
  let { next } = change
  if (next?.provenance)
    next = {
      ...next,
      provenance: {
        ...next.provenance,
        trustDecision: next.state.trusted ? 'confirmed' : operation === 'untrust' ? 'revoked' : 'pending',
      },
    }
  if (existsSync(journalPath(s))) fail('pending-transaction', journalPath(s))
  const dest = packageDir(s.dataDir, s.profile, id),
    old = own(lock.packages, id) ?? null
  for (const other of Object.keys(lock.packages))
    if (other !== id && packageDir(s.dataDir, s.profile, other) === dest) fail('package-path-collision')
  if (old === null && present(dest)) fail('unowned-directory')
  const oldTree = tree(dest),
    nextTree = stage ? tree(stage) : next === null ? null : oldTree
  if (old?.treeIntegrity && oldTree !== old.treeIntegrity) fail('old-integrity')
  if (next?.treeIntegrity && nextTree !== next.treeIntegrity) fail('new-integrity')
  if (
    stage &&
    (dirname(stage) !== dirname(dest) ||
      !basename(stage).startsWith('.stage-') ||
      !UUID.test(basename(stage).slice(7)))
  )
    fail('stage-path')
  const j: Journal = {
    version: 1,
    transactionId: randomUUID(),
    id,
    operation,
    at: s.now(),
    actor: s.actor ?? 'package-manager',
    stage: stage ? basename(stage) : null,
    old,
    next,
    oldTree,
    nextTree,
  }
  const serialized = JSON.stringify(j)
  if (Buffer.byteLength(serialized) > 1048576) fail('journal-size')
  checked(s, lock, JSON.parse(serialized) as Record<string, unknown>)
  return j
}
