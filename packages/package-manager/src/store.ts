import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { validateLockfile } from '@agnes/protocol'
import { renameWriteThroughSync } from '@agnes/system-node'
import { appendPackageAudit, type PackageAuditSink } from './audit.js'
import { PackageError } from './errors.js'
import { canonical, readStaticJson, snapshotHash, syncDirectory } from './integrity.js'
import { type LockEntry, type Lockfile, readLock, writeLock } from './lockfile.js'
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
function fail(reason: string): never {
  throw new PackageError('E_LOCK_MISMATCH', 'package store requires recovery', { detail: { reason } })
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
  if (tree(path) !== expected) fail('tree-mismatch')
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
  }
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
        if (!previousExpected || tree(p.previous) !== previousExpected) fail('previous-mismatch')
        rmSync(p.previous, { recursive: true })
      }
      renameSync(p.backup, p.previous)
    } else rmSync(p.backup, { recursive: true })
  }
  if (j.next === null && present(p.previous)) {
    const expected = j.old?.previous?.treeIntegrity
    if (!expected || tree(p.previous) !== expected) fail('previous-mismatch')
    rmSync(p.previous, { recursive: true })
  }
  if (moves && j.next !== null && j.old !== null) exact(p.previous, j.oldTree)
  syncDirectory(dirname(p.dest))
  s.checkpoint?.('previous-saved')
  if (p.stage && present(p.stage)) {
    exact(p.stage, j.nextTree)
    rmSync(p.stage, { recursive: true })
  }
  rmSync(journalPath(s))
  syncDirectory(s.profileDir)
  s.checkpoint?.('finished')
}
/** Caller holds the unique Profile lock. No decision uses operation labels or UI state. */
export function recoverPackageStore(s: PackageStore): void {
  if (!existsSync(journalPath(s))) return
  const lock = readLock(s.profileDir, { profile: s.profile, agnesVersion: s.agnesVersion }),
    j = checked(s, lock, readStaticJson(journalPath(s))),
    p = paths(s, j)
  const current = lock.packages[j.id] ?? null
  if (canonical(current) === canonical(j.next)) {
    finish(s, j)
    return
  }
  if (canonical(current) !== canonical(j.old)) fail('lock-mismatch')
  if (j.stage !== null || j.next === null) {
    if (present(p.backup)) {
      exact(p.backup, j.oldTree)
      if (present(p.dest)) {
        exact(p.dest, j.nextTree)
        rmSync(p.dest, { recursive: true })
      }
      renameSync(p.backup, p.dest)
    } else if (j.old === null) {
      if (present(p.dest)) {
        exact(p.dest, j.nextTree)
        rmSync(p.dest, { recursive: true })
      }
    } else exact(p.dest, j.oldTree)
    if (p.stage && present(p.stage)) {
      exact(p.stage, j.nextTree)
      rmSync(p.stage, { recursive: true })
    }
  } else exact(p.dest, j.oldTree)
  rmSync(journalPath(s))
  syncDirectory(s.profileDir)
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
  if (existsSync(journalPath(s))) fail('pending-transaction')
  const dest = packageDir(s.dataDir, s.profile, id),
    old = lock.packages[id] ?? null
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
  // Validate all future lock bytes before publishing an intent or moving any directory.
  const draft = { ...lock, packages: { ...lock.packages } }
  if (next) draft.packages[id] = next
  else delete draft.packages[id]
  if (!validateLockfile(draft).ok) fail('new-lock')
  const serialized = `${JSON.stringify(j)}\n`
  if (Buffer.byteLength(serialized) > 1048576) fail('journal-size')
  checked(s, lock, JSON.parse(serialized) as Record<string, unknown>)
  const file = journalPath(s),
    tmp = `${file}.tmp`
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(tmp, serialized, { mode: 0o600, flush: true })
  renameWriteThroughSync(resolve(tmp), resolve(file))
  s.checkpoint?.('prepared')
  const p = paths(s, j)
  if ((stage || next === null) && oldTree !== null) renameSync(dest, p.backup)
  s.checkpoint?.('old-moved')
  if (stage) renameSync(stage, dest)
  s.checkpoint?.('new-moved')
  writeLock(s.profileDir, draft)
  s.checkpoint?.('lock-written')
  finish(s, j)
}
