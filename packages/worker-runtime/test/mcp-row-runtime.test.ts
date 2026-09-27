import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMcp, type McpConnection, type McpServerOpener, mcpLocalToolPrefix } from '@agnes/base'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { type McpServerDefinitionInput, validateResourceControlData } from '@agnes/protocol'
import {
  createWorkerMcpServerOpener,
  syncManagedMcpExecutableAllowlist,
} from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpRowRuntime } from '../src/mcp-row-runtime.js'
import type { McpServerSnapshotEntry } from '../src/mcp-server-rows.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
// The prefix is register.ts's tool naming for that server id, computed via the shared function
// rather than hardcoded (design 2026-09-23-mcp-tool-name-collision-design.md §0.4).
const ALPHA_PREFIX = mcpLocalToolPrefix('alpha')
const BETA_PREFIX = mcpLocalToolPrefix('beta')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function entry(serverId: string, revision = 'r1'): McpServerSnapshotEntry {
  return {
    definition: {
      serverId,
      displayName: serverId,
      transport: { kind: 'stdio', executable: `/usr/local/bin/${serverId}-mcp`, args: [] },
      secretBinding: { kind: 'none' },
    } as McpServerDefinitionInput,
    revision,
    desired: 'enabled',
    trust: 'trusted',
  }
}

// Real-machine verification (design 2026-09-23-mcp-tool-name-collision-design.md, "未关闭边界"):
// spawns real @modelcontextprotocol/sdk stdio subprocesses, connects with the real connectMcp() (not
// a hand-rolled McpConnection), and registers through the real per-server row + real Host tool
// registry -- the same layers a genuine collision would hit in production. Only the CLI/daemon/PTY
// wrapper built-resource-mcp.e2e.test.ts also exercises is skipped; everything from the wire protocol
// down to Kernel.tools is real.
const baseRequire = createRequire(join(baseDir, 'package.json'))
const sdkPaths = {
  server: baseRequire.resolve('@modelcontextprotocol/sdk/server/index.js'),
  stdio: baseRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  types: baseRequire.resolve('@modelcontextprotocol/sdk/types.js'),
}

/** Writes and returns the path to a real MCP stdio server exposing one 'read' tool. */
async function realOneToolServerScript(directory: string): Promise<string> {
  const script = join(directory, 'real-one-tool-mcp.mjs')
  await writeFile(
    script,
    [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      `const { Server } = require(${JSON.stringify(sdkPaths.server)})`,
      `const { StdioServerTransport } = require(${JSON.stringify(sdkPaths.stdio)})`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkPaths.types)})`,
      "const server = new Server({ name: 'real-one-tool-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })",
      "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read', description: 'read something', inputSchema: { type: 'object' } }] }))",
      "server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }))",
      'await server.connect(new StdioServerTransport())',
    ].join('\n'),
    'utf8',
  )
  return script
}

/** A real McpServerOpener: connectMcp() with the real SDK, against a real subprocess per server. */
function realOpener(): McpServerOpener {
  return {
    async connect(definition, signal) {
      if (definition.transport.kind !== 'stdio') throw new Error('fixture only supports stdio')
      return connectMcp(
        {
          id: definition.serverId,
          transport: 'stdio',
          cmd: [definition.transport.executable, ...definition.transport.args],
          defer: false,
        },
        undefined,
        { signal },
      )
    },
  }
}

/** Counts connects and closes per server; every connection offers one `ping` tool. */
function countingOpener() {
  const connects: string[] = []
  const closes: string[] = []
  const opener: McpServerOpener = {
    async connect(definition) {
      connects.push(definition.serverId)
      const connection: McpConnection = {
        id: definition.serverId,
        async listTools() {
          return [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }]
        },
        async callTool() {
          return { content: [{ type: 'text' as const, text: 'pong' }] }
        },
        async close() {
          closes.push(definition.serverId)
        },
        onClose: () => () => undefined,
        onToolsChanged: () => () => undefined,
      }
      return connection
    },
  }
  return { opener, connects, closes }
}

/** The last test Host's data dir, which is also its only trusted session workspace. */
let hostDir = ''
async function testHost(): Promise<Host> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-row-runtime-'))
  hostDir = dataDir
  const { host } = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': baseDir },
  })
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  cleanup.push(() => host.close())
  return host
}

const tool = (host: Host, name: string) => host.kernel.tools.resolve(name)

describe('createMcpRowRuntime against a real Host', () => {
  it('mounts one row per server and registers each server’s tools, keeping the builtin rows', async () => {
    const host = await testHost()
    const builtin = host.extensionRows.current().map((row) => row.id)
    const { opener } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })

    const result = await runtime.apply([
      entry('alpha'),
      entry('beta'),
      { ...entry('off'), desired: 'disabled' },
    ])

    expect(result.rowIds).toHaveLength(2)
    expect(result.skipped).toEqual([{ serverId: 'off', reason: 'disabled' }])
    await vi.waitFor(() => {
      expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeDefined()
      expect(tool(host, `${BETA_PREFIX}ping`)).toBeDefined()
    })
    const ids = host.extensionRows.current().map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([...builtin, ...result.rowIds]))
  })

  it('an edited server reconnects alone; an unchanged server keeps its one connection', async () => {
    const host = await testHost()
    const { opener, connects, closes } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    await runtime.apply([entry('alpha', 'r1'), entry('beta', 'r1')])
    await vi.waitFor(() => expect(connects.sort()).toEqual(['alpha', 'beta']))

    await runtime.apply([entry('alpha', 'r2'), entry('beta', 'r1')])

    await vi.waitFor(() => expect(connects.filter((id) => id === 'alpha')).toHaveLength(2))
    await vi.waitFor(() => expect(closes).toEqual(['alpha']))
    expect(connects.filter((id) => id === 'beta')).toHaveLength(1)
    await vi.waitFor(() => expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeDefined())
    expect(tool(host, `${BETA_PREFIX}ping`)).toBeDefined()
  })

  it('reconnect() forces a server to remount on the next apply() even at the same revision, and only that one', async () => {
    const host = await testHost()
    const { opener, connects, closes } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    await runtime.apply([entry('alpha', 'r1'), entry('beta', 'r1')])
    await vi.waitFor(() => expect(connects.sort()).toEqual(['alpha', 'beta']))

    // Same revision both times: without reconnect() this second apply() would touch nothing (the
    // very next test below pins that). reconnect() must still force alpha's row to remount.
    runtime.reconnect('alpha')
    const result = await runtime.apply([entry('alpha', 'r1'), entry('beta', 'r1')])

    await vi.waitFor(() => expect(connects.filter((id) => id === 'alpha')).toHaveLength(2))
    await vi.waitFor(() => expect(closes).toEqual(['alpha']))
    expect(connects.filter((id) => id === 'beta')).toHaveLength(1)
    // The daemon-authored revision is reported unchanged - the epoch is a worker-internal remount
    // trick, never surfaced as this server's observedRevision.
    expect(result.statuses.get('alpha')).toMatchObject({ connectionState: 'ready', observedRevision: 'r1' })
    // A second reconnect (already at a new epoch) with the daemon revision still unchanged still
    // forces another remount - it is not a one-shot bit, and does not depend on anything else moving.
    runtime.reconnect('alpha')
    await runtime.apply([entry('alpha', 'r1'), entry('beta', 'r1')])
    await vi.waitFor(() => expect(connects.filter((id) => id === 'alpha')).toHaveLength(3))
  })

  it('an identical snapshot re-applied touches nothing', async () => {
    const host = await testHost()
    const { opener, connects, closes } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    await runtime.apply([entry('alpha'), entry('beta')])
    await vi.waitFor(() => expect(connects).toHaveLength(2))

    await runtime.apply([entry('alpha'), entry('beta')])
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(connects).toHaveLength(2)
    expect(closes).toEqual([])
  })

  it('a removed server unmounts and closes alone; the remaining server is untouched', async () => {
    const host = await testHost()
    const { opener, connects, closes } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    const first = await runtime.apply([entry('alpha'), entry('beta')])
    await vi.waitFor(() => expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeDefined())

    const second = await runtime.apply([entry('beta')])

    await vi.waitFor(() => expect(closes).toEqual(['alpha']))
    expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeUndefined()
    expect(tool(host, `${BETA_PREFIX}ping`)).toBeDefined()
    expect(connects.filter((id) => id === 'beta')).toHaveLength(1)
    expect(host.extensionRows.current().map((row) => row.id)).not.toContain(
      first.rowIds.find((id) => !second.rowIds.includes(id)),
    )
  })
})

describe('createMcpRowRuntime keeps a row live against the real tool registry', () => {
  it('re-syncs on tools/list_changed and re-registers after an unexpected disconnect, as a bound session sees it', async () => {
    const host = await testHost()
    const live: Array<{ fireClose(): void; fireToolsChanged(): void }> = []
    const served: number[] = []
    let toolNames = ['ping']
    const opener: McpServerOpener = {
      async connect(definition) {
        const generation = live.length + 1
        const closeListeners = new Set<() => void>()
        const changedListeners = new Set<() => void>()
        const connection: McpConnection = {
          id: definition.serverId,
          async listTools() {
            return toolNames.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))
          },
          async callTool() {
            served.push(generation)
            return { content: [{ type: 'text' as const, text: 'pong' }] }
          },
          async close() {},
          onClose: (listener) => {
            closeListeners.add(listener)
            return () => closeListeners.delete(listener)
          },
          onToolsChanged: (listener) => {
            changedListeners.add(listener)
            return () => changedListeners.delete(listener)
          },
        }
        live.push({
          fireClose: () => {
            for (const listener of [...closeListeners]) listener()
          },
          fireToolsChanged: () => {
            for (const listener of [...changedListeners]) listener()
          },
        })
        return connection
      },
    }
    await createMcpRowRuntime({ host, opener }).apply([entry('alpha')])
    // A session bound now: its tools come from the published generation, which copied the
    // registrations when it was created -- not from the Kernel table the row keeps changing.
    const dir = hostDir
    const session = await host.createSession({ key: 'bound', cwd: dir })
    const seen = (name: string) => session.currentTools().resolve(name)
    const run = (name: string) =>
      (seen(name) as unknown as { execute(args: unknown, ctx: unknown): Promise<unknown> }).execute(
        {},
        {
          signal: new AbortController().signal,
          session: { key: session.key, lane: session.lane, workspaceRoot: dir },
        },
      )
    expect(seen(`${ALPHA_PREFIX}ping`)).toBeDefined()

    // Same names registered again by the re-sync: only works if the old registration went first.
    toolNames = ['ping', 'pong']
    live[0]?.fireToolsChanged()
    await vi.waitFor(() => expect(seen(`${ALPHA_PREFIX}pong`)).toBeDefined())
    expect(seen(`${ALPHA_PREFIX}ping`)).toBeDefined()

    live[0]?.fireClose()
    await vi.waitFor(() => expect(live).toHaveLength(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(seen(`${ALPHA_PREFIX}pong`)).toBeDefined())
    // The bound session's tool is the re-registered one, served by the new connection.
    await run(`${ALPHA_PREFIX}ping`)
    expect(served).toEqual([2])
  })
})

describe('createMcpRowRuntime first connection attempts (design §3.8, D120)', () => {
  it("resolves only after a started row's first attempt: its tools are there when apply returns", async () => {
    const host = await testHost()
    const slow = countingOpener()
    const opener: McpServerOpener = {
      async connect(definition, signal) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return slow.opener.connect(definition, signal)
      },
    }
    await createMcpRowRuntime({ host, opener }).apply([entry('alpha')])
    // No waitFor: apply itself waited for the connection and the tool registration.
    expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeDefined()
  })

  it('a server that never answers holds apply only up to the cap', async () => {
    const host = await testHost()
    const hanging: McpServerOpener = {
      connect: (_definition, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    }
    const started = Date.now()
    const result = await createMcpRowRuntime({ host, opener: hanging, firstAttemptTimeoutMs: 100 }).apply([
      entry('alpha'),
    ])
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.rowIds).toHaveLength(1)
    expect(tool(host, `${ALPHA_PREFIX}ping`)).toBeUndefined()
  })

  it('does not wait on a row it did not restart', async () => {
    const host = await testHost()
    let hang = false
    const base = countingOpener()
    const opener: McpServerOpener = {
      connect: (definition, signal) =>
        hang
          ? new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                once: true,
              })
            })
          : base.opener.connect(definition, signal),
    }
    const runtime = createMcpRowRuntime({ host, opener, firstAttemptTimeoutMs: 5_000 })
    await runtime.apply([entry('alpha')])
    hang = true
    const started = Date.now()
    await runtime.apply([entry('alpha')])
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('createMcpRowRuntime row shape and failure handling', () => {
  function fakeHost(options: { rejectApply?: () => boolean } = {}) {
    let rows: { id: string }[] = [{ id: 'ext:agnes/tools-core' }]
    const prepared: Record<string, unknown>[] = []
    const applied: string[][] = []
    const host = {
      extensionRows: {
        current: () => rows,
        prepare: (input: Record<string, unknown> & { extensionId: string }) => {
          prepared.push(input)
          return { id: `ext:${input.extensionId}` }
        },
        apply: async (next: { id: string }[]) => {
          applied.push(next.map((row) => row.id))
          if (options.rejectApply?.()) throw new Error('rejected candidate')
          rows = next
          return {}
        },
      },
    }
    return { host: host as unknown as Pick<Host, 'extensionRows'>, prepared, applied }
  }

  it('prepares every row without a config, so an edit can only change the row identity', async () => {
    const { host, prepared } = fakeHost()
    const runtime = createMcpRowRuntime({ host, opener: countingOpener().opener })
    await runtime.apply([entry('alpha'), entry('beta')])
    expect(prepared).toHaveLength(2)
    for (const input of prepared) expect(Object.keys(input).sort()).toEqual(['dynamic', 'extensionId'])
  })

  it('a rejected apply keeps the previous row set as its own, so the retry replaces exactly those rows', async () => {
    let reject = false
    const { host, applied } = fakeHost({ rejectApply: () => reject })
    const runtime = createMcpRowRuntime({ host, opener: countingOpener().opener })
    const first = await runtime.apply([entry('alpha')])

    reject = true
    await expect(runtime.apply([entry('beta')])).rejects.toThrow('rejected candidate')
    reject = false
    const retried = await runtime.apply([entry('beta')])

    // The retry dropped alpha's row (still ours after the rejection) and kept the builtin row.
    expect(applied.at(-1)).toEqual(['ext:agnes/tools-core', ...retried.rowIds])
    expect(applied.at(-1)).not.toContain(first.rowIds[0])
  })

  it('reports each server’s live McpStatus, filled in with its own applied revision', async () => {
    const host = await testHost()
    const { opener } = countingOpener()
    const statuses: Array<{ serverId: string; status: unknown }> = []
    const runtime = createMcpRowRuntime({
      host,
      opener,
      onStatus: (serverId, status) => statuses.push({ serverId, status }),
    })

    await runtime.apply([entry('alpha', 'rev-a'), entry('beta', 'rev-b')])
    await vi.waitFor(() => {
      const alphaReady = statuses.find(
        (s) =>
          s.serverId === 'alpha' && (s.status as { connectionState: string }).connectionState === 'ready',
      )
      expect(alphaReady).toBeDefined()
    })

    const alphaEvents = statuses.filter((s) => s.serverId === 'alpha').map((s) => s.status)
    expect(alphaEvents[0]).toMatchObject({
      serverId: 'alpha',
      connectionState: 'connecting',
      observedRevision: null,
    })
    expect(alphaEvents.at(-1)).toMatchObject({
      serverId: 'alpha',
      connectionState: 'ready',
      observedRevision: 'rev-a',
      toolCount: 1,
    })
    await vi.waitFor(() => {
      const betaReady = statuses.find(
        (s) => s.serverId === 'beta' && (s.status as { connectionState: string }).connectionState === 'ready',
      )
      expect(betaReady).toBeDefined()
    })
    expect(
      statuses
        .filter((s) => s.serverId === 'beta')
        .map((s) => s.status)
        .at(-1),
    ).toMatchObject({ serverId: 'beta', connectionState: 'ready', observedRevision: 'rev-b' })
  })

  it('apply() itself returns every server’s settled status, and status() answers the same afterwards', async () => {
    const host = await testHost()
    const { opener } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })

    const result = await runtime.apply([
      entry('alpha', 'rev-a'),
      { ...entry('off', 'rev-off'), desired: 'disabled' },
      { ...entry('untrusted', 'rev-u'), trust: 'untrusted' },
    ])

    expect(result.statuses.get('alpha')).toMatchObject({
      connectionState: 'ready',
      observedRevision: 'rev-a',
    })
    expect(result.statuses.get('off')).toMatchObject({ connectionState: 'disabled' })
    expect(result.statuses.get('untrusted')).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_UNTRUSTED_REVISION' },
    })
    expect(runtime.status('alpha')).toEqual(result.statuses.get('alpha'))
    expect(runtime.status('off')).toEqual(result.statuses.get('off'))
    expect(runtime.status('untrusted')).toEqual(result.statuses.get('untrusted'))
    expect(runtime.status('never-seen')).toBeUndefined()
  })

  it('an OAuth-bound definition is reported unavailable with MCP_OAUTH_UNSUPPORTED, never a row', async () => {
    const host = await testHost()
    const { opener } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    const oauthEntry: McpServerSnapshotEntry = {
      ...entry('needs-oauth'),
      definition: {
        serverId: 'needs-oauth',
        displayName: 'needs-oauth',
        transport: { kind: 'http', url: 'https://mcp.example.test/api' },
        secretBinding: { kind: 'oauth', staticClientId: 'static-client-id' },
      } as McpServerDefinitionInput,
    }

    const result = await runtime.apply([oauthEntry])

    expect(result.rowIds).toHaveLength(0)
    expect(result.statuses.get('needs-oauth')).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_UNSUPPORTED' },
    })
  })

  it('a server dropped from a later snapshot leaves no trace in status() or a stale apply() map', async () => {
    const host = await testHost()
    const { opener } = countingOpener()
    const runtime = createMcpRowRuntime({ host, opener })
    await runtime.apply([entry('alpha'), entry('beta')])
    await vi.waitFor(() => expect(runtime.status('alpha')?.connectionState).toBe('ready'))

    const result = await runtime.apply([entry('beta')])

    expect(result.statuses.has('alpha')).toBe(false)
    expect(runtime.status('alpha')).toBeUndefined()
    expect(runtime.tools('alpha', 'r1')).toBeUndefined()
  })

  describe('tools() pagination', () => {
    function manyToolsOpener(count: number): McpServerOpener {
      const names = Array.from({ length: count }, (_v, i) => `t${String(i).padStart(3, '0')}`)
      return {
        async connect(definition) {
          const connection: McpConnection = {
            id: definition.serverId,
            async listTools() {
              return names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))
            },
            async callTool() {
              return { content: [] }
            },
            async close() {},
            onClose: () => () => undefined,
            onToolsChanged: () => () => undefined,
          }
          return connection
        },
      }
    }

    it('returns undefined before the row has ever synced, and once its revision moves on', async () => {
      const host = await testHost()
      const runtime = createMcpRowRuntime({ host, opener: manyToolsOpener(1) })
      expect(runtime.tools('alpha', 'r1')).toBeUndefined()
      await runtime.apply([entry('alpha', 'r1')])
      await vi.waitFor(() => expect(runtime.tools('alpha', 'r1')).toBeDefined())
      expect(runtime.tools('alpha', 'r2')).toBeUndefined()
    })

    // Mounting 250 tools takes about 1.4s alone (linear, about 5ms per tool) and exceeded the 5s
    // default on a loaded hosted runner.
    it('pages a large catalog by 100, sorted by name, with a cursor that reaches every tool exactly once', async () => {
      const host = await testHost()
      const runtime = createMcpRowRuntime({ host, opener: manyToolsOpener(250) })
      await runtime.apply([entry('alpha', 'r1')])
      await vi.waitFor(() => expect(runtime.tools('alpha', 'r1')).toBeDefined())

      const seen: string[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 10; guard++) {
        const page = runtime.tools('alpha', 'r1', cursor)
        if (!page) throw new Error('expected a page')
        expect(page.serverId).toBe('alpha')
        expect(page.items.length).toBeLessThanOrEqual(100)
        seen.push(...page.items.map((item) => item.name))
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      expect(seen).toHaveLength(250)
      expect(new Set(seen).size).toBe(250)
      expect(seen).toEqual([...seen].sort())
    }, 30_000)

    it('rejects a cursor that is not a valid offset into this catalog', async () => {
      const host = await testHost()
      const runtime = createMcpRowRuntime({ host, opener: manyToolsOpener(1) })
      await runtime.apply([entry('alpha', 'r1')])
      await vi.waitFor(() => expect(runtime.tools('alpha', 'r1')).toBeDefined())
      expect(() => runtime.tools('alpha', 'r1', 'not-a-number')).toThrow('invalid MCP tool cursor')
      expect(() => runtime.tools('alpha', 'r1', '999')).toThrow('invalid MCP tool cursor')
    })
  })
})

describe('createMcpRowRuntime against real MCP servers (real-machine collision verification)', () => {
  it.skipIf(process.platform !== 'win32')(
    'authorizes a trusted enabled Windows executable, then revokes it',
    async () => {
      const scriptDir = await mkdtemp(join(tmpdir(), 'mcp-managed-stdio-'))
      cleanup.push(() => rm(scriptDir, { recursive: true, force: true }))
      const script = await realOneToolServerScript(scriptDir)
      const host = await testHost()
      const env: NodeJS.ProcessEnv = {
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: false,
          localDaemon: true,
        }),
      }
      const managed: string[] = []
      const runtime = createMcpRowRuntime({
        host,
        opener: createWorkerMcpServerOpener(
          {
            env,
            profile: { name: 'local-dev', dataDir: scriptDir } as never,
            createSecrets: () => {
              throw new Error('none-bound MCP must not resolve secrets')
            },
          },
          managed,
        ),
        beforeApply: (entries) => syncManagedMcpExecutableAllowlist(entries, [], managed, env, true),
      })
      const enabled: McpServerSnapshotEntry = {
        definition: {
          serverId: 'managed',
          displayName: 'managed',
          transport: { kind: 'stdio', executable: process.execPath, args: [script] },
          secretBinding: { kind: 'none' },
        },
        revision: 'r1',
        desired: 'enabled',
        trust: 'trusted',
      }
      const first = await runtime.apply([enabled])
      expect(first.statuses.get('managed')?.connectionState).toBe('ready')
      expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBe(process.execPath)
      const name = `${mcpLocalToolPrefix('managed')}read`
      expect(tool(host, name)).toBeDefined()
      await runtime.apply([{ ...enabled, desired: 'disabled' }])
      expect(managed).toEqual([])
      expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBeUndefined()
      expect(tool(host, name)).toBeUndefined()
    },
  )

  it('gives two real servers whose ids sanitize to the same string distinct, both-callable tool names', async () => {
    // The exact reported scenario: "a.b" and "a_b" both collapse to "a_b" under a plain
    // /[^A-Za-z0-9_]/g -> '_' sanitizer. Two real subprocesses, real connectMcp(), real per-server
    // Cordis rows, real Host tool registry -- not fakeApi/fakeConnection.
    const scriptDir = await mkdtemp(join(tmpdir(), 'mcp-real-collision-'))
    cleanup.push(() => rm(scriptDir, { recursive: true, force: true }))
    const script = await realOneToolServerScript(scriptDir)
    const realEntry = (serverId: string): McpServerSnapshotEntry => ({
      definition: {
        serverId,
        displayName: serverId,
        transport: { kind: 'stdio', executable: process.execPath, args: [script] },
        secretBinding: { kind: 'none' },
      } as McpServerDefinitionInput,
      revision: 'r1',
      desired: 'enabled',
      trust: 'trusted',
    })
    const host = await testHost()
    const runtime = createMcpRowRuntime({ host, opener: realOpener() })

    const result = await runtime.apply([realEntry('a.b'), realEntry('a_b')])

    expect(result.skipped).toEqual([])
    expect(result.rowIds).toHaveLength(2)
    const dotName = `${mcpLocalToolPrefix('a.b')}read`
    const underscoreName = `${mcpLocalToolPrefix('a_b')}read`
    expect(dotName).not.toBe(underscoreName)
    // Confirms neither row was silently rolled back by E_REGISTRY_DUPLICATE (the failure mode this
    // fix eliminates, design §0.2) -- both real servers' tools are live in the same Host's shared
    // Kernel.tools registry at once, each under its own distinct name.
    await vi.waitFor(() => {
      expect(tool(host, dotName)).toBeDefined()
      expect(tool(host, underscoreName)).toBeDefined()
    })
    // Each tool is credited to its own row (distinct Cordis extension ids), not one shared/aliased
    // source -- confirming they are two genuinely separate, live registrations, not one row that
    // happened to answer to two names.
    expect(tool(host, dotName)?.source.trust).toBe('builtin')
    expect(tool(host, underscoreName)?.source.trust).toBe('builtin')
    expect(tool(host, dotName)?.source.source).not.toBe(tool(host, underscoreName)?.source.source)
  })
})

/** Offers `tools` verbatim, whatever their shape, the way an arbitrary third-party server might. */
function catalogOpener(tools: readonly unknown[]): McpServerOpener {
  return {
    async connect(definition) {
      const connection: McpConnection = {
        id: definition.serverId,
        async listTools() {
          return tools as Awaited<ReturnType<McpConnection['listTools']>>
        },
        async callTool() {
          return { content: [{ type: 'text' as const, text: 'ok' }] }
        },
        async close() {},
        onClose: () => () => undefined,
        onToolsChanged: () => () => undefined,
      }
      return connection
    },
  }
}

describe('a session MCP row whose catalog holds tools the model cannot be shown', () => {
  it('skips each bad tool with a code, keeps the server ready, and reports only what it registered', async () => {
    const host = await testHost()
    const statuses: unknown[] = []
    const runtime = createMcpRowRuntime({
      host,
      opener: catalogOpener([
        { name: 'ok', description: 'fine', inputSchema: { type: 'object' } },
        { name: 'medium', description: 'm'.repeat(2000), inputSchema: { type: 'object' } },
        { name: 'long', description: 'l'.repeat(5000), inputSchema: { type: 'object' } },
        { name: 'grown', description: '<|x|>'.repeat(800), inputSchema: { type: 'object' } },
        { name: 'badschema', description: 'bad schema', inputSchema: { type: 'object', properties: [] } },
        { name: 'numeric', description: 42, inputSchema: { type: 'object' } },
      ]),
      onStatus: (_serverId, status) => statuses.push(status),
    })
    const revision = 'a'.repeat(64)
    const result = await runtime.apply([entry('alpha', revision)])
    const status = result.statuses.get('alpha')
    expect(status).toMatchObject({
      connectionState: 'ready',
      toolCount: 2,
      skippedToolCount: 4,
      skippedTools: [
        { code: 'invalid-schema', name: 'badschema' },
        { code: 'description-too-long', name: 'grown' },
        { code: 'description-too-long', name: 'long' },
        { code: 'malformed', name: 'numeric' },
      ],
    })
    // The daemon's worker observation accepts a report only when every status passes this check.
    expect(validateResourceControlData('McpStatus', status).ok).toBe(true)
    for (const seen of statuses) expect(validateResourceControlData('McpStatus', seen).ok).toBe(true)
    const registered = host.kernel.tools
      .list()
      .map((t) => t.name)
      .filter((name) => name.startsWith(ALPHA_PREFIX))
      .sort()
    expect(registered).toEqual([`${ALPHA_PREFIX}medium`, `${ALPHA_PREFIX}ok`])
    const page = runtime.tools('alpha', revision)
    expect(page?.items.map((t) => t.name)).toEqual(['medium', 'ok'])
    expect(page?.items).toHaveLength(status?.toolCount ?? -1)
    expect(page?.catalogRevision).toBe(status?.catalogRevision)
  })

  it('reports a connection failure with an empty message as a valid status', async () => {
    const host = await testHost()
    const failing: McpServerOpener = {
      connect: async () => {
        throw ''
      },
    }
    const result = await createMcpRowRuntime({ host, opener: failing }).apply([entry('alpha')])
    const status = result.statuses.get('alpha')
    expect(status).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_CONNECT_FAILED', message: 'MCP connection failed' },
    })
    expect(validateResourceControlData('McpStatus', status).ok).toBe(true)
  })
})
