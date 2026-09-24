import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildConfig } from '../src/config.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { prepareDaemonSocketPaths, validateSocketPath } from '../src/supervisor/socket-paths.js'

const roots: string[] = []
const listeners: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const listener of listeners.splice(0)) await listener.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const profile = { name: 'local-dev', limits: {}, transports: [] } as never
function config(dataDir: string, socket?: string) {
  return buildConfig({
    args: { profile: 'local-dev', dataDir, ...(socket ? { socket } : {}) },
    profile,
    home: dataDir,
    ipc: 'unix',
  })
}
function longConfig() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-长路径-'))
  roots.push(root)
  const home = join(realpathSync(root), '中文数据'.repeat(12))
  const result = config(home)
  // Only remove an isolated directory derived from this test's unique dataDir.
  if (dirname(result.socketPath) !== join(home, 'daemon')) roots.push(dirname(result.socketPath))
  return result
}

describe.skipIf(process.platform === 'win32')('Unix daemon socket path policy', () => {
  it('measures final canonical UTF-8 bytes at the portable threshold and preserves short defaults', async () => {
    const root = mkdtempSync(join(realpathSync('/tmp'), 'ags-boundary-'))
    roots.push(root)
    const at = join(root, 'a'.repeat(103 - Buffer.byteLength(root) - 1))
    expect(Buffer.byteLength(at)).toBe(103)
    expect(() => validateSocketPath(at)).not.toThrow()
    const listener = await listenUnix(at, (socket) => socket.end('boundary'))
    listeners.push(listener)
    const client = connect(at)
    try {
      expect(String((await once(client, 'data'))[0])).toBe('boundary')
    } finally {
      client.destroy()
    }
    expect(() => validateSocketPath(`${at}a`)).toThrow(/104 UTF-8 bytes; limit is 103/)
    expect(config(root).workersSocketPath).toBe(join(root, 'daemon', 'workers.sock'))
    expect(() => validateSocketPath(`/tmp/${'中'.repeat(34)}`)).toThrow(/UTF-8 bytes/)
  })
  it('canonicalizes aliases before selecting stable short paths', () => {
    const initial = longConfig()
    const aliasRoot = mkdtempSync(join(realpathSync('/tmp'), 'ags-alias-'))
    roots.push(aliasRoot)
    const dataParent = dirname(initial.dataDir)
    const alias = join(aliasRoot, 'link')
    symlinkSync(dataParent, alias)
    const throughAlias = config(join(alias, initial.dataDir.slice(dataParent.length + 1)))
    expect(throughAlias.socketPath).toBe(initial.socketPath)
    expect(throughAlias.workersSocketPath).toBe(initial.workersSocketPath)
  })
  it('validates both endpoints before creating the short directory', () => {
    const initial = longConfig()
    expect(() =>
      prepareDaemonSocketPaths({ ...initial, workersSocketPath: `/tmp/${'x'.repeat(110)}` }),
    ).toThrow(/worker.*UTF-8/)
    expect(existsSync(dirname(initial.socketPath))).toBe(false)
  })
  it('rejects an existing short directory owned by a different effective user', () => {
    const initial = longConfig()
    prepareDaemonSocketPaths(initial)
    const dir = dirname(initial.socketPath)
    const original = lstatSync(dir)
    vi.spyOn(process, 'geteuid').mockReturnValue(original.uid + 1)
    expect(() => prepareDaemonSocketPaths(initial)).toThrow(/owned by this user/)
    expect(lstatSync(dir).uid).toBe(original.uid)
    expect(lstatSync(dir).mode).toBe(original.mode)
  })

  it('shortens both endpoints for long canonical data directories and exchanges real bytes', async () => {
    const first = longConfig()
    expect(first).toEqual(config(first.dataDir))
    expect(first.socketPath).not.toBe(config(`${first.dataDir}-other`).socketPath)
    for (const path of [first.socketPath, first.workersSocketPath]) {
      expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
      const server = await listenUnix(path, (socket) => socket.end('ready'))
      listeners.push(server)
      const client = connect(path)
      try {
        expect(String((await once(client, 'data'))[0])).toBe('ready')
      } finally {
        client.destroy()
      }
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700)
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    }
  })
  it('keeps an explicit short client endpoint while independently shortening workers', () => {
    const initial = longConfig()
    const overridden = config(initial.dataDir, '/tmp/explicit-client.sock')
    expect(overridden.socketPath).toBe('/tmp/explicit-client.sock')
    expect(overridden.workersSocketPath).toBe(initial.workersSocketPath)
    expect(Buffer.byteLength(overridden.workersSocketPath)).toBeLessThanOrEqual(103)
  })
  it('diagnoses an explicit oversized UTF-8 path before creating directories', () => {
    expect(() => config('/tmp/short-home', `/tmp/${'中'.repeat(34)}.sock`)).toThrow(/client.*UTF-8.*103/)
  })
  it.each(['symlink', 'file', 'broad'])(
    'preserves and rejects a pre-existing unsafe short directory: %s',
    async (kind) => {
      const initial = longConfig()
      const dir = dirname(initial.socketPath)
      const target = roots[0]
      if (!target) throw new Error('missing test root')
      if (kind === 'symlink') symlinkSync(target, dir)
      if (kind === 'file') writeFileSync(dir, 'preserve')
      if (kind === 'broad') {
        mkdirSync(dir, { mode: 0o700 })
        chmodSync(dir, 0o755)
      }
      await expect(listenUnix(initial.socketPath, () => {})).rejects.toThrow()
      if (kind === 'symlink') expect(lstatSync(dir).isSymbolicLink()).toBe(true)
      if (kind === 'file') expect(readFileSync(dir, 'utf8')).toBe('preserve')
      if (kind === 'broad') expect(lstatSync(dir).mode & 0o777).toBe(0o755)
    },
  )
})
