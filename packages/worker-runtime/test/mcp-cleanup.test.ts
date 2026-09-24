import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { LocalGate } from '@agnes/plugin-runtime/host'
import { rpcError } from '@agnes/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  managerClose: vi.fn(async () => undefined),
  hostClose: vi.fn(async () => undefined),
  sessionClose: vi.fn(async () => undefined),
  createHost: vi.fn(),
  bootstrap: vi.fn(),
  isServicePreDispatchFailure: vi.fn((_error: unknown) => false),
}))
vi.mock('@agnes/resource-control-worker', async () => ({
  ...(await vi.importActual<typeof import('@agnes/resource-control-worker')>(
    '@agnes/resource-control-worker',
  )),
  bootstrapWorkerResources: mocks.bootstrap,
}))
vi.mock('@agnes/host', async () => ({
  ...(await vi.importActual<typeof import('@agnes/host')>('@agnes/host')),
  createHost: mocks.createHost,
  isServicePreDispatchFailure: mocks.isServicePreDispatchFailure,
}))
vi.mock('../src/tail.js', () => ({ tailSession: vi.fn() }))

import { runWorker } from '../src/main.js'

const roots: string[] = []
const links: Duplex[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.managerClose.mockResolvedValue(undefined)
  mocks.hostClose.mockResolvedValue(undefined)
  mocks.sessionClose.mockResolvedValue(undefined)
  mocks.isServicePreDispatchFailure.mockReturnValue(false)
  mocks.bootstrap.mockResolvedValue({
    skillResources: { list: () => [] },
    mcpResources: { list: () => [] },
    skills: [],
    mcp: [],
    revision: 'a'.repeat(64),
    discovery: { candidates: [], failedRoots: [], roots: [] },
    runtime: { mcp: { close: mocks.managerClose } },
    reportMcpStatus: vi.fn(),
  })
})
afterEach(async () => {
  // Remove worker shutdown callbacks before restoring process.exit, even if an assertion failed.
  for (const link of links.splice(0)) {
    link.removeAllListeners()
    link.destroy()
  }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function fixture(kind = 'session') {
  const root = await mkdtemp(join(tmpdir(), 'mcc-'))
  roots.push(root)
  const profile = join(root, 'profile.json')
  await writeFile(
    profile,
    JSON.stringify({
      name: 'local-dev',
      dataDir: root,
      cacheDir: root,
      packages: [],
      adapters: { secrets: { kind: 'env' } },
      hash: `sha256-${'0'.repeat(64)}`,
    }),
  )
  const sent: string[] = []
  const link = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      sent.push(Buffer.from(chunk).toString('utf8'))
      callback()
    },
  })
  links.push(link)
  return {
    link,
    env: {
      AGNES_WORKER_TOKEN: 'tok',
      AGNES_SUPERVISOR_SOCKET: '/tmp/mcc.sock',
      AGNES_WORKER_KEY: '@shared',
      AGNES_PROFILE_FILE: profile,
      AGNES_WORKER_GENERATION: '1',
      AGNES_WORKER_ROOT: root,
      AGH_HOME: root,
      HOME: root,
      AGNES_WORKER_KIND: kind,
    },
    io: { connect: async () => link, gate: null },
    sent,
  }
}

it.each(['custom', 'default'])(
  'retires the bootstrapped MCP generation when %s Host assembly fails',
  async (kind) => {
    const f = await fixture()
    const failure = new Error('host assembly rejected')
    mocks.createHost.mockRejectedValue(failure)
    await expect(
      runWorker(
        f.env,
        f.io,
        kind === 'custom'
          ? {
              buildHost: async () => {
                throw failure
              },
            }
          : {},
      ),
    ).rejects.toBe(failure)
    expect(mocks.managerClose).toHaveBeenCalledExactlyOnceWith()
    expect(f.link.destroyed).toBe(true)
  },
)

it('does not pin a shared session worker runtime to AGNES_WORKER_ROOT', async () => {
  const f = await fixture('session')
  const failure = new Error('stop after assembly capture')
  mocks.createHost.mockRejectedValue(failure)

  await expect(runWorker(f.env, f.io)).rejects.toBe(failure)

  expect(f.env.AGNES_WORKER_ROOT).not.toBe(process.cwd())
  expect(mocks.bootstrap.mock.calls[0]?.[0]).not.toHaveProperty('cwd')
  expect(mocks.createHost.mock.calls[0]?.[1]).toMatchObject({ workspaceRoot: f.env.AGH_HOME })
})

// The profile's dataDir (the fixture root) is deliberately a different directory from the home, so
// a profileDir derived from dataDir instead of agnesHome(env) cannot pass by coincidence.
it.each([
  { source: 'AGH_HOME', env: (home: string) => ({ AGH_HOME: home }), root: (home: string) => home },
  {
    source: 'legacy AGNES_HOME',
    env: (home: string) => ({ AGNES_HOME: home }),
    root: (home: string) => home,
  },
  {
    source: 'HOME default',
    env: (home: string) => ({ HOME: home }),
    root: (home: string) => join(home, '.agh'),
  },
])('derives the Host profileDir from agnesHome(env) via $source', async ({ env, root }) => {
  const f = await fixture('session')
  const home = await mkdtemp(join(tmpdir(), 'mcc-home-'))
  roots.push(home)
  const { AGH_HOME: _fixtureHome, ...base } = f.env
  const failure = new Error('stop after assembly capture')
  mocks.createHost.mockRejectedValue(failure)

  await expect(runWorker({ ...base, ...env(home) }, f.io)).rejects.toBe(failure)

  expect(mocks.createHost.mock.calls[0]?.[1]).toMatchObject({
    profileDir: join(root(home), 'profiles', 'local-dev'),
  })
})

it('preserves generic Service pre-dispatch failures across the shared session worker wire', async () => {
  const f = await fixture('session')
  const failure = rpcError('INTERNAL_ERROR', { code: 'E_WORKSPACE_REQUIRED' })
  mocks.isServicePreDispatchFailure.mockImplementation((error: unknown) => error === failure)
  mocks.createHost.mockResolvedValue({
    close: mocks.hostClose,
    callService: vi.fn(async () => {
      throw failure
    }),
    inspectService: vi.fn(),
    createSession: vi.fn(),
    acceptWorkspaceBinding: vi.fn(),
  })
  await runWorker(f.env, f.io)
  f.sent.length = 0

  f.link.push(
    Buffer.from(
      `${JSON.stringify({
        kind: 'command',
        requestId: 'service-closed',
        method: 'callService',
        params: {
          callId: 'service-call',
          sessionKey: 'session-closed',
          call: {
            sessionId: 'session-closed',
            extension: 'agnes/reports',
            service: 'sales.create',
            input: {},
          },
          credential: {},
        },
      })}\n`,
    ),
  )

  await expect.poll(() => f.sent.join('')).toContain('"_servicePhase":"pre-dispatch"')
  const reply = JSON.parse(f.sent.join('').trim()) as {
    error?: { data?: Record<string, unknown> }
  }
  expect(reply.error?.data).toMatchObject({
    code: 'E_WORKSPACE_REQUIRED',
    _servicePhase: 'pre-dispatch',
  })
})

it('keeps Host and MCP alive when a session.open creation fails', async () => {
  const f = await fixture()
  const failure = new Error('session rejected')
  const createSession = vi.fn(async () => {
    throw failure
  })
  mocks.createHost.mockResolvedValue({
    close: mocks.hostClose,
    acceptWorkspaceBinding: (envelope: unknown) => envelope,
    createSession,
  })
  await runWorker(f.env, f.io)
  expect(createSession).not.toHaveBeenCalled()

  f.link.push(
    Buffer.from(
      `${JSON.stringify({
        kind: 'session.open',
        requestId: 'open:session',
        sessionKey: 'session',
        params: {
          binding: {
            version: 1,
            sessionKey: 'session',
            workspaceId: 'a'.repeat(64),
            revision: 1,
            canonicalRoot: f.env.AGNES_WORKER_ROOT,
          },
        },
      })}\n`,
    ),
  )
  await vi.waitFor(() => expect(createSession).toHaveBeenCalledExactlyOnceWith(expect.anything()))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mocks.hostClose).not.toHaveBeenCalled()
  expect(mocks.managerClose).not.toHaveBeenCalled()
  expect(mocks.sessionClose).not.toHaveBeenCalled()
  expect(f.link.destroyed).toBe(false)
})

it('admits every worker request branch through the one process-local gate', async () => {
  const f = await fixture()
  const enterRead = vi.spyOn(LocalGate.prototype, 'enterRead')
  const kernelSessions = new Map<string, unknown>()
  mocks.createHost.mockResolvedValue({
    close: mocks.hostClose,
    acceptWorkspaceBinding: (envelope: unknown) => envelope,
    kernel: { sessions: kernelSessions },
    createSession: vi.fn(async ({ key }: { key: string }) => {
      const session = {
        key,
        writerRunId: `writer:${key}`,
        lastSeq: 0,
        preset: { name: 'default' },
        d: { log: {} },
        latest: () => null,
        close: mocks.sessionClose,
      }
      kernelSessions.set(key, session)
      return session
    }),
  })
  await runWorker(f.env, f.io)
  f.sent.length = 0

  f.link.push(
    Buffer.from(
      `${JSON.stringify({ kind: 'command', requestId: 'worker-ping', method: 'ping', params: {} })}\n${JSON.stringify(
        {
          kind: 'session.open',
          requestId: 'session-open',
          sessionKey: 'session',
          params: {
            binding: {
              version: 1,
              sessionKey: 'session',
              workspaceId: 'a'.repeat(64),
              revision: 1,
              canonicalRoot: f.env.AGNES_WORKER_ROOT,
            },
          },
        },
      )}\n`,
    ),
  )
  await expect.poll(() => f.sent.join('')).toContain('"requestId":"session-open"')

  f.link.push(
    Buffer.from(
      `${JSON.stringify({
        kind: 'command',
        requestId: 'session-ping',
        sessionKey: 'session',
        method: 'ping',
        params: {},
      })}\n${JSON.stringify({
        kind: 'session.tail',
        requestId: 'session-tail',
        sessionKey: 'session',
        fromSeq: 0,
      })}\n${JSON.stringify({
        kind: 'session.close',
        requestId: 'session-close',
        sessionKey: 'session',
        reason: 'test',
      })}\n`,
    ),
  )
  await expect.poll(() => f.sent.join('')).toContain('"requestId":"session-close"')

  expect(enterRead).toHaveBeenCalledTimes(5)
})

it.each(['session', 'service'])(
  'retires MCP exactly once on repeated close frames for a %s worker',
  async (kind) => {
    const f = await fixture(kind)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mocks.createHost.mockResolvedValue({
      close: mocks.hostClose,
      createSession: async () => ({
        close: mocks.sessionClose,
        key: 'session',
        writerRunId: 'writer',
      }),
    })
    await runWorker({ ...f.env, ...(kind === 'service' ? { AGNES_RESOURCE_CONTROL: '1' } : {}) }, f.io)
    f.link.push(Buffer.from('{"kind":"close","reason":"test"}\n{"kind":"close","reason":"repeat"}\n'))
    await expect.poll(() => exit.mock.calls.length).toBe(1)
    expect(mocks.managerClose).toHaveBeenCalledExactlyOnceWith()
    expect(f.link.destroyed).toBe(true)
    expect(mocks.sessionClose).not.toHaveBeenCalled()
  },
)

it('rejects a Host-bearing service worker before connecting to the supervisor', async () => {
  const f = await fixture('service')
  await expect(runWorker(f.env, f.io)).rejects.toThrow(
    'service workers are reserved for resource-control helpers',
  )
})

it('preserves the assembly error even when MCP cleanup also rejects', async () => {
  const f = await fixture()
  const failure = new Error('original assembly error')
  mocks.managerClose.mockRejectedValueOnce(new Error('cleanup failed'))
  await expect(
    runWorker(f.env, f.io, {
      buildHost: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  expect(mocks.managerClose).toHaveBeenCalledExactlyOnceWith()
  expect(f.link.destroyed).toBe(true)
})

it('does not repeat cleanup or exit successfully when publishing hello fails after listeners were installed', async () => {
  const f = await fixture()
  const failure = new Error('hello write failed')
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(f.link, 'write').mockImplementationOnce(() => {
    throw failure
  })
  mocks.createHost.mockResolvedValue({
    close: mocks.hostClose,
    createSession: async () => ({
      close: mocks.sessionClose,
      key: 'session',
      writerRunId: 'writer',
    }),
  })
  await expect(runWorker(f.env, f.io)).rejects.toBe(failure)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mocks.managerClose).toHaveBeenCalledExactlyOnceWith()
  expect(mocks.hostClose).toHaveBeenCalledExactlyOnceWith()
  expect(mocks.sessionClose).not.toHaveBeenCalled()
  expect(exit).not.toHaveBeenCalled()
  expect(f.link.destroyed).toBe(true)
})
