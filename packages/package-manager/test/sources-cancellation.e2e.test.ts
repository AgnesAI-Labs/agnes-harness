import { execFileSync } from 'node:child_process'
import {
  chmodSync,
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
import { delimiter, dirname, join } from 'node:path'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchSource, parseSource, withLock } from '../src/index.js'

const roots: string[] = []
const running: Array<{ abort: AbortController; outcome: Promise<unknown> }> = []
afterEach(async () => {
  for (const task of running.splice(0)) {
    task.abort.abort()
    await task.outcome
  }
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-source-cancel-'))
  roots.push(root)
  return root
}
const processGone = (pid: number): boolean => {
  if (process.platform === 'win32') return windowsProcessStartTimeSync(pid) === null
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  try {
    // A reaped process is absent, while a child pending its parent's reaping can briefly remain a
    // zombie. Both outcomes prove the process tree stopped executing; `kill(pid, 0)` alone cannot
    // distinguish them on macOS.
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    return true
  }
}
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('fixture timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
function npmFixture(bin: string, fixture: string) {
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'fixture.cjs'), fixture)
    writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\nnode "%~dp0fixture.cjs" %*\r\n')
    vi.stubEnv('PATH', [bin, dirname(process.execPath), process.env.PATH].join(delimiter))
  } else {
    const executable = join(bin, 'npm')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(
      executable,
      `#!/bin/sh\nexec env ${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(process.execPath)} -e ${quote(fixture)}\n`,
    )
    chmodSync(executable, 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  }
}
it.each([false, true])('default npm process cancellation awaits close (ignore TERM: %s)', async (ignore) => {
  const root = temp(),
    bin = join(root, 'bin')
  mkdirSync(bin)
  const marker = join(root, 'ready'),
    finished = join(root, 'finished')
  const fixture = `const fs=require('node:fs');process.on('SIGTERM',()=>{${ignore ? '' : `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finished)},'closed');process.exit(0)},150)`}});fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},100);`
  npmFixture(bin, fixture)
  const abort = new AbortController(),
    into = join(root, 'installed')
  // Attach the rejection handler immediately; cancellation should not produce an unhandled rejection.
  const outcome = fetchSource(parseSource('npm:acme@1.0.0'), into, { cwd: root, signal: abort.signal }).then(
    () => null,
    (error) => error,
  )
  running.push({ abort, outcome })
  await wait(() => existsSync(marker))
  const pid = Number(readFileSync(marker, 'utf8'))
  abort.abort()
  const error = await outcome
  expect(error).toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
  await wait(() => processGone(pid))
  expect(processGone(pid)).toBe(true)
  expect(existsSync(finished)).toBe(process.platform === 'win32' ? false : !ignore)
  expect(existsSync(into)).toBe(false)
  expect(readdirSync(root).filter((x) => x.startsWith('.agnes-fetch-'))).toEqual([])
})
it('cancels an npm child and its SIGTERM-ignoring grandchild as one process group', async () => {
  const root = temp(),
    bin = join(root, 'bin')
  mkdirSync(bin)
  const marker = join(root, 'pids'),
    into = join(root, 'installed')
  const grandchildReady = join(root, 'grandchild-ready')
  const grandchild = [
    "const { renameSync, writeFileSync } = require('node:fs')",
    `const ready=${JSON.stringify(grandchildReady)}`,
    "writeFileSync(ready + '.tmp', String(process.pid))",
    "renameSync(ready + '.tmp', ready)",
    "process.on('SIGTERM',()=>{})",
    'setInterval(()=>{},100)',
  ].join(';')
  const fixture = [
    "const { existsSync, renameSync, writeFileSync } = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    `const ready=${JSON.stringify(grandchildReady)}`,
    `const marker=${JSON.stringify(marker)}`,
    `const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'})`,
    "const temporary=marker+'.tmp'",
    'const publish=()=>{if(!existsSync(ready))return;writeFileSync(temporary,JSON.stringify({parent:process.pid,grandchild:grandchild.pid}));renameSync(temporary,marker);clearInterval(wait)}',
    'const wait=setInterval(publish,5);publish()',
    "process.on('SIGTERM',()=>{})",
    'setInterval(()=>{},100)',
  ].join(';')
  npmFixture(bin, fixture)
  const abort = new AbortController()
  const outcome = fetchSource(parseSource('npm:acme@1.0.0'), into, { cwd: root, signal: abort.signal }).then(
    () => null,
    (error) => error,
  )
  running.push({ abort, outcome })
  const readPids = (): { parent: number; grandchild: number } | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { parent?: unknown; grandchild?: unknown }
      const parent = parsed.parent
      const grandchild = parsed.grandchild
      return typeof parent === 'number' &&
        Number.isSafeInteger(parent) &&
        typeof grandchild === 'number' &&
        Number.isSafeInteger(grandchild)
        ? { parent, grandchild }
        : undefined
    } catch {
      return undefined
    }
  }
  await wait(() => readPids() !== undefined)
  const pids = readPids()
  if (!pids) throw Error('fixture did not publish both process IDs')
  try {
    abort.abort()
    await expect(outcome).resolves.toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
    await wait(() => processGone(pids.parent) && processGone(pids.grandchild))
    expect(existsSync(into)).toBe(false)
    expect(readdirSync(root).filter((entry) => entry.startsWith('.agnes-fetch-'))).toEqual([])
  } finally {
    abort.abort()
    await outcome
    for (const pid of process.platform === 'win32' ? [] : [pids.parent, pids.grandchild]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The asserted outcome is that both are already gone.
      }
    }
  }
})

it('an aged live writer remains exclusive and a waiting operation can cancel', async () => {
  const root = temp(),
    events: string[] = [],
    abort = new AbortController()
  let release: () => void = () => {
    throw Error('not started')
  }
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = withLock(root, async () => {
    events.push('first')
    await held
    events.push('released')
  })
  const lock = join(root, '.agnes-lock.lock')
  const old = new Date(Date.now() - 60000)
  utimesSync(lock, old, old)
  const second = withLock(
    root,
    async () => {
      events.push('second')
    },
    { signal: abort.signal },
  ).then(
    () => null,
    (error) => error,
  )
  await new Promise((r) => setTimeout(r, 40))
  abort.abort()
  const result = await second
  try {
    expect(result).toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
    expect(events).toEqual(['first'])
    expect(existsSync(lock)).toBe(true)
  } finally {
    release()
    await first
  }
  expect(existsSync(lock)).toBe(false)
})
