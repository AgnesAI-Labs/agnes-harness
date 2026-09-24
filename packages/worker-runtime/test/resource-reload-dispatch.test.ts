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

// Same cross-package require trick as resource-reload.test.ts/http-bootstrap.test.ts: worker-runtime
// does not declare its own dependency on the MCP SDK, so borrow @agnes/base's.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

// A real spy wrapping the real implementation, not a replacement: every server this test spins up is
// a genuine fixture MCP server and every snapshot file is genuinely re-read from disk. The only thing
// this intercepts is the call count, which is the one signal a prior review round used to prove the
// production bug (dispatch() never persisting the stale flag across separate command frames) and is
// the signal this test's own reverse mutation targets: 1 call means the reload path exercised at
// commands.ts's `case 'run':` never actually fired for a real two-frame `resource.stale` -> `run`
// sequence driven through the real wire dispatcher, only 2 calls means it did.
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
// tailSession isn't relevant to command dispatch and would otherwise need a session capable of
// scan()/latest() - the same isolation mcp-cleanup.test.ts already uses for the same reason.
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
  if (errors.length) throw new AggregateError(errors, 'resource-reload-dispatch fixture cleanup failed')
})

async function mcpFixture(toolName: string): Promise<string> {
  const mcp = new Server(
    { name: `resource-reload-dispatch-${toolName}`, version: '1' },
    { capabilities: { tools: {} } },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: 'resource-reload-dispatch fixture tool',
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

/** A Duplex standing in for the supervisor connection: writes from the worker are decoded back into
 *  frame objects (so this test can wait for a specific reply), and `push` injects frames the other way,
 *  exactly as `dispatch()`'s own `link.on('data', ...)` handler expects. */
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
    { timeout: 2_000, interval: 10 },
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

/** The session worker mounts the snapshot's MCP servers as Host rows at boot and on every reload
 *  (stage 2b step 3); these tests are about frame ordering, so a Host that accepts any row set does. */
function fakeExtensionRows() {
  let rows: { id: string }[] = []
  return {
    current: () => rows,
    prepare: ({ extensionId }: { extensionId: string }) => ({ id: `ext:${extensionId}` }),
    apply: async (next: { id: string }[]) => {
      rows = next
      return {}
    },
  }
}

describe('real dispatch(): resource.stale and run arrive as two separate frames', () => {
  it('reloads on the run that follows a resource.stale in an earlier, separate dispatch() call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrd-'))
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

    const runCalls: Array<{ until?: string }> = []
    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        return { reason: 'completed' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    // reloadEcosystemExtension is exercised for real now that Task 4 wires the actual host call into
    // reloadWorkerResources - without it, the reload would fail inside its own try/catch (logged, not
    // thrown) and this test's bootstrapCalls signal would stop distinguishing "reload genuinely
    // succeeded" from "reload attempted and silently failed after the bootstrap step".
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      reloadEcosystemExtension: async (id: string) => ({
        id,
        package: '@agnes/base',
        version: '0.0.0',
        trust: 'builtin' as const,
        loaded: true,
      }),
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    // This is the real production entry point (runWorker -> dispatch), not a hand-built handleCommand
    // context: resource.stale and run below are pushed as two separate encoded frames, exactly as the
    // daemon sends them (a notification command, then a later, unrelated run command).
    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd.sock',
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
    expect(counters.bootstrapCalls).toBe(1) // the one startup bootstrap, server A only

    // Frame 1, in its own dispatch() call: the daemon's stale notification.
    link.push(
      encodeFrame({ kind: 'command', requestId: 's1', method: 'resource.stale', params: {} } as CommandFrame),
    )
    await waitForReply(fromWorker, 's1')
    expect(counters.bootstrapCalls).toBe(1) // still just the startup bootstrap - marking stale is free

    // The daemon's side of a real enable, between the two frames.
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

    // Frame 2, in its own separate dispatch() call, arriving after frame 1's dispatch() has already
    // returned: the run this whole plan exists to unblock.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
    )
    await waitForReply(fromWorker, 'r1')

    expect(runCalls).toMatchObject([{ until: 'turn-end' }])
    // The bug this test targets: dispatch() building a brand-new ctx per frame silently discarded
    // the staleness mark the instant the resource.stale dispatch() call returned, so this run's
    // dispatch() call saw no staleness at all and never reloaded - bootstrapCalls would stay at 1.
    expect(counters.bootstrapCalls).toBe(2)
  })
})

describe('real dispatch(): resource.stale arrives WHILE a run is still in flight', () => {
  it('keeps the notice so the next run reloads, instead of losing it when the overlapped turn ends', async () => {
    // The production shape this whole plan exists for: a user enables an MCP server from the Web UI
    // while the same session is mid-turn. The `run` frame's dispatch() call is awaiting the entire
    // turn, so the `resource.stale` frame that lands in the middle of it is dispatched by a SEPARATE,
    // concurrently-live dispatch() call. A per-frame ctx snapshot written back wholesale after that
    // long await (the shape main.ts used to have) silently reverts the mark the notice had already
    // set, and the notice is lost for good - it was ACKed to the daemon, so nothing ever retries it.
    // Reproduced here at the real runWorker()/dispatch() entry point with a real fixture MCP server
    // and a real on-disk snapshot rewrite; `bootstrapCalls` stopping at 1 is that lost notice.
    const root = await mkdtemp(join(tmpdir(), 'wrd-inflight-'))
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

    // The first turn does not resolve until this test says so: that held-open promise IS the overlap
    // window the daemon's notification has to survive.
    let releaseFirstTurn: (() => void) | undefined
    const runCalls: Array<{ until?: string }> = []
    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        if (runCalls.length === 1)
          await new Promise<void>((resolve) => {
            releaseFirstTurn = resolve
          })
        return { reason: 'completed' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      reloadEcosystemExtension: async (id: string) => ({
        id,
        package: '@agnes/base',
        version: '0.0.0',
        trust: 'builtin' as const,
        loaded: true,
      }),
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd-inflight.sock',
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
    expect(counters.bootstrapCalls).toBe(1) // the one startup bootstrap, server A only

    // Turn one starts and stays open.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
    )
    await vi.waitFor(
      () => {
        if (runCalls.length !== 1) throw new Error('turn one has not started yet')
      },
      { timeout: 2_000, interval: 10 },
    )

    // The daemon's side of a real enable, committed WHILE turn one is still running.
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
    // Marking must stay free and must not touch the running turn's resource set mid-flight.
    expect(counters.bootstrapCalls).toBe(1)
    expect(runCalls).toHaveLength(1)

    // Turn one ends - this is the moment the old post-await write-back destroyed the mark.
    releaseFirstTurn?.()
    await waitForReply(fromWorker, 'r1')

    // Turn two: the one this plan promises will see the newly enabled server.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'r2',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-2', until: 'turn-end' },
      } as CommandFrame),
    )
    await waitForReply(fromWorker, 'r2')

    expect(runCalls).toMatchObject([{ until: 'turn-end' }, { until: 'turn-end' }])
    expect(counters.bootstrapCalls).toBe(2)
  })
})

describe('real dispatch(): resource.stale and run arrive in the SAME decoded chunk', () => {
  it("still reloads on the run, even when both frames are extracted from one link.on('data') read", async () => {
    // JsonlDecoder.feed() (framing.ts) returns every complete line found in one chunk, and main.ts's
    // `link.on('data', ...)` handler used to fire `void dispatch(raw)` for each with no ordering
    // guarantee between them. Two frames written to the daemon's own socket close enough together in
    // time (an unrelated `resource.stale` notify racing a `run` the client already had in flight - see
    // task-5-report.md) can legitimately arrive in one OS-level read/'data' event: nothing about
    // JSONL-over-a-Duplex-socket promises one write == one read. This test proves that case directly by
    // pushing both frames pre-concatenated into a single chunk, exactly as dec.feed() would see them.
    const root = await mkdtemp(join(tmpdir(), 'wrd-chunk-'))
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

    const runCalls: Array<{ until?: string }> = []
    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        return { reason: 'completed' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      reloadEcosystemExtension: async (id: string) => ({
        id,
        package: '@agnes/base',
        version: '0.0.0',
        trust: 'builtin' as const,
        loaded: true,
      }),
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd-chunk.sock',
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
    expect(counters.bootstrapCalls).toBe(1) // the one startup bootstrap, server A only

    // The daemon's side of a real enable, before either frame is sent.
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

    // Both frames, pre-encoded and concatenated into ONE buffer, pushed as a SINGLE chunk - exactly
    // what dec.feed() sees from one 'data' event carrying two coalesced socket writes.
    const chunk = Buffer.concat([
      encodeFrame({ kind: 'command', requestId: 's1', method: 'resource.stale', params: {} } as CommandFrame),
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
    ])
    link.push(chunk)
    await waitForReply(fromWorker, 'r1')

    expect(runCalls).toMatchObject([{ until: 'turn-end' }])
    // The same-chunk race this test targets: without ordering resource.stale's dispatch() ahead of the
    // run frame that follows it in the same chunk, the run's ctx would be built before resource.stale's
    // post-await sync-back ran, the staleness mark would read as unset, and this reload would never
    // fire - bootstrapCalls would stay at 1.
    expect(counters.bootstrapCalls).toBe(2)
  })

  it('still lets an abort in the same chunk interrupt an in-flight run, unaffected by the resource.stale fix', async () => {
    // The fix above only special-cases `resource.stale`: every other frame, `abort` included, keeps
    // the original fire-and-forget dispatch. This guards against a blanket "await every frame before
    // the next one starts" version of that fix, which would silently queue `abort` behind a `run` that
    // has not returned yet - defeating cancellation for any abort unlucky enough to land in the same
    // chunk as the run it targets. fakeSession.run() below only resolves once its AbortSignal actually
    // fires, so this test hangs (and the awaited reply times out) if abort is not dispatched
    // concurrently with the still-in-flight run.
    const root = await mkdtemp(join(tmpdir(), 'wrd-chunk-abort-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
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
      run: async ({ signal }: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { reason: 'aborted' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd-chunk-abort.sock',
        AGNES_WORKER_KEY: '@shared',
        AGNES_PROFILE_FILE: profile,
        AGNES_WORKER_GENERATION: '1',
        AGNES_WORKER_ROOT: root,
        AGH_HOME: root,
        HOME: root,
      },
      { connect: async () => link, gate: null },
      { buildHost: async () => fakeHost },
    )
    await openSession(link, fromWorker, root)

    const chunk = Buffer.concat([
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
      encodeFrame({
        kind: 'command',
        requestId: 'a1',
        sessionKey: 'session',
        method: 'abort',
        params: { runId: 'run-1' },
      } as CommandFrame),
    ])
    link.push(chunk)
    const reply = await waitForReply(fromWorker, 'r1')
    expect(reply.result).toMatchObject({ reason: 'aborted' })
    await waitForReply(fromWorker, 'a1')
  })
})

describe('real dispatch(): two run frames overlap and single-flight the reload', () => {
  it('two overlapping run frames trigger exactly one reload, not two', async () => {
    // The leak this task (9) exists to close: C1's own investigation confirmed two `run` frames'
    // handleCommand calls genuinely overlap in production (WorkerLink.command() does not queue,
    // scheduler.ts's timer path deliberately skips entry.inflight, claimDue never dedupes a
    // sessionKey, and main.ts's dispatchFrames() fire-and-forgets every frame but resource.stale).
    // Without single-flight protection, both frames independently call reloadWorkerResources, each
    // bootstrapping its own resource generation - one ends up double-closed, the other orphaned
    // (real MCP connections / child processes leaked, never retried).
    const root = await mkdtemp(join(tmpdir(), 'wrd-overlap-'))
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

    const runCalls: Array<{ until?: string }> = []
    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        return { reason: 'completed' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      reloadEcosystemExtension: async (id: string) => ({
        id,
        package: '@agnes/base',
        version: '0.0.0',
        trust: 'builtin' as const,
        loaded: true,
      }),
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd-overlap.sock',
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
    expect(counters.bootstrapCalls).toBe(1) // the one startup bootstrap, server A only

    link.push(
      encodeFrame({ kind: 'command', requestId: 's1', method: 'resource.stale', params: {} } as CommandFrame),
    )
    await waitForReply(fromWorker, 's1')
    expect(counters.bootstrapCalls).toBe(1)

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

    // Two 'run' frames, pre-encoded and concatenated into ONE chunk: dispatchFrames() (main.ts)
    // dispatches every frame but resource.stale fire-and-forget, so both hit `case 'run':`'s
    // `slot.staleMarks > slot.reloadedMarks` check before either one's reload has resolved - the
    // exact overlap window C1's investigation found production-reachable, reproduced directly here.
    const chunk = Buffer.concat([
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
      encodeFrame({
        kind: 'command',
        requestId: 'r2',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-2', until: 'turn-end' },
      } as CommandFrame),
    ])
    link.push(chunk)
    await waitForReply(fromWorker, 'r1')
    await waitForReply(fromWorker, 'r2')

    expect(runCalls).toMatchObject([{ until: 'turn-end' }, { until: 'turn-end' }])
    // The single-flight assertion: one startup bootstrap + exactly one reload attempt, not two.
    expect(counters.bootstrapCalls).toBe(2)
  })

  it('a later frame that joins an in-flight reload does not advance reloadedMarks past what that reload actually captured', async () => {
    // The brief's own sketch (task-9-brief.md) advances `reloadedMarks` using each frame's own,
    // separately live-read `staleMarks` value. That is unsound: a frame that joins a reload already
    // under way, after a NEWER `resource.stale` has landed, would mark that newer notice "consumed"
    // by a reload whose `bootstrapWorkerResources` call already ran and could not possibly have seen
    // it - silently losing it forever (nothing else ever retries a consumed mark). The fix has to
    // advance every joiner's `reloadedMarks` to the value the shared reload actually started with,
    // not to whatever a joiner separately observes. This test proves that distinction concretely: a
    // third, later `run` (backed by no further `resource.stale`) must still see a reload owed.
    const root = await mkdtemp(join(tmpdir(), 'wrd-overlap-join-'))
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

    const runCalls: Array<{ until?: string }> = []
    const fakeSession = {
      key: 'session',
      writerRunId: 'writer',
      d: { log: { parent: null }, cwd: root },
      lastSeq: 0,
      latest: () => undefined,
      preset: { name: 'standard' },
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        return { reason: 'completed' }
      },
      close: async () => undefined,
    } as unknown as HostSession
    const fakeHost = {
      extensionRows: fakeExtensionRows(),
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async () => fakeSession,
      close: async () => undefined,
      reloadEcosystemExtension: async (id: string) => ({
        id,
        package: '@agnes/base',
        version: '0.0.0',
        trust: 'builtin' as const,
        loaded: true,
      }),
    } as unknown as Host

    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })

    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wrd-overlap-join.sock',
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
    expect(counters.bootstrapCalls).toBe(1) // the one startup bootstrap, server A only

    link.push(
      encodeFrame({ kind: 'command', requestId: 's1', method: 'resource.stale', params: {} } as CommandFrame),
    )
    await waitForReply(fromWorker, 's1')

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

    // Frame 1 (run) observes staleMarks=1 and starts the reload: its first real work is a genuine
    // network round trip inside bootstrapWorkerResources, a macrotask-level suspension. `resource.stale`
    // #2 and frame 2 (run), which follow it in this SAME chunk, do no I/O of their own - case
    // 'resource.stale' only increments a counter and case 'run' only synchronously checks/joins
    // `reloadInFlight` - so Node's event loop is guaranteed to fully drain that pure microtask work
    // before frame 1's real I/O callback can ever fire. That is what deterministically lands frame 2's
    // join (observing staleMarks=2, one higher than frame 1) while frame 1's reload is still genuinely
    // in flight; no manual gate or sleep is needed for this ordering.
    const chunk = Buffer.concat([
      encodeFrame({
        kind: 'command',
        requestId: 'r1',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-1', until: 'turn-end' },
      } as CommandFrame),
      encodeFrame({ kind: 'command', requestId: 's2', method: 'resource.stale', params: {} } as CommandFrame),
      encodeFrame({
        kind: 'command',
        requestId: 'r2',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-2', until: 'turn-end' },
      } as CommandFrame),
    ])
    link.push(chunk)
    await waitForReply(fromWorker, 's2')
    await waitForReply(fromWorker, 'r1')
    await waitForReply(fromWorker, 'r2')

    expect(runCalls).toMatchObject([{ until: 'turn-end' }, { until: 'turn-end' }])
    // Single-flight held even though frame 2 observed a newer staleMarks (2) than frame 1 (1): only
    // one reload actually ran, for both frames combined.
    expect(counters.bootstrapCalls).toBe(2)

    // The subtlety this test exists for: a third run, with no further resource.stale in between, must
    // still see a reload owed and trigger a fresh one - proving reloadedMarks was correctly capped at
    // what the shared reload actually captured (1), not silently pushed to frame 2's own newer
    // observed value (2), which would have permanently swallowed the second stale mark.
    link.push(
      encodeFrame({
        kind: 'command',
        requestId: 'r3',
        sessionKey: 'session',
        method: 'run',
        params: { runId: 'run-3', until: 'turn-end' },
      } as CommandFrame),
    )
    await waitForReply(fromWorker, 'r3')
    expect(counters.bootstrapCalls).toBe(3)
  })
})
