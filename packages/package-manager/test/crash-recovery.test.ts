import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendPackageAudit } from '../src/audit.js'
import {
  createPackageManager,
  emptyLock,
  hashDirectory,
  type LockEntry,
  packageDir,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'
import { previousSnapshot } from '../src/lifecycle.js'
import {
  commitPackage,
  type PackageCommitPoint,
  type PackageStore,
  previousPackageDir,
  recoverPackageStore,
} from '../src/store.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
let root: string, profile: string, store: PackageStore, old: LockEntry, dest: string
const points: PackageCommitPoint[] = [
  'prepared',
  'old-moved',
  'new-moved',
  'lock-written',
  'audit-written',
  'previous-saved',
  'finished',
]
const seams = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'platform',
  'harness',
]
const load = () => readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
const audit = () =>
  readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x))
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agnes-crash-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((n) => [n, '@agnes/base'])),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const manager = createPackageManager({ dataDir: root, cwd: fixtures, agnesVersion: '0.1.0' }),
    source = parseSource('file:./pkg-a'),
    p = await manager.inspect(profile, source)
  old = await manager.install(profile, source, { expectedIntegrity: p.integrity })
  dest = packageDir(root, 'local-dev', 'acme/pkg-a')
  store = {
    dataDir: root,
    profileDir: profile,
    profile: 'local-dev',
    agnesVersion: '0.1.0',
    now: () => '2026-09-13T00:00:00Z',
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function candidate() {
  const stage = join(dirname(dest), `.stage-${randomUUID()}`)
  cpSync(dest, stage, { recursive: true })
  for (const filename of ['package.json']) {
    const file = join(stage, filename),
      data = JSON.parse(readFileSync(file, 'utf8'))
    data.version = '1.1.0'
    writeFileSync(file, JSON.stringify(data))
  }
  const hash = hashDirectory(stage, { exclude: [] }),
    next = {
      ...structuredClone(old),
      version: '1.1.0',
      integrity: hash,
      treeIntegrity: hash,
      previous: previousSnapshot(old),
    } as LockEntry
  return { stage, next }
}
it.each(points)(
  'update recovers at %s from lock and digest, with one audit and the correct previous tree',
  (point) => {
    const { stage, next } = candidate(),
      before = audit().length
    expect(() =>
      commitPackage(
        {
          ...store,
          checkpoint: (p) => {
            if (p === point) throw Error('crash')
          },
        },
        load(),
        'acme/pkg-a',
        next,
        'update',
        stage,
      ),
    ).toThrow('crash')
    recoverPackageStore(store)
    recoverPackageStore(store)
    const committed = points.indexOf(point) >= points.indexOf('lock-written')
    expect(load().packages['acme/pkg-a']?.version).toBe(committed ? '1.1.0' : '1.0.0')
    expect(hashDirectory(dest, { exclude: [] })).toBe(committed ? next.treeIntegrity : old.treeIntegrity)
    expect(existsSync(previousPackageDir(store, 'acme/pkg-a'))).toBe(committed)
    if (committed)
      expect(hashDirectory(previousPackageDir(store, 'acme/pkg-a'), { exclude: [] })).toBe(old.treeIntegrity)
    expect(audit()).toHaveLength(before + (committed ? 1 : 0))
    expect(existsSync(stage)).toBe(false)
    expect(existsSync(join(profile, '.agnes-package-transaction.json'))).toBe(false)
    expect(readdirSync(dirname(dest)).filter((x) => x.startsWith('.transaction-'))).toEqual([])
  },
)
it.each(points)('remove recovers at %s and persists a tombstone only after commit', (point) => {
  const before = audit().length
  expect(() =>
    commitPackage(
      {
        ...store,
        checkpoint: (p) => {
          if (p === point) throw Error('crash')
        },
      },
      load(),
      'acme/pkg-a',
      null,
      'remove',
    ),
  ).toThrow('crash')
  recoverPackageStore(store)
  const committed = points.indexOf(point) >= points.indexOf('lock-written')
  expect(existsSync(dest)).toBe(!committed)
  expect(Boolean(load().packages['acme/pkg-a'])).toBe(!committed)
  expect(audit()).toHaveLength(before + (committed ? 1 : 0))
  if (committed) expect(audit().at(-1)).toMatchObject({ operation: 'remove', next: 'removed' })
})
it.each(['missing', 'changed'])(
  'refuses %s previous after the previous-saved crash instead of forgetting the journal',
  (kind) => {
    const { stage, next } = candidate()
    expect(() =>
      commitPackage(
        {
          ...store,
          checkpoint: (p) => {
            if (p === 'previous-saved') throw Error('crash')
          },
        },
        load(),
        'acme/pkg-a',
        next,
        'update',
        stage,
      ),
    ).toThrow('crash')
    const retained = previousPackageDir(store, 'acme/pkg-a')
    if (kind === 'missing') rmSync(retained, { recursive: true })
    else writeFileSync(join(retained, 'tamper'), 'tampered')
    expect(() => recoverPackageStore(store)).toThrow('requires recovery')
    expect(existsSync(join(profile, '.agnes-package-transaction.json'))).toBe(true)
    expect(hashDirectory(dest, { exclude: [] })).toBe(next.treeIntegrity)
  },
)
it('rejects oversized journal before any side effect and validates write shape just like recovery', () => {
  const lock = load(),
    large = structuredClone(old)
  large.dependencies = { pkg: 'x'.repeat(600000) }
  lock.packages['acme/pkg-a'] = large
  writeLock(profile, lock)
  const next = structuredClone(large)
  next.state.enabled = true
  expect(() => commitPackage(store, lock, 'acme/pkg-a', next, 'enable')).toThrow('requires recovery')
  expect(existsSync(join(profile, '.agnes-package-transaction.json'))).toBe(false)
  expect(load().packages['acme/pkg-a']?.state.enabled).toBe(false)
  expect(() => commitPackage({ ...store, actor: 'bad actor' }, load(), 'acme/pkg-a', old, 'trust')).toThrow(
    'requires recovery',
  )
})
it.each(['{"eventId":"truncated-record"}\n', '{"broken":', '[]\n'])(
  'refuses malformed existing audit %#',
  (text) => {
    const file = join(profile, '.agnes-package-audit.jsonl'),
      event = audit()[0]
    writeFileSync(file, text)
    expect(() => appendPackageAudit(profile, event)).toThrow(/audit/)
    expect(readFileSync(file, 'utf8')).toBe(text)
  },
)
it('refuses conflicting same-ID audit and preserves unowned directory collision', () => {
  const file = join(profile, '.agnes-package-audit.jsonl'),
    event = audit()[0]
  writeFileSync(file, `${JSON.stringify({ ...event, operation: 'other' })}\n`)
  expect(() => appendPackageAudit(profile, event)).toThrow(/conflicting/)
  const collision = packageDir(root, 'local-dev', 'acme__pkg-a'),
    lock = load()
  expect(collision).toBe(dest)
  expect(() => commitPackage(store, lock, 'acme__pkg-a', old, 'install')).toThrow('requires recovery')
  expect(hashDirectory(dest, { exclude: [] })).toBe(old.treeIntegrity)
})
it('does not overwrite an unknown current tree during recovery', () => {
  const { stage, next } = candidate()
  expect(() =>
    commitPackage(
      {
        ...store,
        checkpoint: (p) => {
          if (p === 'new-moved') throw Error('crash')
        },
      },
      load(),
      'acme/pkg-a',
      next,
      'update',
      stage,
    ),
  ).toThrow('crash')
  writeFileSync(join(dest, 'unexpected'), 'keep')
  expect(() => recoverPackageStore(store)).toThrow('requires recovery')
  expect(readFileSync(join(dest, 'unexpected'), 'utf8')).toBe('keep')
  expect(existsSync(join(profile, '.agnes-package-transaction.json'))).toBe(true)
})

it('validates the whole audit even when an earlier line already has this event ID', () => {
  const event = audit()[0],
    file = join(profile, '.agnes-package-audit.jsonl')
  writeFileSync(file, `${JSON.stringify(event)}\n{"eventId":"broken-later"}\n`)
  expect(() => appendPackageAudit(profile, event)).toThrow(/audit/)
})
