import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ResolvedProfile } from '@agnes/host'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIMITS } from '../src/config.js'
import { acquireOwnerLock } from '../src/supervisor/owner-lock.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'

const directories = new Set<string>()
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})
function socketPaths(dataDir: string) {
  const paths = daemonSocketPaths({ dataDir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dataDir, 'daemon'))
    directories.add(dirname(paths.socketPath))
  return paths
}

describe('supervisor startup cleanup', () => {
  it('rejects conflicting or null projected artifact authority and releases the owner lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-artifact-projection-config-'))
    const daemonDir = join(dir, 'daemon')
    createPrivateDirectorySync(daemonDir)
    const socketPath = socketPaths(dir).socketPath
    const processIdentity = async (pid: number) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'artifact-projection-config-test' } as const)
        : ({ state: 'dead' } as const)
    const profile = {
      name: 'local-dev',
      dataDir: dir,
      presets: { default: 'standard', allowed: ['standard'] },
      hash: 'artifact-projection-config',
    } as unknown as ResolvedProfile
    const profileFile = join(daemonDir, 'profile.json')
    const base = {
      config: {
        profileName: 'local-dev',
        dataDir: dir,
        socketPath,
        workersSocketPath: socketPaths(dir).workersSocketPath,
        limits: DEFAULT_LIMITS,
      },
      profile,
      profileDir: join(dir, 'profiles', 'local-dev'),
      profileFile,
      processIdentity,
    }
    const assertReleased = async () => {
      const lock = await acquireOwnerLock(dir, { socketPath, processIdentity })
      await lock.release()
    }
    try {
      await expect(
        startSupervisor({
          ...base,
          artifactAuthorityProjection: {} as never,
          ports: { artifactRead: {} as never },
        }),
      ).rejects.toThrow('artifact authority projection conflicts')
      await assertReleased()

      await expect(startSupervisor({ ...base, artifactAuthorityProjection: null as never })).rejects.toThrow(
        'production artifact projection configuration is invalid',
      )
      await assertReleased()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes a started JWKS cache and releases its owner lock when a later listener fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-startup-cleanup-'))
    const daemonDir = join(dir, 'daemon')
    createPrivateDirectorySync(daemonDir)
    const workersSocketPath = socketPaths(dir).workersSocketPath
    const blocker = await listenUnix(workersSocketPath, () => undefined)
    const profile = {
      name: 'local-dev',
      dataDir: dir,
      presets: { default: 'standard', allowed: ['standard'] },
      hash: 'startup-cleanup',
    } as unknown as ResolvedProfile
    const profileFile = join(daemonDir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const processIdentity = async (pid: number) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'startup-cleanup-test' } as const)
        : ({ state: 'dead' } as const)
    const transport = vi.fn(async () => ({
      status: 200,
      remoteAddress: '8.8.8.8',
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{"keys":[{"kid":"one","kty":"RSA"}]}')
        },
      },
    }))
    try {
      await expect(
        startSupervisor({
          config: {
            profileName: 'local-dev',
            dataDir: dir,
            socketPath: socketPaths(dir).socketPath,
            workersSocketPath,
            limits: DEFAULT_LIMITS,
          },
          profile,
          profileDir: join(dir, 'profiles', 'local-dev'),
          profileFile,
          processIdentity,
          remoteAuth: { jwt: { issuer: 'issuer', jwksUrl: 'https://issuer.test/keys' } },
          jwksResolver: async () => ['8.8.8.8'],
          jwksTransport: transport,
        }),
      ).rejects.toThrow('daemon socket unavailable')
      expect(transport).toHaveBeenCalledTimes(1)
      const lock = await acquireOwnerLock(dir, {
        socketPath: socketPaths(dir).socketPath,
        processIdentity: async (pid) =>
          pid === process.pid ? { state: 'alive', startId: 'cleanup-test' } : { state: 'dead' },
      })
      await lock.release()
    } finally {
      await blocker.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('releases its owner lock when synchronous storage construction fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-startup-sync-cleanup-'))
    const daemonDir = join(dir, 'daemon')
    createPrivateDirectorySync(daemonDir)
    const profile = {
      name: 'local-dev',
      dataDir: dir,
      presets: { default: 'standard', allowed: ['standard'] },
      hash: 'sync-startup-cleanup',
    } as unknown as ResolvedProfile
    const profileFile = join(daemonDir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const socketPath = socketPaths(dir).socketPath
    const processIdentity = async (pid: number) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'sync-cleanup-test' } as const)
        : ({ state: 'dead' } as const)
    try {
      await expect(
        startSupervisor({
          config: {
            profileName: 'local-dev',
            dataDir: dir,
            socketPath,
            workersSocketPath: socketPaths(dir).workersSocketPath,
            limits: DEFAULT_LIMITS,
          },
          profile,
          profileDir: join(dir, 'profiles', 'local-dev'),
          profileFile,
          processIdentity,
          jobTables: {
            table: () => {
              throw new Error('injected table failure')
            },
          },
        }),
      ).rejects.toThrow('injected table failure')
      const afterConstructionFailure = await acquireOwnerLock(dir, { socketPath, processIdentity })
      await afterConstructionFailure.release()

      await expect(
        startSupervisor({
          config: {
            profileName: 'local-dev',
            dataDir: dir,
            socketPath,
            workersSocketPath: socketPaths(dir).workersSocketPath,
            limits: DEFAULT_LIMITS,
          },
          profile,
          profileDir: join(dir, 'profiles', 'local-dev'),
          profileFile,
          processIdentity,
          ports: {
            journal: {
              begin: vi.fn(),
              complete: vi.fn(),
              abandon: vi.fn(),
              ack: vi.fn(),
              gc: async () => {
                throw new Error('injected GC failure')
              },
            },
          },
        }),
      ).rejects.toThrow('injected GC failure')
      const afterGcFailure = await acquireOwnerLock(dir, { socketPath, processIdentity })
      await afterGcFailure.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
