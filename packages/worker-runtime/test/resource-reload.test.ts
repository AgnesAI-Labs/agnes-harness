import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Host, HostSession } from '@agnes/host'
import type { McpStatus } from '@agnes/protocol'
import { bootstrapWorkerResources, type WorkerResourceBootstrapInput } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMcpRowChange, handleCommand } from '../src/commands.js'
import type { McpRowRuntime } from '../src/mcp-row-runtime.js'

type CommandFrame = Parameters<typeof handleCommand>[1]

// Same cross-package require trick as http-bootstrap.test.ts: worker-runtime does not declare its own
// dependency on the MCP SDK, and does not need to - @agnes/base already carries it as the one real
// fixture-server implementation this test needs, so borrow it rather than adding a new dependency just
// for a test double.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

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
  if (errors.length) throw new AggregateError(errors, 'resource-reload fixture cleanup failed')
})

/** A real, minimal streamable-HTTP MCP server offering exactly one named tool. No auth: the reload
 *  behavior under test does not depend on SecretRef resolution, which http-bootstrap.test.ts already
 *  covers in depth. */
async function mcpFixture(toolName: string): Promise<string> {
  const mcp = new Server(
    { name: `resource-reload-${toolName}`, version: '1' },
    { capabilities: { tools: {} } },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: 'resource-reload fixture tool',
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

/** A resource-control snapshot document naming one enabled, trusted, unauthenticated HTTP server per
 *  entry - the shape bootstrapWorkerResources()/main.ts's daemon-authored AGNES_RESOURCE_SNAPSHOT file
 *  actually carries (packages/resource-control-worker/src/runtime-bootstrap.ts). */
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

/** Stands in for the session worker's MCP row runtime (mcp-row-runtime.test.ts covers the real one
 *  against a real Host): records which servers each reload applied, optionally held open by `gate`,
 *  optionally rejecting like a refused Host apply. */
function recordingRows(options: { events?: string[]; gate?: Promise<void>; reject?: boolean | 'once' } = {}) {
  const applied: string[][] = []
  const reconnected: string[] = []
  const statuses = new Map<string, McpStatus>()
  const runtime: McpRowRuntime = {
    async apply(entries) {
      const ids = entries.map((entry) => entry.definition.serverId)
      applied.push(ids)
      options.events?.push(`rows:${ids.join(',')}`)
      await options.gate
      if (options.reject) {
        if (options.reject === 'once') options.reject = false
        throw new Error('rows fixture rejection')
      }
      for (const entry of entries)
        statuses.set(entry.definition.serverId, {
          serverId: entry.definition.serverId,
          connectionState: 'ready',
          observedRevision: entry.revision,
          catalogRevision: null,
          toolCount: 0,
          observedAt: new Date(0).toISOString(),
        })
      return { rowIds: ids.map((id) => `ext:agnes/mcp-${id}`), skipped: [], statuses: new Map(statuses) }
    },
    status: (serverId) => statuses.get(serverId),
    tools: () => undefined,
    reconnect: (serverId) => reconnected.push(serverId),
  }
  return { runtime, applied, reconnected, statuses }
}

describe('worker-side resource.stale/run reload (next-turn reload, not mid-turn hot-swap)', () => {
  it('reloads worker resources at the next run, never on resource.stale itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrr-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('toolA')
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      JSON.stringify(snapshotDoc([{ serverId: 'a', url: urlA, toolName: 'toolA' }])),
    )

    const input: WorkerResourceBootstrapInput = {
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshotPath,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
        HOME: root,
      },
      cwd: root,
      agnesHomeDir: root,
      profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
      createSecrets: () => {
        throw new Error('createSecrets should never run: every fixture server uses secretBinding: none')
      },
      mcpRows: true,
    }

    // 1. Bootstrap once, exactly as main.ts's runWorker() does at startup - a real fixture MCP server
    // and a real snapshot file, not a scripted double, per this task's brief.
    const state1 = await bootstrapWorkerResources(input)
    if (!state1) throw new Error('expected a resource generation for a snapshot naming a real server')
    cleanup.push(() => state1.runtime.mcp.close())
    // A session worker's generation connects nothing: MCP servers are Host rows (stage 2b step 3).
    expect(state1.mcp).toEqual([])
    expect(state1.mcpEntries.map((entry) => entry.definition.serverId)).toEqual(['a'])
    const rows = recordingRows()

    // 2. Build the minimal handleCommand context: a real, mutated-in-place `o` object (mirroring
    // main.ts's dispatch(), which passes the same object reference through one handleCommand call and
    // reads back whatever it mutated), a fake HostSession whose only used member is `run`, and a Host
    // fixture whose `reloadEcosystemExtension` is now genuinely exercised by the 'run' reload path
    // (Task 4 wires the real call) - see packages/daemon/test/worker-commands.test.ts for the same
    // "tiny fake proves the call shape" pattern already established for handleCommand tests in this
    // repo. The fake records every call so this test can assert the real extension ids/field names are
    // used, not just that *some* reload happened.
    const runCalls: Array<{ until?: string }> = []
    const session = {
      run: async (opts: { until?: string }) => {
        runCalls.push(opts)
        return { reason: 'completed' }
      },
    } as unknown as HostSession
    const reloadCalls: Array<{ id: string; freshInit: unknown }> = []
    const host = {
      reloadEcosystemExtension: async (id: string, freshInit: unknown) => {
        reloadCalls.push({ id, freshInit })
        return { id, package: '@agnes/base', version: '0.0.0', trust: 'builtin' as const, loaded: true }
      },
    } as unknown as Host
    const ctx: Parameters<typeof handleCommand>[2] = {
      host,
      aborts: new Map(),
      resources: { generation: state1, staleMarks: 0, reloadedMarks: 0, mcpRows: rows.runtime },
      workerResourcesInput: input,
    }

    // 3. 'resource.stale' only marks the flag. This is the assertion Step 6's reverse mutation targets:
    // temporarily make the 'resource.stale' case call reloadWorkerResources immediately and this must
    // go red, because an immediate reload would already have swapped the slot's generation away from
    // state1 by the time this line runs.
    const staleResult = await handleCommand(
      session,
      { kind: 'command', requestId: 's1', method: 'resource.stale', params: {} },
      ctx,
    )
    expect(staleResult).toEqual({ ok: true })
    expect(ctx.resources?.generation).toBe(state1)
    // One notice received, none consumed yet: that inequality IS "a reload is owed before the next turn".
    expect(ctx.resources).toMatchObject({ staleMarks: 1, reloadedMarks: 0 })

    // 4. The daemon's side of a real enable: server B joins the snapshot file in place, server A stays.
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

    // 5. The next 'run' reloads before session.run() is ever called, and the turn still completes on
    // the refreshed resource set.
    const runResult = await handleCommand(
      session,
      { kind: 'command', requestId: 'r1', method: 'run', params: { runId: 'run-1', until: 'turn-end' } },
      ctx,
    )
    expect(runResult).toEqual({ reason: 'completed' })
    expect(runCalls).toMatchObject([{ until: 'turn-end' }])
    // The reload consumed exactly the one mark it observed, so nothing is owed any more.
    expect(ctx.resources).toMatchObject({ staleMarks: 1, reloadedMarks: 1 })
    expect(ctx.resources?.generation).not.toBe(state1)
    cleanup.push(() => ctx.resources?.generation?.runtime.mcp.close() ?? Promise.resolve())
    expect(ctx.resources?.generation?.mcpEntries.map((entry) => entry.definition.serverId)).toEqual([
      'a',
      'b',
    ])
    expect(ctx.resources?.generation?.mcp).toEqual([])
    // The Host-level wiring itself: the snapshot's servers are applied as MCP rows (A unchanged, B
    // new -- the row runtime swaps only what changed), then agnes/skills is reloaded with the *new*
    // generation's skill resources. Nothing else: tool_search (agnes/mcp-search) reads whatever
    // generation agnes/skills serves (design §3.9, D123).
    expect(rows.applied).toEqual([['a', 'b']])
    expect(reloadCalls.map((c) => c.id)).toEqual(['agnes/skills'])
    type FreshInit = { mcpResources?: unknown; skillResources?: unknown }
    const skillFreshInit = reloadCalls[0]?.freshInit as FreshInit | undefined
    expect(skillFreshInit?.skillResources).toBe(ctx.resources?.generation?.skillResources)
    expect(skillFreshInit?.mcpResources).toBeUndefined()
  })

  it('a run that arrives before any resource.stale never reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrr-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('toolA')
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      JSON.stringify(snapshotDoc([{ serverId: 'a', url: urlA, toolName: 'toolA' }])),
    )
    const input: WorkerResourceBootstrapInput = {
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshotPath,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
        HOME: root,
      },
      cwd: root,
      agnesHomeDir: root,
      profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
      createSecrets: () => {
        throw new Error('createSecrets should never run: every fixture server uses secretBinding: none')
      },
      mcpRows: true,
    }
    const state1 = await bootstrapWorkerResources(input)
    if (!state1) throw new Error('expected a resource generation for a snapshot naming a real server')
    cleanup.push(() => state1.runtime.mcp.close())
    const session = {
      run: async () => ({ reason: 'completed' }),
    } as unknown as HostSession
    const ctx: Parameters<typeof handleCommand>[2] = {
      host: {} as unknown as Host,
      aborts: new Map(),
      resources: { generation: state1, staleMarks: 0, reloadedMarks: 0 },
      workerResourcesInput: input,
    }
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: 'r1',
      method: 'run',
      params: { runId: 'run-1', until: 'turn-end' },
    }
    await handleCommand(session, cmd, ctx)
    expect(ctx.resources?.generation).toBe(state1)
    expect(ctx.resources).toMatchObject({ staleMarks: 0, reloadedMarks: 0 })
  })

  it('waits for every active session run and blocks later runs while reloading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrr-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('toolA')
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      JSON.stringify(snapshotDoc([{ serverId: 'a', url: urlA, toolName: 'toolA' }])),
    )
    const input: WorkerResourceBootstrapInput = {
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshotPath,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
        HOME: root,
      },
      cwd: root,
      agnesHomeDir: root,
      profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
      createSecrets: () => {
        throw new Error('fixture has no secret-bound servers')
      },
      mcpRows: true,
    }
    const initial = await bootstrapWorkerResources(input)
    if (!initial) throw new Error('expected initial resource generation')
    cleanup.push(() => initial.runtime.mcp.close())

    let finishA!: () => void
    const aFinished = new Promise<void>((resolve) => {
      finishA = resolve
    })
    let releaseReload!: () => void
    const reloadReleased = new Promise<void>((resolve) => {
      releaseReload = resolve
    })
    const events: string[] = []
    const session = (name: string, wait?: Promise<void>) =>
      ({
        lastSeq: 0,
        run: async () => {
          events.push(`run:${name}`)
          await wait
          events.push(`done:${name}`)
          return { reason: 'completed' }
        },
      }) as unknown as HostSession
    const host = {
      reloadEcosystemExtension: async (id: string) => {
        events.push(`reload:${id}`)
        return { id, package: '@agnes/base', version: '0.0.0', trust: 'builtin' as const, loaded: true }
      },
    } as unknown as Host
    const resources: NonNullable<Parameters<typeof handleCommand>[2]['resources']> = {
      generation: initial,
      staleMarks: 0,
      reloadedMarks: 0,
      mcpRows: recordingRows({ events, gate: reloadReleased }).runtime,
    }
    const context = (): Parameters<typeof handleCommand>[2] => ({
      host,
      aborts: new Map(),
      resources,
      workerResourcesInput: input,
    })

    const runA = handleCommand(
      session('a', aFinished),
      { kind: 'command', requestId: 'a', method: 'run', params: { runId: 'a' } },
      context(),
    )
    await vi.waitFor(() => expect(events).toContain('run:a'))
    await handleCommand(
      session('marker'),
      { kind: 'command', requestId: 'stale', method: 'resource.stale', params: {} },
      context(),
    )
    const runB = handleCommand(
      session('b'),
      { kind: 'command', requestId: 'b', method: 'run', params: { runId: 'b' } },
      context(),
    )
    const runC = handleCommand(
      session('c'),
      { kind: 'command', requestId: 'c', method: 'run', params: { runId: 'c' } },
      context(),
    )
    await Promise.resolve()
    expect(events).toEqual(['run:a'])

    finishA()
    await runA
    await vi.waitFor(() => expect(events).toContain('rows:a'))
    expect(events).not.toContain('run:b')
    expect(events).not.toContain('run:c')

    releaseReload()
    await Promise.all([runB, runC])
    expect(events).toEqual([
      'run:a',
      'done:a',
      'rows:a',
      'reload:agnes/skills',
      'run:b',
      'done:b',
      'run:c',
      'done:c',
    ])
    cleanup.push(() => resources.generation?.runtime.mcp.close() ?? Promise.resolve())
  })

  it('a reload that reports loaded: false leaves workerResources and staleness untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrr-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const urlA = await mcpFixture('toolA')
    const snapshotPath = join(root, 'snapshot.json')
    await writeFile(
      snapshotPath,
      JSON.stringify(snapshotDoc([{ serverId: 'a', url: urlA, toolName: 'toolA' }])),
    )

    const input: WorkerResourceBootstrapInput = {
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshotPath,
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
        HOME: root,
      },
      cwd: root,
      agnesHomeDir: root,
      profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
      createSecrets: () => {
        throw new Error('createSecrets should never run: every fixture server uses secretBinding: none')
      },
      mcpRows: true,
    }

    const state1 = await bootstrapWorkerResources(input)
    if (!state1) throw new Error('expected a resource generation for a snapshot naming a real server')
    cleanup.push(() => state1.runtime.mcp.close())

    const session = {
      run: async () => ({ reason: 'completed' }),
    } as unknown as HostSession
    // `reloadEcosystemExtension`'s real implementation (managed-host.ts's `load()`) swallows its own
    // errors and resolves with `{ loaded: false, error }` rather than throwing - this fake reproduces
    // exactly that non-throwing failure shape for the skills extension, which a naive try/catch
    // around the call (with no explicit `.loaded` check) would silently miss.
    const reloadCalls: string[] = []
    const host = {
      reloadEcosystemExtension: async (id: string) => {
        reloadCalls.push(id)
        if (id !== 'agnes/skills')
          return { id, package: '@agnes/base', version: '0.0.0', trust: 'builtin' as const, loaded: true }
        return {
          id,
          package: '@agnes/base',
          version: '0.0.0',
          trust: 'builtin' as const,
          loaded: false,
          error: new Error('skills fixture failure'),
        }
      },
    } as unknown as Host
    const rows = recordingRows()
    const ctx: Parameters<typeof handleCommand>[2] = {
      host,
      aborts: new Map(),
      resources: { generation: state1, staleMarks: 0, reloadedMarks: 0, mcpRows: rows.runtime },
      workerResourcesInput: input,
    }

    const staleResult = await handleCommand(
      session,
      { kind: 'command', requestId: 's1', method: 'resource.stale', params: {} },
      ctx,
    )
    expect(staleResult).toEqual({ ok: true })
    expect(ctx.resources).toMatchObject({ staleMarks: 1, reloadedMarks: 0 })

    // The daemon's side of a real enable, exactly as the happy-path test above - if the reload had
    // gone through despite the failure, this second server would show up in workerResources.mcp.
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

    const runResult = await handleCommand(
      session,
      { kind: 'command', requestId: 'r1', method: 'run', params: { runId: 'run-1', until: 'turn-end' } },
      ctx,
    )

    // The turn itself must still complete on the old-but-working resource set - a failed reload must
    // never throw out of `run`.
    expect(runResult).toEqual({ reason: 'completed' })
    // Skills failed after MCP applied; reverse compensation restores the old server set.
    expect(rows.applied).toEqual([['a', 'b'], ['a']])
    expect(reloadCalls).toEqual(['agnes/skills'])
    // The old generation is untouched: not swapped for whatever the failed reload might have
    // half-produced, and still only naming server A.
    expect(ctx.resources?.generation).toBe(state1)
    expect(ctx.resources?.generation?.mcpEntries.map((entry) => entry.definition.serverId)).toEqual(['a'])
    // Staleness is not cleared, so the next `run` retries the reload instead of silently giving up.
    expect(ctx.resources).toMatchObject({ staleMarks: 1, reloadedMarks: 0 })
  })

  it.each([false, true])(
    'a refused MCP apply compensates before skills; failed compensation blocks turns = %s',
    async (failRollback) => {
      const root = await mkdtemp(join(tmpdir(), 'wrr-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const snapshotPath = join(root, 'snapshot.json')
      const url = 'http://127.0.0.1:9/mcp'
      await writeFile(snapshotPath, JSON.stringify(snapshotDoc([{ serverId: 'a', url, toolName: 'toolA' }])))
      const input: WorkerResourceBootstrapInput = {
        env: { AGNES_RESOURCE_SNAPSHOT: snapshotPath, HOME: root },
        cwd: root,
        agnesHomeDir: root,
        profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
        createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
        createSecrets: () => {
          throw new Error('rows mode resolves no secret')
        },
        mcpRows: true,
      }
      const state1 = await bootstrapWorkerResources(input)
      if (!state1) throw new Error('expected a resource generation')
      cleanup.push(() => state1.runtime.mcp.close())
      const reloadCalls: string[] = []
      const host = {
        reloadEcosystemExtension: async (id: string) => {
          reloadCalls.push(id)
          return { id, package: '@agnes/base', version: '0.0.0', trust: 'builtin' as const, loaded: true }
        },
      } as unknown as Host
      const rows = recordingRows({ reject: failRollback ? true : 'once' })
      const ctx: Parameters<typeof handleCommand>[2] = {
        host,
        aborts: new Map(),
        resources: { generation: state1, staleMarks: 1, reloadedMarks: 0, mcpRows: rows.runtime },
        workerResourcesInput: input,
      }
      await writeFile(
        snapshotPath,
        JSON.stringify(
          snapshotDoc([
            { serverId: 'a', url, toolName: 'toolA' },
            { serverId: 'b', url, toolName: 'toolB' },
          ]),
        ),
      )
      const session = { run: async () => ({ reason: 'completed' }) } as unknown as HostSession

      const run = () =>
        handleCommand(
          session,
          { kind: 'command', requestId: 'r1', method: 'run', params: { runId: 'run-1', until: 'turn-end' } },
          ctx,
        )
      if (failRollback) await expect(run()).rejects.toThrow(/recovery required/)
      else await expect(run()).resolves.toEqual({ reason: 'completed' })
      expect(rows.applied).toEqual([['a', 'b'], ['a']])
      expect(reloadCalls).toEqual([])
      expect(ctx.resources?.generation).toBe(state1)
      expect(ctx.resources).toMatchObject({ staleMarks: 1, reloadedMarks: 0 })
      expect(ctx.resources?.recoveryRequired ?? false).toBe(failRollback)
    },
  )
})

/** One real fixture MCP server, bootstrapped once, plus the `handleCommand`-shaped context
 *  `applyMcpRowChange` needs - the same shape every test above already builds by hand. */
async function fixtureContext(serverId = 'a'): Promise<{
  context(): Parameters<typeof handleCommand>[2]
  resources: NonNullable<Parameters<typeof handleCommand>[2]['resources']>
  rows: ReturnType<typeof recordingRows>
}> {
  const root = await mkdtemp(join(tmpdir(), 'wrr-apply-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const url = await mcpFixture(`tool_${serverId}`)
  const snapshotPath = join(root, 'snapshot.json')
  await writeFile(
    snapshotPath,
    JSON.stringify(snapshotDoc([{ serverId, url, toolName: `tool_${serverId}` }])),
  )
  const input: WorkerResourceBootstrapInput = {
    env: {
      AGNES_RESOURCE_SNAPSHOT: snapshotPath,
      AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
        allowedExecutables: [],
        allowLoopbackHttp: true,
        localDaemon: true,
      }),
      HOME: root,
    },
    cwd: root,
    agnesHomeDir: root,
    profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } },
    createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
    createSecrets: () => {
      throw new Error('fixture has no secret-bound servers')
    },
    mcpRows: true,
  }
  const initial = await bootstrapWorkerResources(input)
  if (!initial) throw new Error('expected initial resource generation')
  cleanup.push(() => initial.runtime.mcp.close())
  const rows = recordingRows()
  const resources: NonNullable<Parameters<typeof handleCommand>[2]['resources']> = {
    generation: initial,
    staleMarks: 0,
    reloadedMarks: 0,
    mcpRows: rows.runtime,
  }
  const host = {
    reloadEcosystemExtension: async (id: string) => ({
      id,
      package: '@agnes/base',
      version: '0.0.0',
      trust: 'builtin' as const,
      loaded: true,
    }),
  } as unknown as Host
  return {
    context: () => ({ host, aborts: new Map(), resources, workerResourcesInput: input }),
    resources,
    rows,
  }
}

describe('applyMcpRowChange (worker side of resourceMcpApply/resourceMcpReconnect)', () => {
  it('forces an immediate reload regardless of staleness, and returns the named server’s post-reload status', async () => {
    const { context, resources, rows } = await fixtureContext('a')
    expect(resources.staleMarks).toBe(0)

    const status = await applyMcpRowChange(context(), 'a', false)

    expect(rows.applied).toEqual([['a']])
    expect(status).toMatchObject({ serverId: 'a', connectionState: 'ready' })
    expect(rows.reconnected).toEqual([])
    // The forced reload is real, not just a staleMarks bump left for later: reloadedMarks caught up.
    expect(resources.reloadedMarks).toBeGreaterThanOrEqual(resources.staleMarks)
  })

  it('with reconnect=true, bumps this server’s epoch before reloading', async () => {
    const { context, rows } = await fixtureContext('a')

    await applyMcpRowChange(context(), 'a', true)

    expect(rows.reconnected).toEqual(['a'])
    expect(rows.applied).toEqual([['a']])
  })

  it('waits for an in-flight run before reloading, same as an ordinary staleness-triggered reload', async () => {
    const { context, rows } = await fixtureContext('a')
    const events: string[] = []
    let finishRun!: () => void
    const running = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    const session = {
      run: async () => {
        events.push('run:start')
        await running
        events.push('run:done')
        return { reason: 'completed' }
      },
    } as unknown as HostSession

    const run = handleCommand(
      session,
      { kind: 'command', requestId: 'r', method: 'run', params: { runId: 'r' } },
      context(),
    )
    await vi.waitFor(() => expect(events).toContain('run:start'))

    const applying = applyMcpRowChange(context(), 'a', false).then((status) => {
      events.push('applied')
      return status
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual(['run:start'])

    finishRun()
    await run
    await applying
    expect(events).toEqual(['run:start', 'run:done', 'applied'])
    expect(rows.applied).toEqual([['a']])
  })

  it('returns undefined for a server the current snapshot does not name', async () => {
    const { context } = await fixtureContext('a')

    const status = await applyMcpRowChange(context(), 'not-in-snapshot', false)

    expect(status).toBeUndefined()
  })
})
