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
import { openLocalProcess } from '@agnes/host-infrastructure/adapters/process'
import { expect, it } from 'vitest'
import { seatbeltDenyNetworkArgv } from '../src/sandbox-seatbelt.js'

function run(argv: string[], env?: NodeJS.ProcessEnv) {
  const [file, ...args] = argv
  if (!file) throw new Error('missing executable')
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { timeout: 3000, ...(env ? { env } : {}) }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout })
    })
  })
}
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
      const env = {
        PATH: '/usr/bin:/bin',
        HOME: allowed,
        TMPDIR: allowed,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      }
      expect((await run(['/usr/bin/git', 'init', '--quiet', '--template=', allowed], env)).code).toBe(0)
      const status = await run(confine('git -C "$1" status --short', allowed), env)
      expect(status.code).toBe(0)
      expect(status.stdout).toContain('?? ok')
      expect(await run(confine('echo x > /dev/null; exec 3<> /dev/null'))).toEqual({ code: 0, stdout: '' })
      const denyNull = seatbeltDenyNetworkArgv(['/bin/sh', '-c', 'echo x > /dev/null'], {
        allowPaths: [allowed],
        denyPaths: [denied, '/dev/null'],
      })
      expect((await run(denyNull)).code).not.toBe(0)
      expect((await run(confine('echo x > /dev/zero'))).code).not.toBe(0)
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

it.runIf(existsSync('/usr/bin/sandbox-exec') && existsSync('/bin/zsh'))(
  'preserves controlling-TTY job control in a confined interactive shell',
  async () => {
    const handle = await openLocalProcess({
      argv: seatbeltDenyNetworkArgv(['/bin/zsh', '-f', '-i'], { allowPaths: [], denyPaths: [] }),
      cwd: tmpdir(),
      env: { HOME: tmpdir() },
      pty: { columns: 80, rows: 24 },
    })
    let output = ''
    handle.onOutput((chunk) => {
      output += chunk.text
    })
    try {
      await handle.write('tty; print -r -- control-$options[monitor]; exit\r')
      await handle.exited
      expect(output).toMatch(/\/dev\/tty[^\s]+/)
      expect(output).toContain('control-on')
      expect(output).not.toMatch(/can't set tty pgrp|no job control/i)
    } finally {
      await handle.close()
    }
  },
)

seatbelt('serves real IPv4/IPv6 loopback HTTP without wildcard binds or outbound connections', async () => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const control = createServer((_req, res) => res.end('control'))
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve))
  const address = control.address()
  if (!address || typeof address === 'string') throw new Error('missing control address')
  const program = `
    const http = require('node:http'), net = require('node:net');
    const bind = host => new Promise(resolve => {
      const server = http.createServer((_, res) => res.end('loopback-only'));
      server.once('error', error => resolve({ host, error: error.code }));
      server.listen(0, host, () => resolve({ host, port: server.address().port }));
    });
    const connect = host => new Promise(resolve => {
      const socket = net.connect({host, port: ${address.port}});
      socket.on('error', error => resolve(error.code));
      socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve('TIMEOUT'); });
    });
    (async () => {
      const binds = await Promise.all(['127.0.0.1','::1','0.0.0.0','::'].map(bind));
      const outbound = await Promise.all(['127.0.0.1','192.0.2.1'].map(connect));
      console.log(JSON.stringify({ binds, outbound }));
    })();
  `
  const argv = seatbeltDenyNetworkArgv([process.execPath, '-e', program], {
    allowPaths: [],
    denyPaths: [],
    loopbackServe: true,
  })
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '',
    stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  try {
    const facts = await new Promise<{
      binds: { host: string; port?: number; error?: string }[]
      outbound: string[]
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 5000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('\n')) {
          clearTimeout(timeout)
          resolve(JSON.parse(stdout.trim()))
        }
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timeout)
        reject(new Error(`server exited: ${stderr}`))
      })
    })
    for (const host of ['127.0.0.1', '::1']) {
      const bind = facts.binds.find((bind) => bind.host === host)!
      expect(bind.error, stderr).toBeUndefined()
      const response = await fetch(`http://${host === '::1' ? '[::1]' : host}:${bind.port}/`)
      expect(await response.text()).toBe('loopback-only')
    }
    expect(
      facts.binds
        .filter((bind) => ['0.0.0.0', '::'].includes(bind.host))
        .every((bind) => bind.error === 'EPERM' || bind.error === 'EACCES'),
    ).toBe(true)
    expect(facts.outbound.every((code) => code === 'EPERM' || code === 'EACCES')).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await new Promise<void>((resolve) => control.close(() => resolve()))
  }
})
