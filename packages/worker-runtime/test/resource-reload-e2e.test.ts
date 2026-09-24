import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { mcpLocalToolPrefix } from '@agnes/base'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandFrame, ReplyFrame } from '../src/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/framing.js'
import { runWorker } from '../src/main.js'

// End-to-end resource reload integration test. Every earlier task-level test either (a) drives handleCommand directly with a hand-built ctx
// (resource-reload.test.ts) or (b) drives the real dispatch()/runWorker() wire loop but against a
// minimal call-recording fake Host (resource-reload-dispatch.test.ts) that only proves
// reloadEcosystemExtension was *called* with the right ids/fields, not that a model would actually see
// a different tool set. This file closes that last gap: real dispatch(), a real assembled Host (this
// package's own `@agnes/host/testkit` createTestHost, loading @agnes/base's actual bundled extensions
// off disk, exactly as packages/host/test/assemble/reload-ecosystem-extension.test.ts does), with the
// MCP servers mounted as the session worker's own Host rows, and the assertion is against that Host's
// live `kernel.tools.resolve(...)` - the same registry a real turn's tool-call step reads.
//
// Boundary this test deliberately stays below: it never touches packages/daemon's supervisor/
// WorkerPool/registry - only worker-runtime's own runWorker() entry point, exactly the granularity
// resource-reload-dispatch.test.ts already established. This is not scope-avoidance: Task 5 found and
// documented (task-5-report.md, "未关闭边界" #1) that packages/daemon/src/supervisor/registry.ts's
// pre-existing retireForResourceSnapshot() is wired to the SAME setSuccessfulSnapshotHandler hook as
// this plan's new notifyLiveSessionWorkers(), and for an idle session it retires (kills and forces a
// respawn of) the worker synchronously, before the lightweight resource.stale/next-run path this task
// verifies ever gets a chance to run - and for a busy session, it races the exact same turn-boundary
// this task's reload check uses. Driving this test through a real spawned daemon (startSupervisor +
// WorkerPool, as packages/daemon/test/supervisor-e2e.test.ts does for a real worker.pid) would make the
// test's own pass/fail depend on winning that race, which is tracked as its own separate, not-yet-fixed
// follow-up (narrowing retireForResourceSnapshot to only affected sessions) - not something Task 6 is
// scoped to fix or paper over. Testing at worker-runtime's own boundary, one layer below the daemon's
// registry, proves the mechanism this plan actually built without being defeated by a known, separately
// tracked race in a mechanism this plan does not own.
//
// "No restart" at this granularity: runWorker() IS the worker process's entire lifetime in production
// (packages/daemon/src/supervisor/worker-pool.ts spawns exactly one OS process per worker and that
// process's whole job is one runWorker() call - see main.ts's own bottom self-starting block). A
// restart is by construction a second, fresh runWorker() invocation with a brand-new Host. This test
// calls runWorker() exactly once and asserts buildHost (this test's Host constructor, standing in for
// deps.buildHost) was invoked exactly once throughout both turns - the direct, in-process analogue of
// "the pid never changed": if the reload mechanism secretly worked by tearing down and rebuilding the
// worker's Host instead of reloading it in place, this counter would show 2, not 1.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

// The real @agnes/base package directory, so createTestHost loads the real bundled agnes/mcp-search/
// agnes/skills extensions off disk - same technique as reload-ecosystem-extension.test.ts.
const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
// The prefix is register.ts's tool naming for that server id, computed via the shared function
// rather than hardcoded (design 2026-09-23-mcp-tool-name-collision-design.md §0.4).
const A_PREFIX = mcpLocalToolPrefix('a')
const B_PREFIX = mcpLocalToolPrefix('b')

// A real spy wrapping the real implementation (not a replacement), same technique and same purpose as
// resource-reload-dispatch.test.ts: counting bootstrapWorkerResources() calls is a second, independent
// signal (besides tool visibility) that the resource generation was genuinely re-read, not silently
// skipped or faked.
const counters = vi.hoisted(() => ({ bootstrapCalls: 0 }))
vi.mock('@agnes/resource-control-worker', async () => {
  const actual = await vi.importActual<typeof import('@agnes/resource-control-worker')>(
    '@agnes/resource-control-worker',
  )
  return {
    ...actual,
    bootstrapWorkerResources: (async (input: Parameters<typeof actual.bootstrapWorkerResources>[0]) => {
      counters.bootstrapCalls++
      return actual.bootstrapWorkerResources(input)
    }) as typeof actual.bootstrapWorkerResources,
  }
})
// tailSession would otherwise poll a real session's ledger every 25ms for the lifetime of the test
// process (this test never sends a 'close' frame - see fakeLink()'s comment for why not) - irrelevant
// to what this test asserts (Host's live tool registry, not the event stream) and would leave a
// dangling interval after the test ends.
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
  counters.bootstrapCalls = 0
  if (errors.length) throw new AggregateError(errors, 'resource-reload-e2e fixture cleanup failed')
})

async function mcpFixture(serverId: string, toolName: string): Promise<string> {
  const tools = [
    {
      name: toolName,
      description: `resource-reload-e2e fixture tool for server ${serverId}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
  const server = createServer((req, res) => {
    void (async () => {
      const mcp = new Server(
        { name: `resource-reload-e2e-${serverId}`, version: '1' },
        { capabilities: { tools: {} } },
      )
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      await mcp.close().catch(() => undefined)
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture address')
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
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

/** Same fake-Duplex supervisor stand-in as resource-reload-dispatch.test.ts: writes from the worker
 *  decode back into frame objects (to wait for a specific reply), `push` injects frames the other way. */
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
  const canonicalRoot = await realpath(cwd)
  link.push(
    encodeFrame({
      kind: 'session.open',
      requestId: 'open:session',
      sessionKey: 'session',
      params: {
        binding: {
          version: 1,
          sessionKey: 'session',
          workspaceId: createHash('sha256').update(canonicalRoot).digest('hex'),
          revision: 1,
          canonicalRoot,
        },
      },
    }),
  )
  const reply = await waitForReply(fromWorker, 'open:session')
  expect(reply).toMatchObject({ kind: 'reply', requestId: 'open:session', sessionKey: 'session' })
  expect(reply.error).toBeUndefined()
}

describe('worker-runtime end-to-end: a newly enabled MCP server becomes visible on the next turn, same worker process', () => {
  it('is visible on the next run and NOT mid-turn, without ever rebuilding the Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wre2e-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('a', 'toolA')
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

    let buildHostCalls = 0
    let capturedHost: Host | undefined
    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      // Removing the listeners runWorker() itself registered BEFORE destroy() is load-bearing: destroy()
      // emits 'close', and runWorker()'s own `link.on('close', () => void shutdown(0))` calls
      // process.exit() - which would kill the whole vitest worker process, not just this test. See
      // resource-reload-dispatch.test.ts's identical cleanup for the same reason.
      link.removeAllListeners()
      link.destroy()
    })

    // This is the real production entry point (runWorker -> dispatch), talking to a real, fully
    // assembled Host (createTestHost, loading @agnes/base's real bundled extensions off disk) - not a
    // hand-built handleCommand context and not a call-recording fake Host. `resources` is what the
    // worker hands its Host (the Skill resources); the MCP servers arrive as the worker's own rows.
    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wre2e.sock',
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
      {
        buildHost: async (_profile, _prompter, resources) => {
          buildHostCalls++
          const { host } = await createTestHost({
            dataDir: root,
            disableSessionTitle: true,
            packageDirs: { '@agnes/base': baseDir },
            ...resources,
          })
          capturedHost = host
          return host
        },
      },
    )
    await openSession(link, fromWorker, root)
    cleanup.push(async () => {
      await capturedHost?.close()
    })

    const host = capturedHost
    if (!host) throw new Error('buildHost was never called')
    expect(buildHostCalls).toBe(1)
    expect(counters.bootstrapCalls).toBe(1) // startup only, server A alone

    // Startup state: only server A's tool is registered.
    expect(host.kernel.tools.resolve(`${A_PREFIX}toolA`)).toMatchObject({ name: `${A_PREFIX}toolA` })
    expect(host.kernel.tools.resolve(`${B_PREFIX}toolB`)).toBeUndefined()

    // Turn 1: nothing is enqueued, so this run resolves via core's 'idle' path (session.ts: "no open
    // turn and nothing queued to open one") - it still exercises the real 'run' command dispatch path,
    // which is what matters here (whether a reload is attempted), not model behavior.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'run-1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'turn-1', until: 'turn-end' },
      } as CommandFrame),
    )
    const run1Reply = await waitForReply(fromWorker, 'run-1')
    expect(run1Reply.error).toBeUndefined()
    expect(host.kernel.tools.resolve(`${A_PREFIX}toolA`)).toBeDefined()
    expect(host.kernel.tools.resolve(`${B_PREFIX}toolB`)).toBeUndefined()
    expect(counters.bootstrapCalls).toBe(1) // an idle run with no staleness never reloads

    // The daemon's side of a real enable, written to disk BEFORE resource.stale is sent - so the
    // assertion right below is a genuine content-based check of "not read yet", not an accident of
    // timing.
    const urlB = await mcpFixture('b', 'toolB')
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
      encodeFrame({
        kind: 'command',
        requestId: 'stale-1',
        method: 'resource.stale',
        params: {},
      } as CommandFrame),
    )
    const staleReply = await waitForReply(fromWorker, 'stale-1')
    expect(staleReply.error).toBeUndefined()
    // This is the assertion this task's M3 reverse mutation targets (brief Step 3): resource.stale must
    // only mark staleness, never reload on the spot - even though the snapshot on disk already names
    // server B by this point, the currently-running turn's view of the tool registry must be completely
    // unaffected (G2). If commands.ts's `case 'resource.stale':` reloaded immediately instead of only
    // bumping `o.resources.staleMarks`, server B's tool would already be registered here.
    expect(host.kernel.tools.resolve(`${B_PREFIX}toolB`)).toBeUndefined()
    expect(host.kernel.tools.resolve(`${A_PREFIX}toolA`)).toBeDefined()
    expect(counters.bootstrapCalls).toBe(1) // marking stale is free - still no re-bootstrap

    // Turn 2: the run that consumes the staleness mark. The reload happens at the top of this dispatch,
    // strictly before session.run() is called (commands.ts's `case 'run':`), so by the time this reply
    // arrives the Host's tool registry already reflects server A+B.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'run-2',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'turn-2', until: 'turn-end' },
      } as CommandFrame),
    )
    const run2Reply = await waitForReply(fromWorker, 'run-2')
    expect(run2Reply.error).toBeUndefined()
    await vi.waitFor(
      () => {
        expect(host.kernel.tools.resolve(`${A_PREFIX}toolA`)).toMatchObject({ name: `${A_PREFIX}toolA` })
        expect(host.kernel.tools.resolve(`${B_PREFIX}toolB`)).toMatchObject({ name: `${B_PREFIX}toolB` })
      },
      { timeout: 10_000, interval: 50 },
    )
    expect(counters.bootstrapCalls).toBe(2) // one reload, triggered by this run

    // The whole point: one Host, one runWorker() call, from startup through both turns. Nothing here
    // rebuilt the worker - "same worker process's next turn" is directly falsifiable by this counter,
    // not just an assumption from the test's own shape.
    expect(buildHostCalls).toBe(1)
    expect(capturedHost).toBe(host)
    // Inner waitFor allows 10s; default 5s it() timeout cannot cover a contended full-suite worker.
  }, 30_000)

  it('an edited server swaps only its own row, a removed server unmounts alone, and no other extension reloads', async () => {
    // The stage 2b goal, end to end: "MCP 更新一行 cordis, 不整树重建". Real runWorker, real Host,
    // real HTTP MCP servers, an open session. Each fixture counts tools/list requests: every
    // connection lists once when it lands, so a reconnect shows up as a second list.
    const lists = new Map<string, number>()
    const countingFixture = async (serverId: string, toolNames: readonly string[]): Promise<string> => {
      const tools = toolNames.map((name) => ({
        name,
        description: `${serverId} ${name}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }))
      const server = createServer((req, res) => {
        void (async () => {
          const mcp = new Server({ name: `rows-${serverId}`, version: '1' }, { capabilities: { tools: {} } })
          mcp.setRequestHandler(ListToolsRequestSchema, async () => {
            lists.set(serverId, (lists.get(serverId) ?? 0) + 1)
            return { tools }
          })
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          })
          await mcp.connect(transport)
          await transport.handleRequest(req, res)
          await mcp.close().catch(() => undefined)
        })()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing fixture address')
      cleanup.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      )
      return `http://127.0.0.1:${address.port}/mcp`
    }
    const entry = (serverId: string, url: string, allow: string, revision: string) => ({
      definition: {
        serverId,
        displayName: serverId,
        transport: { kind: 'http', url },
        secretBinding: { kind: 'none' },
        toolPolicy: { allow: [allow] },
      },
      revision,
      desired: 'enabled',
      trust: 'trusted',
    })
    const snapshot = (mcp: unknown[]) =>
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: { desired: [], trust: [] } },
        mcp,
      })

    const root = await mkdtemp(join(tmpdir(), 'wre2e-rows-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await countingFixture('a', ['toolA', 'toolA2'])
    const urlB = await countingFixture('b', ['toolB'])
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      snapshot([entry('a', urlA, 'toolA', 'a'.repeat(64)), entry('b', urlB, 'toolB', 'b'.repeat(64))]),
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
    let testHost: Awaited<ReturnType<typeof createTestHost>> | undefined
    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })
    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wre2e-rows.sock',
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
      {
        buildHost: async (_profile, _prompter, resources) => {
          testHost = await createTestHost({
            dataDir: root,
            disableSessionTitle: true,
            packageDirs: { '@agnes/base': baseDir },
            ...resources,
          })
          return testHost.host
        },
      },
    )
    await openSession(link, fromWorker, root)
    const h = testHost
    if (!h) throw new Error('buildHost was never called')
    cleanup.push(() => h.host.close())
    const tools = (name: string) => h.host.kernel.tools.resolve(name)
    await vi.waitFor(
      () => {
        expect(tools(`${A_PREFIX}toolA`)).toBeDefined()
        expect(tools(`${B_PREFIX}toolB`)).toBeDefined()
      },
      { timeout: 10_000, interval: 50 },
    )
    expect(lists).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    )
    // Turn-boundary reload, exactly as production: resource.stale, then the next run reloads.
    let turn = 0
    const reloadOnNextRun = async () => {
      turn++
      link.push(
        encodeFrame({ kind: 'command', requestId: `stale-${turn}`, method: 'resource.stale', params: {} }),
      )
      await waitForReply(fromWorker, `stale-${turn}`)
      link.push(
        encodeFrame({
          kind: 'command',
          requestId: `run-${turn}`,
          sessionKey: 'session',
          method: 'run',
          params: { runId: `turn-${turn}`, until: 'turn-end' },
        } as CommandFrame),
      )
      expect((await waitForReply(fromWorker, `run-${turn}`)).error).toBeUndefined()
    }
    const extensionEvents = (from: number) =>
      h.audit.events
        .slice(from)
        .filter((event) => event.kind.startsWith('extension.'))
        .map((event) => `${event.kind} ${(event.detail as { id?: string }).id}`)

    // 1. Edit server A (new revision, different allowed tool): only A's row is swapped.
    let mark = h.audit.events.length
    await writeFile(
      snapshotPath,
      snapshot([entry('a', urlA, 'toolA2', 'c'.repeat(64)), entry('b', urlB, 'toolB', 'b'.repeat(64))]),
    )
    await reloadOnNextRun()
    await vi.waitFor(() => expect(tools(`${A_PREFIX}toolA2`)).toBeDefined(), {
      timeout: 10_000,
      interval: 50,
    })
    expect(tools(`${A_PREFIX}toolA`)).toBeUndefined()
    expect(tools(`${B_PREFIX}toolB`)).toBeDefined()
    expect(lists).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    // An MCP-only edit leaves the Skills row and every other extension mounted.
    const editEvents = extensionEvents(mark)
    expect(editEvents).toHaveLength(2)
    expect(editEvents[0]).toMatch(/^extension\.revoked agnes\/mcp-a-[0-9a-f]{8}$/)
    expect(editEvents[1]).toMatch(/^extension\.loaded agnes\/mcp-a-[0-9a-f]{8}$/)

    // 2. Remove server B: only B's row unmounts; A is not reconnected.
    mark = h.audit.events.length
    await writeFile(snapshotPath, snapshot([entry('a', urlA, 'toolA2', 'c'.repeat(64))]))
    await reloadOnNextRun()
    await vi.waitFor(() => expect(tools(`${B_PREFIX}toolB`)).toBeUndefined(), {
      timeout: 10_000,
      interval: 50,
    })
    expect(tools(`${A_PREFIX}toolA2`)).toBeDefined()
    expect(lists).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    const removeEvents = extensionEvents(mark)
    expect(removeEvents).toHaveLength(1)
    expect(removeEvents[0]).toMatch(/^extension\.revoked agnes\/mcp-b-[0-9a-f]{8}$/)
  }, 60_000)
})
