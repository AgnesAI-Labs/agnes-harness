import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsPolicy } from '@agnes/core'
import { withSessionFileAccess } from '@agnes/host-common/session-file-access'
import { CliWorkspaceAuthority } from '@agnes/host-common/workspace-authority'
import type { RemoteWorkspacePool } from '@agnes/sandbox-remote'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecAdapter } from '../../src/adapters/exec.js'
import { createPlatform } from '../../src/adapters/platform.js'
import { createLoopbackTransport, type RemoteTransport } from '../../src/adapters/remote-transport.js'
import { createSessionWorkspaceAdapterFactory } from '../../src/adapters/session-workspace.js'

const roots: string[] = []
// guards-allow-platform: the loopback spawns remote POSIX commands on this machine.
const posixIt = process.platform === 'win32' ? it.skip : it
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function policy(root: string, digest: string): FsPolicy {
  return Object.freeze({
    workspaceRoot: root,
    rules: Object.freeze([
      Object.freeze({ effect: 'allow' as const, path: root, source: 'workspace' as const, hard: false }),
      Object.freeze({
        effect: 'deny' as const,
        path: join(root, '.git'),
        source: 'host-integrity' as const,
        hard: true,
      }),
      ...['.agh'].map((name) =>
        Object.freeze({
          effect: 'deny' as const,
          path: join(root, name, 'secrets'),
          source: 'host-integrity' as const,
          hard: true,
        }),
      ),
    ]),
    networkAllow: Object.freeze([]),
    digest,
  })
}

describe('session workspace adapters', () => {
  it('holds the AGH workspace secrets directory in its floor, before and at bind', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-ws-floor-')))
    roots.push(root)
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec: { run: vi.fn<ExecAdapter['run']>(), killAll: async () => undefined },
    })
    const handle = await factory.openWorkspace(new CliWorkspaceAuthority(root).bind('floor'))
    const fence = await factory.openFence(handle)
    // The bootstrap fence is built from the floor alone.
    for (const dir of ['.agh'])
      await expect(fence.fs.read(`${dir}/secrets/key`)).rejects.toThrow(/E_FS_DENIED/)
    for (const dir of ['.agh']) {
      const full = policy(root, 'c'.repeat(64))
      const missing = Object.freeze({
        ...full,
        rules: Object.freeze(full.rules.filter((rule) => rule.path !== join(root, dir, 'secrets'))),
      })
      expect(() => fence.bind(missing), dir).toThrow(/omits the host integrity floor/)
    }
    await fence.close()
    await handle.close()
  })

  it('gives each local session an independent fs and exec gate', async () => {
    const rootA = await realpath(await mkdtemp(join(tmpdir(), 'agnes-ws-a-')))
    const rootB = await realpath(await mkdtemp(join(tmpdir(), 'agnes-ws-b-')))
    roots.push(rootA, rootB)
    const run = vi.fn<ExecAdapter['run']>(async () => ({
      code: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
      timedOut: false,
    }))
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec: { run, killAll: async () => undefined },
    })
    const handleA = await factory.openWorkspace(new CliWorkspaceAuthority(rootA).bind('a'))
    const handleB = await factory.openWorkspace(new CliWorkspaceAuthority(rootB).bind('b'))
    const fenceA = await factory.openFence(handleA)
    const fenceB = await factory.openFence(handleB)
    await fenceA.bind(policy(rootA, 'a'.repeat(64)))
    await fenceB.bind(policy(rootB, 'b'.repeat(64)))
    fenceA.activateGate({ backend: 'none', onUnavailable: 'allow' })
    fenceB.activateGate({ backend: 'none', onUnavailable: 'deny' })

    await expect(
      fenceA.exec(['tool'], {
        cwd: rootA,
        sandbox: { policyDigest: 'a'.repeat(64), backend: 'none' },
      }),
    ).resolves.toMatchObject({ stdout: 'ok' })
    await expect(
      fenceB.exec(['tool'], {
        cwd: rootB,
        sandbox: { policyDigest: 'b'.repeat(64), backend: 'none' },
      }),
    ).rejects.toThrow('SANDBOX_UNAVAILABLE')
    await fenceA.fs.write('window.txt', new TextEncoder().encode('0123456789'))
    await expect(fenceA.fs.read('window.txt', { unit: 'bytes', offset: 2, limit: 3 })).resolves.toEqual(
      new TextEncoder().encode('234'),
    )
    await fenceA.close()
    await expect(fenceA.fs.read('window.txt', { unit: 'bytes', limit: 1 })).rejects.toThrow(
      'E_WORKSPACE_CLOSED',
    )
    await expect(fenceA.fs.read('.')).rejects.toThrow('E_WORKSPACE_CLOSED')
    await expect(fenceB.fs.write('live.txt', new TextEncoder().encode('live'))).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
    await fenceB.close()
    await handleA.close()
    await handleB.close()
  })

  it('leases remote roots per session and releases each owner independently', async () => {
    const released: string[] = []
    const pool = {
      acquire: vi.fn(async (sessionKey: string) => ({
        root: `/remote/${sessionKey}`,
        close: async () => {
          released.push(sessionKey)
        },
      })),
    } as unknown as RemoteWorkspacePool
    const transport = {} as RemoteTransport
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec: { run: vi.fn() as ExecAdapter['run'], killAll: async () => undefined },
      transport,
      remotePool: pool,
    })
    const a = await factory.openWorkspace(new CliWorkspaceAuthority('/source').bind('a'))
    const b = await factory.openWorkspace(new CliWorkspaceAuthority('/source').bind('b'))
    expect([a.root, b.root]).toEqual(['/remote/a', '/remote/b'])
    await a.close()
    expect(released).toEqual(['a'])
    await b.close()
    expect(released).toEqual(['a', 'b'])
  })

  posixIt('applies the read-only roots to a local workspace but never to a remote one', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'agnes-ws-ro-')))
    roots.push(base)
    const work = join(base, 'work')
    const protectedRoot = join(base, 'home', 'profiles')
    mkdirSync(work, { recursive: true })
    mkdirSync(protectedRoot, { recursive: true })
    const target = join(protectedRoot, 'profile.yaml')
    const bytes = new TextEncoder().encode('approvals: off')
    const fullAccess = (fs: object, invoke: () => Promise<void>) =>
      withSessionFileAccess(fs, () => true, invoke)
    const readOnlyRoots = () => [protectedRoot]
    const exec = { run: vi.fn() as ExecAdapter['run'], killAll: async () => undefined }

    // Control: the same roots on a local workspace refuse the write under full access.
    const local = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec,
      fullAccessReadOnlyRoots: readOnlyRoots,
    })
    const localHandle = await local.openWorkspace(new CliWorkspaceAuthority(work).bind('local'))
    const localFence = await local.openFence(localHandle)
    await fullAccess(localFence.fs, async () => {
      await expect(localFence.fs.write(target, bytes)).rejects.toThrow(/denied by policy/)
    })
    await localFence.close()
    await localHandle.close()

    // A remote workspace is a different machine's disk: this machine's state paths mean nothing there,
    // so the roots are not applied and the write goes through to the remote io.
    const pool = {
      acquire: async () => ({ root: work, close: async () => undefined }),
    } as unknown as RemoteWorkspacePool
    const remote = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec,
      transport: createLoopbackTransport({ root: base }),
      remotePool: pool,
      fullAccessReadOnlyRoots: readOnlyRoots,
    })
    const remoteHandle = await remote.openWorkspace(new CliWorkspaceAuthority(work).bind('remote'))
    expect(remoteHandle.kind).toBe('remote')
    const remoteFence = await remote.openFence(remoteHandle)
    await fullAccess(remoteFence.fs, async () => {
      await remoteFence.fs.write(target, bytes)
    })
    expect(await readFile(target, 'utf8')).toBe('approvals: off')
    await remoteFence.close()
    await remoteHandle.close()
  })
})
