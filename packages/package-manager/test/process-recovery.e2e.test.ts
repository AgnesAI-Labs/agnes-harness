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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  hashDirectory,
  localPluginRoots,
  packageDir,
  parseSource,
  writeLock,
} from '../src/index.js'

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
    const seams = ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals']
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(seams.map((name) => [name, { provider: 'local' }])),
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

it('recovers after an actual child exits while a local scan holds an unready in-process copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-process-local-crash-')),
    profile = join(root, 'profiles', 'test'),
    src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  try {
    mkdirSync(profile, { recursive: true })
    const seams = ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals']
    writeLock(profile, {
      ...emptyLock('test', '0.0.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(seams.map((name) => [name, { provider: 'local' }])),
    })
    const roots = localPluginRoots(join(root, 'home'), join(root, 'workspace'))
    mkdirSync(join(roots.home, 'hello'), { recursive: true })
    writeFileSync(join(roots.home, 'hello', 'plugin.ts'), 'export default { apply() {} }')
    // The first clock read follows the in-process copy and precedes readyStage; exit skips every finally.
    const script = join(root, 'child.mts')
    writeFileSync(
      script,
      [
        `import { createPackageManager, localPluginRoots } from ${JSON.stringify(pathToFileURL(join(src, 'index.ts')).href)}`,
        `const root = ${JSON.stringify(root)}`,
        "const m = createPackageManager({ dataDir: root + '/data', agnesVersion: '0.0.0',",
        "  localPlugins: localPluginRoots(root + '/home', root + '/workspace'), now: () => process.exit(74) })",
        "await m.refreshLocalPlugins(root + '/profiles/test')",
        'process.exit(75)',
      ].join('\n'),
    )
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
      encoding: 'utf8',
      timeout: 30000,
    })
    expect(child.status, child.stderr).toBe(74)
    const staging = dirname(packageDir(join(root, 'data'), 'test', 'stage'))
    expect(readdirSync(staging).filter((name) => /^\.stage-.*\.owner$/.test(name))).toHaveLength(1)
    const lock = join(profile, '.agnes-lock.lock')
    expect(() => process.kill(Number(readFileSync(lock, 'utf8')), 0)).toThrow()
    // Age the abandoned lock rather than sleeping 30 seconds; PID death is independently verified.
    const aged = new Date(Date.now() - 60000)
    utimesSync(lock, aged, aged)
    const fresh = createPackageManager({
      dataDir: join(root, 'data'),
      agnesVersion: '0.0.0',
      localPlugins: roots,
    })
    await expect(fresh.inventory(profile, { fresh: true })).resolves.toBeDefined()
    await expect(fresh.refreshLocalPlugins(profile)).resolves.toEqual(['hello'])
    expect(readdirSync(staging).filter((name) => name.startsWith('.stage-'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)

it('forgets settled byte validity in a new worker process', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-verification-restart-'))
  try {
    const module = pathToFileURL(join(fixtures, '../../src/index.ts')).href
    const script = join(root, 'verify.mts')
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs'
      import { hashDirectory, verifiedDirectoryDigest, withPackageVerification } from ${JSON.stringify(module)}
      const dir = ${JSON.stringify(root)}
      const expected = process.argv[2]
      const identity = { version: '1.0.0', integrity: expected, treeIntegrity: expected, capabilityHash: 'a'.repeat(64) }
      const read = () => withPackageVerification(async () => verifiedDirectoryDigest(dir, identity, false, true), { settleTrees: true })
      if (process.argv[3] === 'warm') {
        await read()
        writeFileSync(dir + '/payload', 'other')
      }
      process.stdout.write(JSON.stringify(await read()))
    `,
    )
    writeFileSync(join(root, 'payload'), 'first')
    // Both workers inspect exactly the same expected tree, including the unchanged script.
    const expected = hashDirectory(root, { exclude: [] })
    const run = (phase: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', script, expected, phase], {
        encoding: 'utf8',
        timeout: 15000,
      })
    const warm = run('warm')
    expect(warm.status, warm.stderr).toBe(0)
    // Characterization of the pending in-place-edit decision: the incumbent still has its memo.
    expect(JSON.parse(warm.stdout)).toBe(expected)
    const restarted = run('cold')
    expect(restarted.status, restarted.stderr).toBe(0)
    expect(JSON.parse(restarted.stdout)).not.toBe(expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
