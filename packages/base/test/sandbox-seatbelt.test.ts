import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { seatbeltDenyNetworkArgv } from '../src/sandbox-seatbelt.js'

function run(argv: string[]) {
  const [file, ...args] = argv
  if (!file) throw new Error('missing executable')
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { timeout: 3000 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout })
    })
  })
}
it.each(['relative', '/bad\npath', '/bad\0path', '/bad\x7fpath'])(
  'refuses invalid path %j without echo',
  (path) => {
    expect(() => seatbeltDenyNetworkArgv(['true'], { allowPaths: [path], denyPaths: [] })).toThrow(
      /^invalid sandbox policy$/,
    )
  },
)
it('does not grant implicit temp/device writes and denies both reads and writes', () => {
  const args = seatbeltDenyNetworkArgv(['echo', 'a b'], { allowPaths: ['/w'], denyPaths: ['/w/secret'] })
  expect(args[0]).toBe('/usr/bin/sandbox-exec')
  expect(args.slice(-2)).toEqual(['echo', 'a b'])
  expect(args[2]).toContain('(deny file-read* file-write* (subpath "/w/secret"))')
  expect(args[2]).not.toContain('/private/tmp')
  expect(args[2]).not.toContain('/dev')
  expect(args[2]).toContain('(deny network*)')
})
// These are platform acceptance checks, not simulated results. Non-macOS skips remain OS-matrix debt.
const seatbelt = it.runIf(existsSync('/usr/bin/sandbox-exec'))
seatbelt(
  'enforces actual writes, secret reads/writes, symlink targets and descendant inheritance',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-seatbelt-')))
    const allowed = join(root, 'allow " \\ 中文')
    const denied = join(allowed, 'secret')
    mkdirSync(allowed)
    mkdirSync(denied)
    const secret = join(denied, 'value')
    writeFileSync(secret, 'private')
    symlinkSync(secret, join(allowed, 'link'))
    const confine = (cmd: string, ...args: string[]) =>
      seatbeltDenyNetworkArgv(['/bin/sh', '-c', cmd, 'probe', ...args], {
        allowPaths: [allowed],
        denyPaths: [denied],
      })
    try {
      expect(await run(confine('printf ok > "$1"; cat "$1"', join(allowed, 'ok')))).toEqual({
        code: 0,
        stdout: 'ok',
      })
      expect((await run(confine('printf bad > "$1"', join(root, 'outside')))).code).not.toBe(0)
      expect(existsSync(join(root, 'outside'))).toBe(false)
      expect((await run(confine('cat "$1"', secret))).code).not.toBe(0)
      expect((await run(confine('printf bad > "$1"', secret))).code).not.toBe(0)
      expect((await run(confine('cat "$1"', join(allowed, 'link')))).code).not.toBe(0)
      expect((await run(confine('/bin/sh -c \'cat "$1"\' child "$1"', secret))).code).not.toBe(0)
      expect(readFileSync(secret, 'utf8')).toBe('private')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
seatbelt('blocks a real loopback request whose unconfined control reaches the server', async () => {
  let requests = 0
  const server = createServer((_req, res) => {
    requests++
    res.end('reachable')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const argv = [
    '/usr/bin/curl',
    '--silent',
    '--show-error',
    '--max-time',
    '1',
    '--noproxy',
    '*',
    `http://127.0.0.1:${address.port}/`,
  ]
  try {
    expect(await run(argv)).toEqual({ code: 0, stdout: 'reachable' })
    expect(requests).toBe(1)
    const result = await run(seatbeltDenyNetworkArgv(argv, { allowPaths: [], denyPaths: [] }))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(requests).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
