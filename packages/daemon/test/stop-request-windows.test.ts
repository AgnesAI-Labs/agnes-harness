import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopDaemon } from '../src/supervisor/control.js'
import { encodeOwner } from '../src/supervisor/owner-record.js'
import {
  hasWindowsStopRequest,
  publishWindowsStopRequest,
  watchWindowsStopRequest,
} from '../src/supervisor/stop-request.js'

const owner = {
  pid: process.pid,
  processStartId: 'test-start',
  generation: '11111111-2222-3333-4444-555555555555',
}
const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stop-request-'))
  roots.push(root)
  createPrivateDirectorySync(join(root, 'daemon'))
  return { root, file: join(root, 'daemon', 'stop-request.json') }
}
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe.skipIf(process.platform !== 'win32')('Windows generation-bound stop requests', () => {
  it('times out without killing a real child that does not consume the stop request', async () => {
    const { root } = setup()
    const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('child exited before ready')))
      })
      if (!child.pid) throw new Error('child pid unavailable')
      const identity = await defaultProcessIdentity(child.pid)
      if (identity.state !== 'alive') throw new Error('child identity unavailable')
      const generation = { ...owner, pid: child.pid, processStartId: identity.startId }
      const record = encodeOwner({
        ...generation,
        startedAt: new Date().toISOString(),
        socketPath: `\\\\.\\pipe\\agnes-test-${child.pid}`,
      })
      const ownerFile = join(root, 'daemon', 'owner.json')
      writeFileSync(ownerFile, record)
      expect(await stopDaemon(root, { waitMs: 100, pollMs: 20 })).toBe('timeout')
      expect(hasWindowsStopRequest(root, generation)).toBe(true)
      expect(await defaultProcessIdentity(child.pid)).toEqual(identity)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      expect(readFileSync(ownerFile, 'utf8')).toBe(record)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    }
  })

  it('lets a real child complete its shutdown routine instead of killing it', async () => {
    const { root } = setup()
    const marker = join(root, 'closed.txt')
    const entry = new URL('../src/supervisor/stop-request.ts', import.meta.url).href
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import {writeFileSync} from 'node:fs';
      const {watchWindowsStopRequest}=await import(${JSON.stringify(entry)});
      process.once('message', owner=>{
        watchWindowsStopRequest(${JSON.stringify(root)},owner,()=>{
          writeFileSync(${JSON.stringify(marker)},'closed');process.exit(0);
        });process.send('ready');
      });setInterval(()=>{},1000);
    `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
    )
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      if (!child.pid) throw new Error('child pid unavailable')
      const generation = { ...owner, pid: child.pid }
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('child exited before ready')))
      })
      child.send(generation)
      await ready
      writeFileSync(
        join(root, 'daemon', 'owner.json'),
        encodeOwner({
          ...generation,
          startedAt: new Date().toISOString(),
          socketPath: `\\\\.\\pipe\\agnes-test-${child.pid}`,
        }),
      )
      expect(
        await stopDaemon(root, {
          processIdentity: async () =>
            child.exitCode === null && child.signalCode === null
              ? { state: 'alive', startId: generation.processStartId }
              : { state: 'dead' },
          waitMs: 3000,
        }),
      ).toBe('stopped')
      await closed
      expect(child.exitCode).toBe(0)
      expect(readFileSync(marker, 'utf8')).toBe('closed')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    }
  })
  it('publishes privately and rejects missing, stale, malformed and oversized requests', () => {
    const { root, file } = setup()
    expect(hasWindowsStopRequest(root, owner)).toBe(false)
    publishWindowsStopRequest(root, owner)
    expect(hasPrivateDaclSync(file)).toBe(true)
    expect(hasWindowsStopRequest(root, owner)).toBe(true)
    for (const change of [
      { pid: owner.pid + 1 },
      { processStartId: 'reused' },
      { generation: 'new-generation' },
    ])
      expect(hasWindowsStopRequest(root, { ...owner, ...change })).toBe(false)
    const original = readFileSync(file, 'utf8')
    for (const value of [
      '{',
      Buffer.from([255]),
      ' '.repeat(4097),
      JSON.stringify({ ...JSON.parse(original), extra: true }),
    ]) {
      writeFileSync(file, value)
      expect(hasWindowsStopRequest(root, owner)).toBe(false)
    }
  })
  it('refuses a request readable by Everyone', () => {
    const { root, file } = setup()
    publishWindowsStopRequest(root, owner)
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
    })
    expect(hasWindowsStopRequest(root, owner)).toBe(false)
  })
  it('invokes shutdown once and stops observing after disposal', () => {
    vi.useFakeTimers()
    const { root } = setup()
    const stop = vi.fn()
    const dispose = watchWindowsStopRequest(root, owner, stop)
    try {
      publishWindowsStopRequest(root, owner)
      vi.advanceTimersByTime(1000)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
    }
    const closed = vi.fn()
    watchWindowsStopRequest(root, owner, closed)()
    vi.advanceTimersByTime(1000)
    expect(closed).not.toHaveBeenCalled()
  })
})
