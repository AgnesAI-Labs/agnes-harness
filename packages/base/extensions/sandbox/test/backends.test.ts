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
import { describe, expect, it } from 'vitest'
import { bwrapConfine, seatbeltConfine, winConfine } from '../src/backends.js'

const options = {
  cwd: '/work/proj',
  allowPaths: ['/work/proj', '/tmp/explicit'],
  denyPaths: ['/work/proj/secret'],
  networkAllow: [] as string[],
}

describe('closed-network backend compilers', () => {
  it('builds a shell-free bwrap argv with deny mounts after writable mounts', () => {
    const confined = bwrapConfine(['--hostile-looking-executable', '-c', 'literal $HOME; touch /x'], options)
    expect(confined[0]).toBe('bwrap')
    expect(confined).toEqual(
      expect.arrayContaining([
        '--ro-bind',
        '/',
        '/',
        '--unshare-pid',
        '--unshare-net',
        '--bind',
        '/work/proj',
        '/work/proj',
        '--tmpfs',
        '/work/proj/secret',
        '--chdir',
        '/work/proj',
        '--',
      ]),
    )
    expect(confined.indexOf('--tmpfs')).toBeGreaterThan(confined.lastIndexOf('--bind'))
    expect(confined.slice(-3)).toEqual(['--hostile-looking-executable', '-c', 'literal $HOME; touch /x'])
  })

  it('rejects lexical aliases, controls, NUL argv and unsafe writable kernel trees', () => {
    for (const path of ['relative', '/work/../etc', '/work//x', '/bad\npath']) {
      expect(() => bwrapConfine(['true'], { ...options, allowPaths: [path] })).toThrow(
        /E_SANDBOX_BACKEND_POLICY/,
      )
    }
    for (const path of ['/', '/proc', '/dev/fd', '/sys/kernel']) {
      expect(() => bwrapConfine(['true'], { ...options, allowPaths: [path] })).toThrow(
        /E_SANDBOX_BACKEND_POLICY/,
      )
    }
    expect(() => bwrapConfine(['bad\0command'], options)).toThrow(/E_SANDBOX_BACKEND_POLICY/)
  })

  it.each([bwrapConfine, seatbeltConfine])(
    'refuses a host allowlist instead of silently opening the network',
    (confine) => {
      expect(() => confine(['true'], { ...options, networkAllow: ['api.example.com'] })).toThrow(
        /E_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED/,
      )
    },
  )

  it('escapes Seatbelt strings and denies both operations without implicit temp/device writes', () => {
    const confined = seatbeltConfine(['echo', 'a b'], {
      ...options,
      allowPaths: ['/work/quote" and \\ slash'],
      denyPaths: ['/work/quote" and \\ slash/secret'],
    })
    const profile = confined[2]
    expect(confined.slice(-2)).toEqual(['echo', 'a b'])
    expect(profile).toContain('(allow file-write* (subpath "/work/quote\\" and \\\\ slash"))')
    expect(profile).toContain(
      '(deny file-read* file-write* (subpath "/work/quote\\" and \\\\ slash/secret"))',
    )
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('/private/tmp')
    expect(profile).not.toContain('/dev')
  })

  it('does not return raw argv for a Windows backend it cannot enforce', () => {
    expect(() => winConfine(['cmd.exe', '/c', 'echo unsafe'], options)).toThrow(
      /E_SANDBOX_HOST_ENFORCEMENT_REQUIRED/,
    )
  })
})

function run(argv: string[]) {
  const [file, ...args] = argv
  if (!file) throw new Error('missing executable')
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { timeout: 3000 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout })
    })
  })
}

// Actual acceptance evidence on macOS. Other platforms retain an explicit OS-matrix boundary.
const seatbelt = it.runIf(existsSync('/usr/bin/sandbox-exec'))
seatbelt('blocks real files, a descendant process and a symlink target', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-i6-seatbelt-')))
  const allowed = join(root, 'allow " \\ unicode-中')
  const denied = join(allowed, 'secret')
  mkdirSync(allowed)
  mkdirSync(denied)
  const secret = join(denied, 'value')
  writeFileSync(secret, 'private')
  symlinkSync(secret, join(allowed, 'link'))
  const confine = (source: string, ...args: string[]) =>
    seatbeltConfine(['/bin/sh', '-c', source, 'probe', ...args], {
      cwd: allowed,
      allowPaths: [allowed],
      denyPaths: [denied],
      networkAllow: [],
    })
  try {
    expect(await run(confine('printf ok > "$1"; cat "$1"', join(allowed, 'ok')))).toEqual({
      code: 0,
      stdout: 'ok',
    })
    expect((await run(confine('printf bad > "$1"', join(root, 'outside')))).code).not.toBe(0)
    expect((await run(confine('cat "$1"', secret))).code).not.toBe(0)
    expect((await run(confine('printf bad > "$1"', secret))).code).not.toBe(0)
    expect((await run(confine('cat "$1"', join(allowed, 'link')))).code).not.toBe(0)
    expect((await run(confine('/bin/sh -c \'cat "$1"\' child "$1"', secret))).code).not.toBe(0)
    expect(readFileSync(secret, 'utf8')).toBe('private')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

seatbelt('blocks a real loopback request whose unconfined control succeeds', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end('reachable')
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
    const confined = seatbeltConfine(argv, {
      cwd: '/tmp',
      allowPaths: [],
      denyPaths: [],
      networkAllow: [],
    })
    expect((await run(confined)).code).not.toBe(0)
    expect(requests).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
