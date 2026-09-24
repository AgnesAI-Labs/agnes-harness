import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import type { Host, HostSession } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandFrame, ReplyFrame } from '../src/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/framing.js'
import { runWorker } from '../src/main.js'

// Same cross-package require trick as resource-reload-dispatch.test.ts: worker-runtime does not
// declare its own dependency on the MCP SDK, so borrow @agnes/base's.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

// Every generation this worker bootstraps, with its real `runtime.mcp.close()` wrapped so the test can
// see whether that generation's live MCP connections (a real HTTP transport here; real child processes
// for a stdio server in production) were ever retired. The implementation itself is the real one - only
// the close call is observed, not replaced.
const tracked = vi.hoisted(() => ({ generations: [] as Array<{ closed: number }> }))
vi.mock('@agnes/resource-control-worker', async () => {
  const actual = await vi.importActual<typeof import('@agnes/resource-control-worker')>(
    '@agnes/resource-control-worker',
  )
  return {
    ...actual,
    bootstrapWorkerResources: (async (input: Parameters<typeof actual.bootstrapWorkerResources>[0]) => {
      const state = await actual.bootstrapWorkerResources(input)
      if (!state) return state
      const record = { closed: 0 }
      tracked.generations.push(record)
      // The real manager object is frozen (so it can be neither patched in place nor wrapped in a
      // Proxy whose `get` returns a different function - that violates the non-configurable-property
      // invariant and throws). Delegate through a plain stand-in instead: every member is the genuine
      // one, bound to the real manager, and `close` counts the call before performing the real close.
      const realMcp = state.runtime.mcp as { close(): Promise<void> }
      const delegate: Record<string, unknown> = {}
      for (const key of Object.keys(realMcp)) {
        const value = (realMcp as unknown as Record<string, unknown>)[key]
        delegate[key] = typeof value === 'function' ? value.bind(realMcp) : value
      }
      delegate.close = async () => {
        record.closed++
        return realMcp.close()
      }
      return { ...state, runtime: { ...state.runtime, mcp: delegate as typeof state.runtime.mcp } }
    }) as typeof actual.bootstrapWorkerResources,
  }
})
vi.mock('../src/tail.js', () => ({ tailSession: vi.fn() }))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  vi.restoreAllMocks()
  tracked.generations.length = 0
  if (errors.length) throw new AggregateError(errors, 'resource-reload-leak fixture cleanup failed')
})

async function mcpFixture(toolName: string): Promise<string> {
  const mcp = new Server(
    { name: `resource-reload-leak-${toolName}`, version: '1' },
    { capabilities: { tools: {} } },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: 'resource-reload-leak fixture tool',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }))
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await mcp.connect(transport)
  const server = createServer((req, res) => {
    void transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture address')
  cleanup.push(async () => {
    await mcp.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return `http://127.0.0.1:${address.port}/mcp`
}

function snapshotDoc(servers: ReadonlyArray<{ serverId: string; url: string; toolName: string }>): unknown {
  return {
    version: 1,
    mcpAuthority: 'resource-control',
    skills: { control: { desired: [], trust: [] } },
    mcp: servers.map(({ serverId, url, toolName }) => ({
      definition: {
        serverId,
        displayName: serverId,
        transport: { kind: 'http', url },
        secretBinding: { kind: 'none' },
        toolPolicy: { allow: [toolName] },
      },
      revision: 'a'.repeat(64),
      desired: 'enabled',
      trust: 'trusted',
    })),
  }
}

function fakeLink(): { link: Duplex; fromWorker: unknown[] } {
  const fromWorker: unknown[] = []
  const dec = new JsonlDecoder()
  const link = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      for (const frame of dec.feed(chunk as Buffer)) fromWorker.push(frame)
      callback()
    },
  })
  return { link, fromWorker }
}

async function waitForReply(fromWorker: unknown[], requestId: string): Promise<ReplyFrame> {
  return vi.waitFor(
    () => {
      const reply = fromWorker.find(
        (f): f is ReplyFrame =>
          (f as ReplyFrame).kind === 'reply' && (f as ReplyFrame).requestId === requestId,
      )
      if (!reply) throw new Error(`no reply yet for ${requestId}`)
      return reply
    },
    { timeout: 5_000, interval: 10 },
  )
}

async function openSession(link: Duplex, fromWorker: unknown[], cwd: string): Promise<void> {
  await vi.waitFor(() =>
    expect(fromWorker).toContainEqual(expect.objectContaining({ kind: 'hello', workerKey: '@shared' })),
  )
  link.push(
    encodeFrame({
      kind: 'session.open',
      requestId: 'open:session',
      sessionKey: 'session',
      params: {
        binding: {
          version: 1,
          sessionKey: 'session',
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: cwd,
        },
      },
    }),
  )
  const reply = await waitForReply(fromWorker, 'open:session')
  expect(reply).toMatchObject({ kind: 'reply', requestId: 'open:session', sessionKey: 'session' })
  expect(reply.error).toBeUndefined()
}

describe('a reload that fails after its new generation is already bootstrapped', () => {
  it('closes every abandoned generation instead of leaking one more per retried turn', async () => {
    // The failure mode this covers: `bootstrapWorkerResources` succeeds (real MCP connections are now
    // open) and the reload then fails while pushing that generation into Host. Staleness is
    // deliberately NOT cleared on failure - that is the plan's retry semantics - so every subsequent
    // turn bootstraps another generation. Whatever is abandoned on the way out has to be closed here,
    // or a single persistent failure leaks connections (and, for a stdio server, child processes)
    // linearly with the number of turns in the conversation.
    const root = await mkdtemp(join(tmpdir(), 'wrl-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('toolA')
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      JSON.stringify(snapshotDoc([{ serverId: 'a', url: urlA, toolName: 'toolA' }])),
    )
    const profile = join(root, 'profile.json')
    await writeFile(
      profile,
      JSON.stringify({
        name: 'local-dev',
        dataDir: root,
        cacheDir: join(root, 'cache'),
        adapters: { secrets: { kind: 'env' } },
        packages: [],
        hash: `sha256-${'0'.repeat(64)}`,
      }),
    )

    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async () => ({ reason: 'completed' }),
      close: async () => undefined,
    } as unknown as HostSession
    // The MCP rows apply fine, agnes/skills always reports the non-throwing `{ loaded: false }` failure
    // shape managed-host.ts really produces. That ordering is the interesting one: Host has already
    // taken the new snapshot's MCP rows when the reload aborts, which is both the leak and the
    // "partial application" concern.
    const reloadCalls: Array<{ id: string; mcpResources: unknown }> = []
    const rowApplies: string[][] = []
    let liveRows: { id: string }[] = []
    const fakeHost = {
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      extensionRows: {
        current: () => liveRows,
        prepare: ({ extensionId }: { extensionId: string }) => ({ id: `ext:${extensionId}` }),
        apply: async (next: { id: string }[]) => {
          liveRows = next
          rowApplies.push(next.map((row) => row.id))
          return {}
        },
      },
      reloadEcosystemExtension: async (id: string, freshInit: { mcpResources?: unknown }) => {
        reloadCalls.push({ id, mcpResources: freshInit?.mcpResources })
        if (id === 'agnes/skills')
          return {
            id,
            package: '@agnes/base',
            version: '0.0.0',
            trust: 'builtin' as const,
            loaded: false,
            error: new Error('skills fixture failure'),
          }
        return { id, package: '@agnes/base', version: '0.0.0', trust: 'builtin' as const, loaded: true }
      },
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })
    const failures: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      failures.push(args)
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrl.sock',
        AGNES_WORKER_KEY: '@shared',
        AGNES_PROFILE_FILE: profile,
        AGNES_WORKER_GENERATION: '1',
        AGNES_WORKER_ROOT: root,
        AGH_HOME: root,
        HOME: root,
        AGNES_RESOURCE_SNAPSHOT: snapshotPath,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
      },
      { connect: async () => link, gate: null },
      { buildHost: async () => fakeHost },
    )
    await openSession(link, fromWorker, root)
    expect(tracked.generations).toHaveLength(1) // the startup generation, still the live one

    // One resource change, then three ordinary turns: the mark is never cleared, so each turn retries.
    const urlB = await mcpFixture('toolB')
    await writeFile(
      snapshotPath,
      JSON.stringify(
        snapshotDoc([
          { serverId: 'a', url: urlA, toolName: 'toolA' },
          { serverId: 'b', url: urlB, toolName: 'toolB' },
        ]),
      ),
    )
    link.push(
      encodeFrame({ kind: 'command', requestId: 's1', method: 'resource.stale', params: {} } as CommandFrame),
    )
    await waitForReply(fromWorker, 's1')
    for (const turn of [1, 2, 3]) {
      link.push(
        encodeFrame({
          kind: 'command',
          requestId: `r${turn}`,
          sessionKey: 'session',
          method: 'run',
          params: { runId: `run-${turn}`, until: 'turn-end' },
        } as CommandFrame),
      )
      await waitForReply(fromWorker, `r${turn}`)
    }

    // Three retried reloads, three generations bootstrapped and abandoned (the review's own
    // reproduction of this leak reported created=4 abandoned=3 abandonedClosed=0).
    expect(tracked.generations).toHaveLength(4)
    expect(failures).toHaveLength(3)
    const [live, ...abandoned] = tracked.generations
    expect(abandoned.map((generation) => generation.closed)).toEqual([1, 1, 1])
    // The generation this worker is still serving must never be closed by a failed reload - closing it
    // would break the very turn the failed reload was supposed to leave untouched.
    expect(live?.closed).toBe(0)

    // Each failed attempt restores the old MCP rows before the next turn retries.
    expect(reloadCalls.map((call) => call.id)).toEqual(['agnes/skills', 'agnes/skills', 'agnes/skills'])
    expect(rowApplies).toHaveLength(7) // boot, then target and compensation per retried turn
    const [boot, ...retries] = rowApplies
    expect(boot?.filter((id) => id.startsWith('ext:agnes/mcp-'))).toHaveLength(1)
    for (let i = 0; i < retries.length; i += 2) {
      expect(retries[i]?.filter((id) => id.startsWith('ext:agnes/mcp-'))).toHaveLength(2)
      expect(retries[i + 1]).toEqual(boot)
    }
  })
})
