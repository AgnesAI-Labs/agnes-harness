import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { hashDirectory } from '../src/directory-digest.js'
import {
  createPackageManager,
  emptyLock,
  packageDir,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'
import type { PackageRecoveryEvent } from '../src/recovery-log.js'
import {
  ABANDONED_AFTER_MS,
  claimStage,
  readyStage,
  recoverProfileStaging,
  recoverStaging,
} from '../src/staging.js'

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (!child.pid) throw Error('missing pid')
  return child.pid
}
const later = () => Date.now() + ABANDONED_AFTER_MS + 1000

it('keeps a live inspector, and keeps a dead fetch while it may still be written, then removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    claimStage(stage)
    mkdirSync(stage)
    readyStage(stage)
    const events: PackageRecoveryEvent[] = []
    recoverStaging(root, (event) => events.push(event), later())
    expect(existsSync(stage)).toBe(true)
    const work = join(root, '.agnes-fetch-abandoned')
    mkdirSync(work)
    writeFileSync(join(work, '.owner'), JSON.stringify({ pid: deadPid(), ready: false }))
    // An orphaned child of the dead fetch may still write here: skipped, never a refusal.
    recoverStaging(root, (event) => events.push(event))
    expect(existsSync(work)).toBe(true)
    expect(events).toEqual([])
    recoverStaging(root, (event) => events.push(event), later())
    expect(existsSync(work)).toBe(false)
    expect(existsSync(stage)).toBe(true)
    expect(events).toEqual([{ action: 'removed', path: work, reason: 'fetch-outcome-unknown' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Only this process ever writes an in-process copy, so its dead owner's partial stage is garbage at
// once. An external fetch may have left children behind, and a marker without a kind predates the
// field: those wait until nothing in them has changed for ABANDONED_AFTER_MS.
it.each([
  ['an in-process copy', 'copy', true],
  ['an external fetch', 'fetch', false],
  ['a marker without a kind', undefined, false],
] as const)(
  'a dead owner of an unready stage holding %s (kind %s) is cleared at once: %s',
  (_label, kind, atOnce) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-stage-kind-'))
    try {
      const stage = join(root, `.stage-${randomUUID()}`)
      mkdirSync(stage)
      writeFileSync(join(stage, 'partial'), 'copied part-way')
      writeFileSync(
        `${stage}.owner`,
        JSON.stringify({ pid: deadPid(), ready: false, ...(kind ? { kind } : {}) }),
      )
      recoverStaging(root)
      expect(existsSync(stage)).toBe(!atOnce)
      expect(existsSync(`${stage}.owner`)).toBe(!atOnce)
      recoverStaging(root, () => {}, later())
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(`${stage}.owner`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('removes a quiet stage without an owner and records it in the profile recovery log', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-unowned-')),
    profile = mkdtempSync(join(tmpdir(), 'agnes-stage-profile-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    mkdirSync(stage)
    const old = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000)
    utimesSync(stage, old, old)
    recoverProfileStaging(root, profile)
    expect(existsSync(stage)).toBe(false)
    const log = readFileSync(join(profile, '.agnes-package-recovery.jsonl'), 'utf8').trim().split('\n')
    expect(log.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ action: 'removed', path: stage, reason: 'staging-owner-unknown' }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

// A marker torn by power loss, or one this version cannot read, says nothing about its owner: the stage
// is treated like a dead fetch's, kept while recent and removed when quiet, never a refusal.
it.each([
  ['torn by power loss', ''],
  ['invalid', JSON.stringify({ pid: 'nope', ready: false })],
])('treats an owner marker %s as an unknown outcome instead of refusing', (_label, bytes) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-invalid-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    mkdirSync(stage)
    writeFileSync(`${stage}.owner`, bytes)
    const events: PackageRecoveryEvent[] = []
    recoverStaging(root, (event) => events.push(event))
    expect(existsSync(stage)).toBe(true)
    recoverStaging(root, (event) => events.push(event), later())
    expect([existsSync(stage), existsSync(`${stage}.owner`)]).toEqual([false, false])
    expect(events).toEqual([
      { action: 'removed', path: stage, reason: 'staging-owner-unreadable' },
      { action: 'removed', path: `${stage}.owner`, reason: 'staging-owner-unreadable' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A timestamp from the future must not keep a leftover forever; one already removed in this pass is
// not recorded again when its own directory entry comes up.
it('ignores future timestamps and records each removal once', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-future-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    mkdirSync(stage)
    const ahead = new Date(Date.now() + 365 * 24 * 60 * 60_000)
    writeFileSync(join(stage, 'from-the-future'), 'x')
    utimesSync(join(stage, 'from-the-future'), ahead, ahead)
    const old = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000)
    utimesSync(stage, old, old)
    writeFileSync(`${stage}.owner`, JSON.stringify({ pid: deadPid(), ready: false }))
    utimesSync(`${stage}.owner`, old, old)
    const events: PackageRecoveryEvent[] = []
    recoverStaging(root, (event) => events.push(event))
    expect(existsSync(stage)).toBe(false)
    expect(events.map((event) => event.path)).toEqual([stage, `${stage}.owner`])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('does not rewrite a sidecar belonging to an unrelated fetch destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-sidecar-')),
    target = join(root, 'output')
  try {
    writeFileSync(`${target}.owner`, 'user data')
    readyStage(target)
    expect(readFileSync(`${target}.owner`, 'utf8')).toBe('user data')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Owner markers are replaced atomically but never flushed: power loss can leave one missing, empty or
// one state behind, or keep the marker while losing its stage. Even beside a complete, valid package
// tree, each of those leaves the committed install and lock as they were, the leftover is removed,
// and the profile accepts the next install.
it('never adopts a leftover stage whose unflushed owner marker power loss lost or rolled back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-power-loss-'))
  try {
    const profile = join(root, 'profiles', 'local-dev'),
      sourceDir = join(root, 'source'),
      source = parseSource('file:./source')
    mkdirSync(profile, { recursive: true })
    cpSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pkg-a'), sourceDir, { recursive: true })
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
          n,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const m = createPackageManager({
      dataDir: root,
      cwd: root,
      agnesVersion: '0.1.0',
      references: async () => [],
    })
    await m.install(profile, source, { expectedIntegrity: (await m.inspect(profile, source)).integrity })
    const installed = packageDir(root, 'local-dev', 'acme/pkg-a'),
      stageRoot = dirname(installed),
      load = () => readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }),
      lock = load(),
      tree = hashDirectory(installed, { exclude: [] })
    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
    const markers = {
      missing: undefined,
      empty: '',
      'unready fetch': JSON.stringify({ pid: deadPid(), ready: false, kind: 'fetch' }),
      'unready copy': JSON.stringify({ pid: deadPid(), ready: false, kind: 'copy' }),
      ready: JSON.stringify({ pid: deadPid(), ready: true, kind: 'fetch' }),
    }
    const old = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000)
    const age = (path: string): void => {
      if (!path.endsWith('.owner'))
        for (const name of readdirSync(path, { withFileTypes: true }))
          if (name.isDirectory()) age(join(path, name.name))
          else utimesSync(join(path, name.name), old, old)
      utimesSync(path, old, old)
    }
    const leftovers = Object.entries(markers).map(([label, bytes]) => {
      const stage = join(stageRoot, `.stage-${randomUUID()}`)
      cpSync(sourceDir, stage, { recursive: true })
      if (bytes !== undefined) writeFileSync(`${stage}.owner`, bytes)
      age(stage)
      if (bytes !== undefined) age(`${stage}.owner`)
      return { label, stage }
    })
    // The marker survived but its stage directory entry did not.
    const ownerOnly = join(stageRoot, `.stage-${randomUUID()}.owner`)
    writeFileSync(ownerOnly, JSON.stringify({ pid: deadPid(), ready: false, kind: 'fetch' }))
    await m.recover(profile)
    expect(load()).toEqual(lock)
    expect(hashDirectory(installed, { exclude: [] })).toBe(tree)
    expect((await m.inventory(profile)).packages.map((row) => [row.id, row.entry.version])).toEqual([
      ['acme/pkg-a', '1.0.0'],
    ])
    for (const { label, stage } of leftovers)
      expect([label, existsSync(stage), existsSync(`${stage}.owner`)]).toEqual([label, false, false])
    expect(existsSync(ownerOnly)).toBe(false)
    expect(readdirSync(stageRoot)).toEqual(['acme__pkg-a'])
    const reasons = readFileSync(join(profile, '.agnes-package-recovery.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).reason)
    expect(new Set(reasons)).toEqual(
      new Set([
        'staging-owner-unknown',
        'staging-owner-unreadable',
        'staging-outcome-unknown',
        'staging-copy-dead',
        'staging-ready-dead',
        'staging-owner-only',
      ]),
    )
    const next = await m.inspect(profile, source)
    await m.update(profile, 'acme/pkg-a', source, { expectedIntegrity: next.integrity })
    expect(load().packages['acme/pkg-a']?.version).toBe('2.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
