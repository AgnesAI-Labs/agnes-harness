import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createPackageManager, type ExecFn, emptyLock, parseSource, writeLock } from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
it('installs actual npm archives, then rolls back offline using the pinned tree and complete metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-npm-rollback-')),
    profile = join(root, 'profiles', 'local-dev'),
    archives = new Map<string, { bytes: Buffer; integrity: string }>()
  try {
    mkdirSync(profile, { recursive: true })
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
      seams: Object.fromEntries(seams.map((s) => [s, '@agnes/base'])),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    for (const version of ['1.0.0', '2.0.0']) {
      const folder = join(root, version),
        payload = join(folder, 'package')
      mkdirSync(payload, { recursive: true })
      cpSync(join(fixtures, 'pkg-a'), join(payload, 'extension'), { recursive: true })
      for (const name of ['package.json']) {
        const file = join(payload, 'extension', name),
          value = JSON.parse(readFileSync(file, 'utf8'))
        value.version = version
        writeFileSync(file, JSON.stringify(value))
      }
      writeFileSync(
        join(payload, 'package.json'),
        JSON.stringify({
          name: '@acme/pkg-a',
          version,
          license: 'MIT',
          exports: './extension/index.ts',
          agnes: { plugins: [{ export: 'main', id: 'ext:acme/pkg-a/main', runtime: 'in-process' }] },
          scripts: { postinstall: 'exit 99' },
        }),
      )
      const archive = join(folder, 'pkg.tgz')
      execFileSync('tar', ['-czf', archive, '-C', folder, 'package'])
      const bytes = readFileSync(archive)
      archives.set(version, {
        bytes,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      })
    }
    let offline = false,
      fetches = 0
    const exec: ExecFn = async (command, args) => {
      if (offline) throw Error('network unavailable')
      expect(command).toBe('npm')
      fetches++
      const version = args[1]?.split('@').at(-1),
        artifact = archives.get(version ?? '')
      if (!artifact || !version) throw Error('unknown fixture')
      if (args[0] === 'view') return { stdout: JSON.stringify({ [version]: '2025-01-01T00:00:00Z' }) }
      expect(args).toContain('--ignore-scripts')
      const at = args.indexOf('--pack-destination'),
        directory = args[at + 1]
      if (!directory) throw Error('destination missing')
      writeFileSync(join(directory, 'package.tgz'), artifact.bytes)
      return { stdout: JSON.stringify([{ filename: 'package.tgz', version, integrity: artifact.integrity }]) }
    }
    const manager = createPackageManager({
      dataDir: root,
      cwd: root,
      agnesVersion: '0.1.0',
      now: () => '2026-09-13T00:00:00Z',
      exec,
      references: async () => [],
    })
    const first = parseSource('npm:@acme/pkg-a@1.0.0'),
      preview = await manager.inspect(profile, first)
    await manager.install(profile, first, { expectedIntegrity: preview.integrity })
    const initial = (await manager.inventory(profile)).packages[0]
    if (!initial) throw Error('missing')
    await manager.trust(profile, '@acme/pkg-a', {
      integrity: initial.entry.integrity,
      capabilityHash: initial.capabilityHash,
    })
    const second = parseSource('npm:@acme/pkg-a@2.0.0'),
      next = await manager.inspect(profile, second)
    await manager.update(profile, '@acme/pkg-a', second, { expectedIntegrity: next.integrity })
    offline = true
    const before = fetches
    const rolled = await manager.rollback(profile, '@acme/pkg-a')
    expect(fetches).toBe(before)
    expect(rolled).toMatchObject({
      version: '1.0.0',
      integrity: preview.integrity,
      source: first,
      state: { enabled: false },
    })
    expect((await manager.inventory(profile)).packages[0]).toMatchObject({
      trusted: false,
      contributions: [],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
