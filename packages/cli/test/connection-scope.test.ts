import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, resolveDaemonScope } from '@agnes/daemon'
import * as host from '@agnes/host'
import { afterEach, expect, it, vi } from 'vitest'
import * as sources from '../../package-manager/src/sources.js'
import { parseArgs } from '../src/args.js'
import { connectionScope, localPreparation, validateConnectionSocket } from '../src/boot/connection-scope.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const roots: string[] = []
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'agh-connect-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([undefined, 'relative-data', '~/自定义 data'])(
  'resolves canonical connection identity without preparing packages: %s',
  async (dataDir) => {
    const home = scratch()
    const cwd = scratch()
    const profileDir = join(home, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    if (dataDir)
      writeFileSync(join(profileDir, 'profile.yaml'), JSON.stringify({ name: 'local-dev', dataDir }))
    // A corrupt package lock proves the connection path does not parse or verify installed code.
    writeFileSync(join(profileDir, 'agnes-lock.json'), 'corrupt lock')
    const inputs = vi.spyOn(host, 'readConfigurationProfileInputs')
    const hash = vi.spyOn(sources, 'hashDirectory')
    const prepare = vi.spyOn(host, 'resolveProfile')
    const actual = await connectionScope({ home, cwd, env: { HOME: home } })
    const expected = await resolveDaemonScope({
      home,
      cwd,
      env: { HOME: home },
      dataDir: dataDir?.startsWith('~/') ? join(home, dataDir.slice(2)) : (dataDir ?? join(home, 'data')),
    })
    expect(actual).toEqual(expected)
    expect(hash).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(inputs.mock.calls.every(([options]) => options.lock !== undefined)).toBe(true)
    expect(actual.home).toBe(await canonicalPath(home))
  },
)

it('honors explicit dataDir and canonical aliases without reading profile inputs', async () => {
  const home = scratch()
  const alias = join(scratch(), 'alias')
  symlinkSync(home, alias, 'junction')
  const inputs = vi.spyOn(host, 'readConfigurationProfileInputs')
  const one = await connectionScope({ home, dataDir: join(home, 'data'), cwd: home })
  const two = await connectionScope({ home: alias, dataDir: join(alias, 'data'), cwd: home })
  expect(two).toEqual(one)
  expect(inputs).not.toHaveBeenCalled()
})

it.each([
  [['sessions'], 'connect-first'],
  [['tools'], 'connect-first'],
  [['config'], 'connect-first'],
  [['plugins', 'list'], 'connect-first'],
  [['doctor'], 'full'],
  [['--standalone'], 'full'],
  [['--ephemeral'], 'full'],
] as const)('declares %j as %s', (argv, expected) => {
  expect(localPreparation(parseArgs([...argv]))).toBe(expected)
})

it.skipIf(process.platform === 'win32')(
  'refuses wrong ownership, modes and symlinks on real sockets',
  async () => {
    const root = scratch()
    chmodSync(root, 0o700)
    const path = join(root, 'daemon.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    try {
      chmodSync(path, 0o600)
      await expect(validateConnectionSocket(path)).resolves.toBeUndefined()
      chmodSync(path, 0o666)
      await expect(validateConnectionSocket(path)).rejects.toThrow(/owned by this user/)
      chmodSync(path, 0o600)
      chmodSync(root, 0o755)
      await expect(validateConnectionSocket(path)).rejects.toThrow(/owned by this user/)
      chmodSync(root, 0o700)
      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const original = actualFs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        const stat = await original(...args)
        return String(args[0]) === path ? Object.assign(stat, { uid: Number(stat.uid) + 1 }) : stat
      })
      await expect(validateConnectionSocket(path)).rejects.toThrow(/owned by this user/)
      vi.mocked(fs.lstat).mockImplementation(original)
      const alias = join(root, 'alias.sock')
      symlinkSync(path, alias)
      await expect(validateConnectionSocket(alias)).rejects.toThrow(/owned by this user/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
