import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsPolicy } from '@agnes/core'
import type { RemoteWorkspacePool } from '@agnes/sandbox-remote'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecAdapter } from '../../src/adapters/exec.js'
import { createPlatform } from '../../src/adapters/platform.js'
import type { RemoteTransport } from '../../src/adapters/remote-transport.js'
import { createSessionWorkspaceAdapterFactory } from '../../src/adapters/session-workspace.js'
import { CliWorkspaceAuthority } from '../../src/workspace-authority.js'

const roots: string[] = []
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
      ...['.agh', '.agnes'].map((name) =>
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
  it('holds both workspace secrets directories in its floor, before and at bind', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-ws-floor-')))
    roots.push(root)
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec: { run: vi.fn<ExecAdapter['run']>(), killAll: async () => undefined },
    })
    const handle = await factory.openWorkspace(new CliWorkspaceAuthority(root).bind('floor'))
    const fence = await factory.openFence(handle)
    // The bootstrap fence is built from the floor alone.
    for (const dir of ['.agh', '.agnes'])
      await expect(fence.fs.read(`${dir}/secrets/key`)).rejects.toThrow(/E_FS_DENIED/)
    for (const dir of ['.agh', '.agnes']) {
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
    await fenceA.close()
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
})
