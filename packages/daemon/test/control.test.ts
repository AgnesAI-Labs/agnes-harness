import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DaemonControlError, daemonStatus, runDaemonControl, stopDaemon } from '../src/supervisor/control.js'
import { acquireOwnerLock } from '../src/supervisor/owner-lock.js'
import { encodeOwner } from '../src/supervisor/owner-record.js'

describe('daemonStatus', () => {
  it('reports absence, then verifies both owner process identity and socket reachability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-control-'))
    try {
      expect(await daemonStatus(dir)).toEqual({ running: false })
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'control-test' }),
      })
      try {
        await expect(
          daemonStatus(dir, {
            processIdentity: async () => ({ state: 'alive', startId: 'control-test' }),
            connect: async () => true,
          }),
        ).resolves.toMatchObject({
          running: true,
          socketReachable: true,
          owner: { pid: process.pid, processStartId: 'control-test' },
        })
        await expect(
          daemonStatus(dir, {
            processIdentity: async () => ({ state: 'alive', startId: 'reused-pid' }),
            connect: async () => true,
          }),
        ).resolves.toEqual({ running: false })
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when owner identity cannot be verified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-control-unknown-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'control-unknown' }),
      })
      try {
        const state = await daemonStatus(dir, {
          processIdentity: async () => ({ state: 'unknown', reason: 'EPERM' }),
          connect: async () => false,
        })
        expect(state).toMatchObject({ running: true, socketReachable: false })
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds an identity query that never settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-control-bounded-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'control-bounded' }),
      })
      try {
        await expect(
          daemonStatus(dir, {
            processIdentity: () => new Promise(() => {}),
            identityTimeoutMs: 5,
            connect: async () => false,
          }),
        ).resolves.toMatchObject({ running: true, socketReachable: false })
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probes a real local socket and closes the probe connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-control-socket-'))
    const socketPath =
      process.platform === 'win32' ? `\\\\.\\pipe\\agnes-control-${randomUUID()}` : join(dir, 'daemon.sock')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const lock = await acquireOwnerLock(dir, {
        socketPath,
        processIdentity: async () => ({ state: 'alive', startId: 'control-socket' }),
      })
      try {
        await expect(
          daemonStatus(dir, {
            processIdentity: async () => ({ state: 'alive', startId: 'control-socket' }),
          }),
        ).resolves.toMatchObject({ running: true, socketReachable: true })
      } finally {
        await lock.release()
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('stopDaemon', () => {
  it('is idempotent when no owner exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-absent-'))
    try {
      const kill = vi.fn()
      await expect(stopDaemon(dir, { kill })).resolves.toBe('not-running')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rechecks the exact owner identity, sends only SIGTERM, and observes shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-live-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'stop-live' }),
      })
      let alive = true
      const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
        alive = false
      })
      try {
        await expect(
          stopDaemon(dir, {
            kill,
            processIdentity: async () =>
              alive ? { state: 'alive', startId: 'stop-live' } : { state: 'dead' },
            waitMs: 500,
          }),
        ).resolves.toBe('stopped')
        expect(kill).toHaveBeenCalledTimes(1)
        expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not signal a stale owner or a PID reused between the two checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-stale-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'stop-stale' }),
      })
      const kill = vi.fn()
      try {
        await expect(
          stopDaemon(dir, {
            kill,
            processIdentity: async () => ({ state: 'alive', startId: 'other-process' }),
          }),
        ).resolves.toBe('not-running')

        let checks = 0
        await expect(
          stopDaemon(dir, {
            kill,
            processIdentity: async () =>
              ++checks === 1
                ? { state: 'alive', startId: 'stop-stale' }
                : { state: 'alive', startId: 'reused-before-signal' },
          }),
        ).resolves.toBe('not-running')
        expect(kill).not.toHaveBeenCalled()
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an owner generation replaced during the pre-signal check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-owner-race-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'stop-owner-race' }),
      })
      const ownerFile = join(dir, 'daemon', 'owner.json')
      const replacement = {
        ...lock.owner,
        generation: '00000000-0000-0000-0000-000000000000',
      }
      const kill = vi.fn()
      try {
        await expect(
          stopDaemon(dir, {
            kill,
            processIdentity: async () => {
              writeFileSync(ownerFile, encodeOwner(replacement))
              return { state: 'alive', startId: 'stop-owner-race' }
            },
          }),
        ).rejects.toThrow('owner changed')
        expect(kill).not.toHaveBeenCalled()
      } finally {
        writeFileSync(ownerFile, encodeOwner(lock.owner))
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses unknown identity and signal errors without escalating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-refuse-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'stop-refuse' }),
      })
      const kill = vi.fn()
      try {
        await expect(
          stopDaemon(dir, {
            kill,
            processIdentity: async () => ({ state: 'unknown', reason: 'EPERM' }),
          }),
        ).rejects.toBeInstanceOf(DaemonControlError)
        expect(kill).not.toHaveBeenCalled()

        await expect(
          stopDaemon(dir, {
            kill: () => {
              const error = new Error('denied') as NodeJS.ErrnoException
              error.code = 'EPERM'
              throw error
            },
            processIdentity: async () => ({ state: 'alive', startId: 'stop-refuse' }),
          }),
        ).rejects.toThrow('failed to signal daemon')
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats ESRCH as stopped and exercises the omitted 35 second wait default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-default-'))
    try {
      const lock = await acquireOwnerLock(dir, {
        socketPath: join(dir, 'daemon.sock'),
        processIdentity: async () => ({ state: 'alive', startId: 'stop-default' }),
      })
      try {
        await expect(
          stopDaemon(dir, {
            kill: () => {
              const error = new Error('gone') as NodeJS.ErrnoException
              error.code = 'ESRCH'
              throw error
            },
            processIdentity: async () => ({ state: 'alive', startId: 'stop-default' }),
          }),
        ).resolves.toBe('stopped')

        let now = 0
        await expect(
          stopDaemon(dir, {
            kill: () => {},
            processIdentity: async () => ({ state: 'alive', startId: 'stop-default' }),
            now: () => now,
            sleep: async (ms) => {
              now += ms
            },
          }),
        ).resolves.toBe('timeout')
        expect(now).toBe(35_000)
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'sends a real SIGTERM to a child recorded as the owner',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-stop-child-'))
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000)",
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      )
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('message', () => resolve())
          child.once('error', reject)
        })
        if (child.pid === undefined) throw new Error('child pid unavailable')
        const owner = {
          pid: child.pid,
          processStartId: 'real-child',
          generation: randomUUID(),
          startedAt: new Date().toISOString(),
          socketPath: join(dir, 'daemon.sock'),
        }
        mkdirSync(join(dir, 'daemon'), { recursive: true })
        writeFileSync(join(dir, 'daemon', 'owner.json'), encodeOwner(owner))
        await expect(
          stopDaemon(dir, {
            processIdentity: async (pid) =>
              pid === child.pid && child.exitCode === null
                ? { state: 'alive', startId: 'real-child' }
                : { state: 'dead' },
            waitMs: 2000,
          }),
        ).resolves.toBe('stopped')
        expect(child.exitCode).toBe(0)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('runDaemonControl', () => {
  it('routes status and stop to the requested data directory with stable output and exit codes', async () => {
    const output: string[] = []
    const status = vi.fn(async () => ({ running: false }))
    expect(
      await runDaemonControl(
        { command: 'status', profile: 'default' },
        { env: { AGH_HOME: resolve('/state') }, status, write: (text) => output.push(text) },
      ),
    ).toBe(1)
    expect(status).toHaveBeenCalledWith(resolve('/state'))
    expect(output).toEqual(['{"running":false}\n'])

    const stop = vi.fn(async () => 'stopped' as const)
    expect(
      await runDaemonControl(
        { command: 'stop', profile: 'default', dataDir: '/explicit' },
        { stop, write: (text) => output.push(text) },
      ),
    ).toBe(0)
    expect(stop).toHaveBeenCalledWith(resolve('/explicit'))
    expect(output.at(-1)).toBe('stopped\n')
  })
})
