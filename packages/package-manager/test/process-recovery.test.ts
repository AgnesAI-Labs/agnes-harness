import { spawnSync } from 'node:child_process'
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
import { createPackageManager, emptyLock, parseSource, writeLock } from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const points = [
  'fetching',
  'inspecting',
  'prepared',
  'old-moved',
  'new-moved',
  'lock-written',
  'audit-written',
  'previous-saved',
  'finished',
]
it.each(points)('recovers after an actual child exits at %s without running finally', async (point) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-process-crash-')),
    profile = join(root, 'profiles', 'local-dev'),
    sourceDir = join(root, 'candidate')
  try {
    mkdirSync(profile, { recursive: true })
    cpSync(join(fixtures, 'pkg-a'), sourceDir, { recursive: true })
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
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(seams.map((name) => [name, '@agnes/base'])),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const m = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0' }),
      source = parseSource('file:./candidate'),
      first = await m.inspect(profile, source)
    await m.install(profile, source, { expectedIntegrity: first.integrity })
    for (const filename of ['package.json']) {
      const file = join(sourceDir, filename),
        value = JSON.parse(readFileSync(file, 'utf8'))
      value.version = '2.0.0'
      writeFileSync(file, JSON.stringify(value))
    }
    const next = await m.inspect(profile, source)
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(fixtures, 'pm3-crash-child.ts'), root, point, next.integrity],
      { encoding: 'utf8', timeout: 15000 },
    )
    expect(child.status, child.stderr).toBe(74)
    const lock = join(profile, '.agnes-lock.lock')
    expect(existsSync(lock)).toBe(true)
    const deadPid = Number(readFileSync(lock, 'utf8'))
    expect(() => process.kill(deadPid, 0)).toThrow()
    // Age the abandoned lock rather than sleeping 30 seconds; PID death is independently verified.
    const aged = new Date(Date.now() - 60000)
    utimesSync(lock, aged, aged)
    const fresh = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0' })
    const recovered = await fresh.inventory(profile),
      committed = points.indexOf(point) >= points.indexOf('lock-written')
    expect(recovered.packages[0]?.entry.version).toBe(committed ? '2.0.0' : '1.0.0')
    expect(recovered.packages[0]?.entry.integrity).toBe(committed ? next.integrity : first.integrity)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(join(profile, '.agnes-package-transaction.json'))).toBe(false)
    expect(
      readdirSync(join(profile, 'packages')).filter(
        (name) => name.startsWith('.') && !name.startsWith('.previous-'),
      ),
    ).toEqual([])
    const records = readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8').trim().split('\n')
    expect(records).toHaveLength(committed ? 2 : 1)
    await fresh.recover(profile)
    expect(readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8').trim().split('\n')).toEqual(
      records,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
