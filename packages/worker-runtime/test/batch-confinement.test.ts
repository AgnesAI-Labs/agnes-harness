import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { Host, HostSession } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertBatchItemConfinement, batchItemConfinementLive } from '../src/batch-confinement.js'
import { handleServiceCommand } from '../src/commands.js'
import type { SessionCommandFrame, SessionOpenFrame } from '../src/frames.js'
import { HostedSessions } from '../src/hosted-sessions.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const ITEM = 'agnes:local:local-dev:batch:b0123456789ab:1'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function baseHost(withHook: boolean): Promise<Host> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-batch-confinement-'))
  dirs.push(dataDir)
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    disableSessionTitle: true,
    ...(withHook
      ? {}
      : {
          packages: {
            '@agnes/base': {
              ecosystem: {
                ...baseEcosystem,
                // The batch tools without the item-session hook.
                'agnes/batch': (init) => (api) =>
                  baseEcosystem['agnes/batch'](init)(
                    Object.create(api, { registerHook: { value: () => () => undefined } }),
                  ),
              },
            },
          },
        }),
  })
  return host
}

const confinement = (host: Host | undefined) =>
  handleServiceCommand(
    host,
    { kind: 'command', requestId: 'c', method: 'batch.confinement', params: {} },
    new Map(),
  )

describe('batch item confinement in the worker Host', () => {
  it('is live in a Host that loaded the built-in batch extension', async () => {
    const host = await baseHost(true)
    try {
      const entries = host.kernel.hooks.snapshot().entries('tool_call')
      expect(entries.find((entry) => entry.meta.source === 'agnes/batch')?.meta.trust).toBe('builtin')
      expect(batchItemConfinementLive(host)).toBe(true)
      await expect(confinement(host)).resolves.toEqual({ ready: true })
      expect(() => assertBatchItemConfinement(host, ITEM)).not.toThrow()
    } finally {
      await host.close()
    }
  })

  it('is not live when the batch extension registers no tool_call hook, nor in a Host-free worker', async () => {
    const host = await baseHost(false)
    try {
      // The tools are there; only the hook is missing.
      expect(host.kernel.tools.resolve('batch_start')?.name).toBe('batch_start')
      expect(batchItemConfinementLive(host)).toBe(false)
      await expect(confinement(host)).resolves.toEqual({ ready: false })
      expect(() => assertBatchItemConfinement(host, ITEM)).toThrow(/not active/)
      // Ordinary sessions are not held to it.
      expect(() => assertBatchItemConfinement(host, 'agnes:local:local-dev:cli:x')).not.toThrow()
    } finally {
      await host.close()
    }
    await expect(confinement(undefined)).resolves.toEqual({ ready: false })
  })

  it('counts only the built-in registration, and reads a failing registry as not live', () => {
    const hostWith = (entries: () => unknown[]) =>
      ({ kernel: { hooks: { snapshot: () => ({ entries }) } } }) as unknown as Host
    expect(
      batchItemConfinementLive(hostWith(() => [{ meta: { source: 'agnes/batch', trust: 'trusted' } }])),
    ).toBe(false)
    expect(
      batchItemConfinementLive(hostWith(() => [{ meta: { source: 'agnes/other', trust: 'builtin' } }])),
    ).toBe(false)
    expect(
      batchItemConfinementLive(
        hostWith(() => {
          throw new Error('registry gone')
        }),
      ),
    ).toBe(false)
  })
})

describe('HostedSessions and batch item sessions', () => {
  function fixture() {
    let live = true
    const createSession = vi.fn(async ({ key }: { key: string }) => {
      return {
        key,
        writerRunId: `writer:${key}`,
        lastSeq: 0,
        preset: { name: 'default' },
        d: { log: {}, workspaceIdentity: undefined },
        latest: () => null,
        async run() {
          return { reason: 'idle', lastSeq: 0 }
        },
        async enqueue() {
          return 1
        },
        async close() {},
      } as unknown as HostSession
    })
    const host = {
      acceptWorkspaceBinding: (envelope: unknown) => envelope as never,
      createSession,
      kernel: {
        sessions: new Map(),
        hooks: {
          snapshot: () => ({
            entries: () => (live ? [{ meta: { source: 'agnes/batch', trust: 'builtin' } }] : []),
          }),
        },
      },
    } as unknown as Host
    const hosted = new HostedSessions({
      host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: '/workspace',
    })
    const open = (sessionKey: string): SessionOpenFrame => ({
      kind: 'session.open',
      requestId: `open:${sessionKey}`,
      sessionKey,
      params: {
        binding: {
          version: 1,
          sessionKey,
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: '/workspace',
        },
      },
    })
    const command = (sessionKey: string, method: SessionCommandFrame['method']): SessionCommandFrame => ({
      kind: 'command',
      requestId: `${sessionKey}:${method}`,
      sessionKey,
      method,
      params: {},
    })
    return {
      hosted,
      createSession,
      open,
      command,
      setLive: (value: boolean) => {
        live = value
      },
    }
  }

  it('refuses to open an item session while the hook is not live, and opens it once it is', async () => {
    const f = fixture()
    f.setLive(false)
    await expect(f.hosted.open(f.open(ITEM))).rejects.toThrow(/not active/)
    expect(f.createSession).not.toHaveBeenCalled()
    // An ordinary session opens as before.
    await expect(f.hosted.open(f.open('agnes:local:local-dev:cli:x'))).resolves.toMatchObject({
      sessionKey: 'agnes:local:local-dev:cli:x',
    })
    f.setLive(true)
    await expect(f.hosted.open(f.open(ITEM))).resolves.toMatchObject({ sessionKey: ITEM })
  })

  it('refuses to start a turn in an open item session once the hook is gone, but still reads and aborts', async () => {
    const f = fixture()
    await f.hosted.open(f.open(ITEM))
    f.setLive(false)
    for (const method of [
      'enqueue',
      'run',
      'resume',
      'sendQueuedNow',
      'append',
      'manualCompact',
      'fork',
      'decideApproval',
    ] as const)
      await expect(f.hosted.dispatch(f.command(ITEM, method))).rejects.toThrow(/not active/)
    await expect(f.hosted.dispatch(f.command(ITEM, 'abort'))).resolves.toBeDefined()
  })
})
