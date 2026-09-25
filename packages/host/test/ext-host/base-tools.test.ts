import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import {
  ecosystem as baseEcosystem,
  mcpCatalogHubFor,
  mcpLocalToolPrefix,
  mcpServerExtension,
} from '@agnes/base'
import { testFsPolicy } from '@agnes/core/testkit'
import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPosixPlatform, createWin32Platform } from '../../src/adapters/platform.js'
import { createTestHost } from '../../testkit/index.js'

// The package directory, not an import: host does not depend on @agnes/base, it loads what the
// profile names off disk.
const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-base-tools-'))
  dirs.push(d)
  return d
}
const callFork = (model: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    call: {
      toolUseId: '',
      name: 'subagent_fork',
      args: { question: 'answer independently', model },
      ordinal: 0,
    },
    via: 'native',
  },
  { type: 'done', reason: 'toolUse' },
]
const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]
const callCompact = (instructions?: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    call: {
      toolUseId: '',
      name: 'compact',
      args: instructions === undefined ? {} : { instructions },
      ordinal: 0,
    },
    via: 'native',
  },
  { type: 'done', reason: 'toolUse' },
]
const callSkill = (name: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    call: {
      toolUseId: '',
      name: 'skill_read',
      args: { name },
      ordinal: 0,
    },
    via: 'native',
  },
  { type: 'done', reason: 'toolUse' },
]
const callTool = (name: string, args: ToolCall['args'] = {}): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]

// Real-machine verification, "调用" layer (design 2026-09-23-mcp-tool-name-collision-design.md,
// STATUS "仍未做"): mcp-row-runtime.test.ts already proved two real MCP servers whose ids collide
// after sanitization both *register* successfully; this proves a real session/turn can actually
// *call* both, through the real tool-dispatch machinery (not a bare RegisteredTool.execute(), which
// E_EVENT_NAMESPACE refuses outside a session).
const baseRequire = createRequire(join(baseDir, 'package.json'))
const sdkPaths = {
  server: baseRequire.resolve('@modelcontextprotocol/sdk/server/index.js'),
  stdio: baseRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  types: baseRequire.resolve('@modelcontextprotocol/sdk/types.js'),
}

/** Writes a real MCP stdio server exposing one 'read' tool that answers with a distinguishing text,
 * so a reply built from both servers' real results proves neither call reached the other's process. */
function realOneToolServerScript(directory: string, resultText: string): string {
  const script = join(directory, `real-one-tool-mcp-${resultText}.mjs`)
  writeFileSync(
    script,
    [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      `const { Server } = require(${JSON.stringify(sdkPaths.server)})`,
      `const { StdioServerTransport } = require(${JSON.stringify(sdkPaths.stdio)})`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkPaths.types)})`,
      "const server = new Server({ name: 'real-one-tool-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })",
      "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read', description: 'read something', inputSchema: { type: 'object' } }] }))",
      `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: ${JSON.stringify(resultText)} }] }))`,
      'await server.connect(new StdioServerTransport())',
    ].join('\n'),
    'utf8',
  )
  return script
}
describe('a host assembled from a profile naming @agnes/base', () => {
  it.runIf(process.platform === 'win32')(
    'gives the Windows grant only to hooks-runner, never siblings or another package',
    async () => {
      const observed = new Map<string, boolean>()
      const { host } = await createTestHost({
        dataDir: scratch(),
        platform: createWin32Platform(),
        packageDirs: {
          '@agnes/base': baseDir,
          '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
        },
        profileInputs: { user: { name: 'local-dev', commandHooks: { trustedUnconfined: [] } } },
        packages: {
          '@agnes/code': {
            ecosystem: {
              'agnes/code-mode': (context) => {
                observed.set('agnes/code-mode', context.trustedHookCommands !== undefined)
                return async () => undefined
              },
            },
          },
          '@agnes/base': {
            ecosystem: {
              ...baseEcosystem,
              ...Object.fromEntries(
                ['agnes/hooks-runner', 'agnes/refine'].map((id) => [
                  id,
                  (context: Parameters<(typeof baseEcosystem)['agnes/hooks-runner']>[0]) => {
                    observed.set(id, context.trustedHookCommands !== undefined)
                    return baseEcosystem[id as keyof typeof baseEcosystem](context)
                  },
                ]),
              ),
            },
          },
        },
      })
      try {
        expect(observed).toEqual(
          new Map([
            ['agnes/hooks-runner', true],
            ['agnes/refine', false],
            ['agnes/code-mode', false],
          ]),
        )
      } finally {
        await host.close()
      }
    },
  )
  it('does not inject unconfined Hook authorization on POSIX, even for the exact factory', async () => {
    let hooks = false
    let sibling = false
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      platform: createPosixPlatform(),
      packageDirs: { '@agnes/base': baseDir },
      profileInputs: {
        user: { name: 'local-dev', commandHooks: { trustedUnconfined: [] } },
      },
      packages: {
        '@agnes/base': {
          ecosystem: {
            ...baseEcosystem,
            'agnes/hooks-runner': (context) => {
              hooks = context.trustedHookCommands !== undefined
              expect(context.trustedHookCommands).toBeUndefined()
              return baseEcosystem['agnes/hooks-runner'](context)
            },
            'agnes/refine': (context) => {
              sibling = context.trustedHookCommands !== undefined
              return baseEcosystem['agnes/refine'](context)
            },
          },
        },
      },
    })
    try {
      expect(hooks).toBe(false)
      expect(sibling).toBe(false)
    } finally {
      await host.close()
    }
  })
  it('exposes the fixed trajectory capability only to the exact privacy extension id', async () => {
    const dataDir = scratch()
    let privacyHasCapability = false
    let siblingHasCapability = false
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com' },
      trajectoryFetch: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
      packages: {
        '@agnes/base': {
          ecosystem: {
            ...baseEcosystem,
            'agnes/privacy': (context) => {
              privacyHasCapability = context.privacyTrajectory !== undefined
              return baseEcosystem['agnes/privacy'](context)
            },
            'agnes/refine': (context) => {
              siblingHasCapability = context.privacyTrajectory !== undefined
              return baseEcosystem['agnes/refine'](context)
            },
          },
        },
      },
    })
    try {
      expect(privacyHasCapability).toBe(true)
      expect(siblingHasCapability).toBe(false)
    } finally {
      await host.close()
    }
  })

  it('loads bundled tools, including the compaction request surface', async () => {
    const { host } = await createTestHost({
      dataDir: scratch(),
      packageDirs: { '@agnes/base': baseDir },
    })
    try {
      // Nothing in this test registered a tool. The only way these names reach the kernel is the
      // delivery path: profile names the package, the package declares the extension, the host
      // reads its manifest and calls its entry.
      expect(host.kernel.tools.resolve('read')?.name).toBe('read')
      expect(host.kernel.tools.resolve('shell')?.name).toBe('shell')
      expect(host.kernel.tools.resolve('read')?.source).toEqual({
        source: 'agnes/tools-core',
        trust: 'builtin',
      })
      // grep/find/ls moved to the sibling `tools-search` extension; they still reach the kernel
      // registry the same way, just credited to a different source.
      expect(host.kernel.tools.resolve('grep')?.source).toEqual({
        source: 'agnes/tools-search',
        trust: 'builtin',
      })
      expect(host.kernel.tools.resolve('compact')?.source).toEqual({
        source: 'agnes/compaction',
        trust: 'builtin',
      })
      // agnes/refine ships harness_propose (base plan Task 18); the trusted ecosystem factory binds
      // it to the same durable queue consumed by the assembled Task 19 operation.
      expect(host.kernel.tools.resolve('harness_propose')?.source).toEqual({
        source: 'agnes/refine',
        trust: 'builtin',
      })
      expect(host.kernel.tools.resolve('subagent_spawn')?.source).toEqual({
        source: 'agnes/subagent',
        trust: 'builtin',
      })
      const status = host.extensions()
      // `host.extensions()` reports insertion order. Row-backed extensions load in the order
      // the Host lists its `ext:` rows, including the Skills row.
      // hooks-runner and privacy moved onto rows in stage 2a (D98); agnes/mcp-search took
      // agnes/mcp-client's place in MCP rows step 4 as a builtin row of its own (D123). computer-use joined the
      // rows after subagent when the local-dev profile enabled it by default.
      expect(status.map((s) => s.id)).toEqual([
        'agnes/tools-core',
        'agnes/tools-search',
        'agnes/tools-web',
        'agnes/compaction',
        'agnes/refine',
        'agnes/subagent',
        'agnes/computer-use',
        'agnes/hooks-runner',
        'agnes/privacy',
        'agnes/mcp-search',
        'agnes/skills',
      ])
      const byId = (id: string) => status.find((entry) => entry.id === id)
      const skills = byId('agnes/skills')
      const core = byId('agnes/tools-core')
      const search = byId('agnes/tools-search')
      const web = byId('agnes/tools-web')
      const compaction = byId('agnes/compaction')
      const refine = byId('agnes/refine')
      const subagent = byId('agnes/subagent')
      const computerUse = byId('agnes/computer-use')
      const hooksRunner = byId('agnes/hooks-runner')
      const privacy = byId('agnes/privacy')
      const mcpSearch = byId('agnes/mcp-search')
      expect(web?.loaded).toBe(true)
      expect(core?.loaded).toBe(true)
      expect(search?.loaded).toBe(true)
      expect(compaction?.loaded).toBe(true)
      expect(refine?.loaded).toBe(true)
      expect(subagent?.loaded).toBe(true)
      expect(computerUse?.loaded).toBe(true)
      expect(mcpSearch?.loaded).toBe(true)
      expect(hooksRunner?.loaded).toBe(true)
      expect(privacy?.loaded).toBe(true)
      expect(skills?.loaded).toBe(true)
      // ExtensionStatus (the managed ext host) does not carry a `registered` tool-name list the way
      // the legacy ExtStatus did - kernel.registrations() deliberately excludes tools (ToolRegistry
      // has no registrations(source) of its own; see Kernel.registrations()'s own comment), so the
      // per-source tool names this used to read off `status` are read directly off the registry
      // instead, which is the actual source of truth these names always came from.
      const namesFrom = (id: string) =>
        [...host.kernel.tools.snapshot(0).byName.values()]
          .filter((t) => t.source.source === id)
          .map((t) => t.name)
          .sort()
      expect(namesFrom('agnes/tools-core')).toEqual(['edit', 'read', 'shell', 'todo', 'write'])
      expect(namesFrom('agnes/tools-search')).toEqual(['find', 'grep', 'ls'])
      expect(namesFrom('agnes/tools-web')).toEqual(['web_fetch'])
      expect(namesFrom('agnes/compaction')).toEqual(['compact'])
      expect(namesFrom('agnes/refine')).toEqual(['harness_propose'])
      expect(namesFrom('agnes/subagent')).toEqual([
        'subagent_cancel',
        'subagent_collect',
        'subagent_fork',
        'subagent_spawn',
      ])
      expect(namesFrom('agnes/mcp-search')).toEqual(['tool_describe', 'tool_search'])
    } finally {
      await host.close()
    }
  })

  it('searches a catalogued Skill through the assembled Host and activates it by name', async () => {
    const dataDir = scratch()
    const resourceId = `skill/user/user-agnes/${'a'.repeat(64)}`
    const read = vi.fn((id: string) =>
      id === resourceId
        ? { ok: true as const, content: 'Use the review steps.' }
        : { ok: false as const, code: 'NOT_FOUND' as const },
    )
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        (request) => {
          expect(request.system).toContain('call skill_read with that skill name')
          expect(request.system).toContain('review\tReview a change set.')
          expect(request.system).not.toContain(resourceId)
          expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeDefined()
          expect(request.tools.find((tool) => tool.name === 'skill_read')).toMatchObject({
            description: expect.stringContaining('when the user names a Skill or the current task matches'),
            parameters: {
              properties: {
                name: { description: 'Exact skill name from available_skills or tool_search.' },
              },
            },
          })
          expect(read).not.toHaveBeenCalled()
          return callTool('tool_search', { query: 'review', limit: 1 })
        },
        (request) => {
          expect(JSON.stringify(request.messages)).toContain('Skill review — Review a change set.')
          expect(read).not.toHaveBeenCalled()
          return callSkill('review')
        },
        (request) => {
          expect(JSON.stringify(request.messages)).toContain('Use the review steps.')
          return say('I found and read the requested Skill.')
        },
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
      skillResources: {
        list: () => [
          {
            kind: 'skill',
            resourceId,
            name: 'review',
            description: 'Review a change set.',
            revision: 'b'.repeat(64),
            sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'c'.repeat(64) },
            priority: 400,
            resolution: { winner: true, shadowed: [] },
            trust: 'trusted',
            desired: 'enabled',
            actual: 'ready',
            stale: false,
          },
        ],
        read,
        readFile: () => ({ ok: false, code: 'NOT_FOUND' as const }),
      },
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Can you find my listed Skill?' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({
        reason: 'completed',
      })
      const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq })
      expect(
        rows.some((row) => row.type === 'tool/call' && (row.data as { name?: string }).name === 'skill_read'),
      ).toBe(true)
      expect(provider.calls).toHaveLength(3)
      expect(read).toHaveBeenCalledExactlyOnceWith(resourceId, expect.anything())
      expect(JSON.stringify(provider.calls[2]?.messages)).toContain('Use the review steps.')
      expect(provider.calls[0]?.tools.map((tool) => tool.name)).toContain('skill_read')
    } finally {
      await host.close()
    }
  })

  it('ships eager MCP tools directly to the provider without requiring tool_search', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        (request) => {
          expect(request.tools.find((tool) => tool.name === `${mcpLocalToolPrefix('gh')}echo`)).toMatchObject(
            {
              description: 'Echo text.',
            },
          )
          return say('The eager MCP tool is directly available.')
        },
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
    })
    // An MCP server is a Host row of its own (stage 2b, D102/D107'): mount one the way the session
    // worker does, with a connection that offers one eager (non-deferred) tool.
    const extensionId = 'agnes/mcp-gh-0000abcd'
    const dynamic = {
      spec: {
        id: extensionId,
        package: '@agnes/base',
        packageVersion: '0.0.0',
        dir: '',
        trust: 'builtin' as const,
        enabled: true,
        revision: 'r1',
      },
      manifest: {
        id: extensionId,
        version: '0.1.0',
        apiRange: '^1.0',
        entry: './index.mjs',
        capabilities: { tools: { prefix: mcpLocalToolPrefix('gh') }, resources: ['mcp' as const] },
      },
      factory: (ctx: Parameters<typeof mcpCatalogHubFor>[0]) =>
        mcpServerExtension(
          { id: 'gh', transport: 'stdio', cmd: ['x'], defer: false },
          {
            catalogHub: mcpCatalogHubFor(ctx),
            connect: async () => ({
              id: 'gh',
              async listTools() {
                return [
                  {
                    name: 'echo',
                    description: 'Echo text.',
                    inputSchema: { type: 'object' },
                    annotations: { readOnlyHint: true },
                  },
                ]
              },
              async callTool() {
                return { content: [] }
              },
              async close() {},
            }),
          },
        ),
    }
    await host.extensionRows.apply([
      ...host.extensionRows.current(),
      host.extensionRows.prepare({ extensionId, dynamic }),
    ])
    await vi.waitFor(() => expect(host.kernel.tools.resolve(`${mcpLocalToolPrefix('gh')}echo`)).toBeDefined())
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Use the echo MCP tool.' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })
      expect(provider.calls).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  it('a real session actually calls both tools of two real MCP servers whose ids collide after sanitization', async () => {
    // The exact reported scenario ("a.b"/"a_b" both sanitize to "a_b") -- mcp-row-runtime.test.ts
    // already proves both real servers *register* successfully; this proves a real session/turn can
    // genuinely *call* both through the real tool-dispatch machinery, not a bare
    // RegisteredTool.execute() (refused with E_EVENT_NAMESPACE outside a session).
    const dataDir = scratch()
    const dotName = `${mcpLocalToolPrefix('a.b')}read`
    const underscoreName = `${mcpLocalToolPrefix('a_b')}read`
    expect(dotName).not.toBe(underscoreName)
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [callTool(dotName), callTool(underscoreName), say('both tools called')],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
    })
    const scriptDir = scratch()
    const dotScript = realOneToolServerScript(scriptDir, 'REAL_A_DOT_B')
    const underscoreScript = realOneToolServerScript(scriptDir, 'REAL_A_UNDERSCORE_B')
    for (const [index, [serverId, script]] of (
      [
        ['a.b', dotScript],
        ['a_b', underscoreScript],
      ] as const
    ).entries()) {
      const extensionId = `agnes/mcp-real-${index}`
      const dynamic = {
        spec: {
          id: extensionId,
          package: '@agnes/base',
          packageVersion: '0.0.0',
          dir: '',
          trust: 'builtin' as const,
          enabled: true,
          revision: 'r1',
        },
        manifest: {
          id: extensionId,
          version: '0.1.0',
          apiRange: '^1.0',
          entry: './index.mjs',
          capabilities: { tools: { prefix: mcpLocalToolPrefix(serverId) }, resources: ['mcp' as const] },
        },
        // deps.connect is omitted -- mcpServerExtension defaults it to the real connectMcp(), so
        // this is a real stdio subprocess, not a hand-rolled McpConnection.
        factory: (ctx: Parameters<typeof mcpCatalogHubFor>[0]) =>
          mcpServerExtension(
            { id: serverId, transport: 'stdio', cmd: [process.execPath, script], defer: false },
            { catalogHub: mcpCatalogHubFor(ctx) },
          ),
      }
      await host.extensionRows.apply([
        ...host.extensionRows.current(),
        host.extensionRows.prepare({ extensionId, dynamic }),
      ])
    }
    await vi.waitFor(() => {
      expect(host.kernel.tools.resolve(dotName)).toBeDefined()
      expect(host.kernel.tools.resolve(underscoreName)).toBeDefined()
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Call both MCP read tools and report both results.' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })
      // Three real inference round-trips: call dotName, call underscoreName, final text.
      expect(provider.calls).toHaveLength(3)
      const timeline = JSON.stringify(await session.projectUI(undefined, { surface: 'web' }))
      // Both real subprocesses' own, distinct results reached the model -- proving the session
      // dispatched each call to its own real server, not to the other one or to neither.
      expect(timeline).toContain('REAL_A_DOT_B')
      expect(timeline).toContain('REAL_A_UNDERSCORE_B')
    } finally {
      await host.close()
    }
  })

  it('runs the package-owned default compaction plan through production host assembly', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        say('old one'),
        say('old two'),
        callCompact('retain the assembly proof'),
        say('ASSEMBLED SUMMARY'),
        say('after compaction'),
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          model: { route: { primary: 'default', compaction: 'default' } },
          // The kept window holds the prompt that asked for compaction with its call and result: the
          // call's arguments count toward it, so a smaller window would cut at the call instead and
          // summarize that prompt as a separate turn prefix (a second summary request).
          compaction: { enabled: true, reserve_tokens: 16384, keep_recent_tokens: 18, agent_callable: true },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      expect(session.compaction.runnable).toBe(true)
      for (const prompt of ['first turn', 'second turn', 'compact now']) {
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: prompt }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).resolves.toMatchObject({ reason: 'completed' })
      }

      expect(provider.calls.map((request) => request.kind)).toEqual([
        'inference',
        'inference',
        'inference',
        'summary',
        'inference',
      ])
      expect(provider.calls[2]?.tools.map((tool) => tool.name)).toContain('compact')
      expect(provider.calls[3]).toMatchObject({ kind: 'summary', slot: 'compaction' })

      const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq })
      const replacements = rows.filter((row) => typeof row.surfaceOp === 'object')
      expect(replacements).toHaveLength(1)
      expect(replacements[0]?.data).toMatchObject({
        content: [{ type: 'text', text: 'ASSEMBLED SUMMARY' }],
      })
      expect(rows.some((row) => row.type === 'x/core/compaction-begin')).toBe(true)
      expect(rows.some((row) => row.type === 'x/core/compaction-end')).toBe(true)
      expect(
        rows.some(
          (row) => row.type === 'cost/ledger' && (row.data as { purpose?: string }).purpose === 'compaction',
        ),
      ).toBe(true)
    } finally {
      await host.close()
    }
  })

  it('disposes them on close, leaving the registry empty', async () => {
    const { host } = await createTestHost({
      dataDir: scratch(),
      packageDirs: { '@agnes/base': baseDir },
    })
    // The skills extension is loaded but inert until a daemon worker supplies a private runtime
    // snapshot. An empty resource-control view must not alter the legacy Host tool surface.
    // Seventeen plus the computer-use tool the default enabled profile now mounts as a row.
    expect(host.kernel.tools.size).toBe(18)
    expect(host.kernel.tools.resolve('computer_use')).toMatchObject({ name: 'computer_use' })
    expect(host.kernel.tools.resolve('subagent_cancel')).toMatchObject({ name: 'subagent_cancel' })
    await host.close()
    expect(host.kernel.tools.size).toBe(0)
    expect(host.extensions().every((s) => !s.loaded)).toBe(true)
  })

  it('opens through Kernel and managed privacy, then commits resolved consent to the real ledger', async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: ANON\n')
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
    })
    try {
      expect(host.kernel.sessions.size).toBe(0)
      const session = await host.createSession({ cwd: dataDir, key: 'privacy-start' })
      expect(host.kernel.get(session.key)).toBe(session)
      const rows = await session.scan({ type: 'x/agnes/privacy/consent', toSeq: session.lastSeq })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toEqual({
        from: 'DISABLED',
        to: 'ANON',
        by: 'profile:standard',
      })
    } finally {
      await host.close()
    }
  })

  it('uploads the real session ledger through managed privacy on shutdown', async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: ANON\n')
    const requests: Array<[URL, RequestInit]> = []
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: {
        AGNES_TRACE_ENDPOINT: 'https://trace.example',
        AGNES_TRACE_ALLOWED_ORIGINS: 'https://trace.example',
      },
      trajectoryFetch: (async (input, init) => {
        requests.push([input as URL, init ?? {}])
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: 'trajectory-real-host' })
      await session.append([
        {
          type: 'user/message',
          actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
          origin: 'principal',
          trust: 'trusted',
          data: { content: [{ type: 'text', text: `mail alice@example.com from ${dataDir}/secret` }] },
        },
      ])
      await session.close()

      expect(requests).toHaveLength(1)
      const [url, init] = requests[0] as [URL, RequestInit]
      expect(url.href).toBe('https://trace.example/api/v1/agent-traces/sessions/trajectory-real-host')
      expect(init.redirect).toBe('error')
      const body = new TextDecoder().decode(init.body as ArrayBuffer)
      expect(body).toContain('[REDACTED:email]')
      expect(body).not.toContain('alice@example.com')
      expect(body).toContain('<workspace>/secret')
      expect(body).not.toContain(`${dataDir}/secret`)
      expect(init.headers).toMatchObject({
        'X-Agnes-Harness': 'agnes/0.1.0',
        'X-Agnes-Trace-Consent': 'ANON',
        'X-Agnes-Trace-Digest': createHash('sha256')
          .update(new Uint8Array(init.body as ArrayBuffer))
          .digest('hex'),
      })
      const reopened = await host.createSession({ cwd: dataDir, key: 'trajectory-real-host' })
      const receipts = await reopened.scan({
        type: 'x/agnes/privacy/egress',
        toSeq: reopened.lastSeq,
      })
      expect(receipts).toHaveLength(1)
      expect(receipts[0]?.data).toMatchObject({ consent: 'ANON' })
      await reopened.append([
        {
          type: 'user/message',
          actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
          origin: 'principal',
          trust: 'trusted',
          data: { content: [{ type: 'text', text: 'second lifecycle' }] },
        },
      ])
      await reopened.close()
      const third = await host.createSession({ cwd: dataDir, key: 'trajectory-real-host' })
      const chained = await third.scan({ type: 'x/agnes/privacy/egress', order: 'asc', limit: 10 })
      expect(chained).toHaveLength(2)
      expect((chained[1]?.data as { prev?: unknown } | undefined)?.prev).toBe(
        (chained[0]?.data as { chain?: unknown } | undefined)?.chain,
      )
      expect(requests).toHaveLength(2)
      await third.close()
    } finally {
      await host.close()
    }
  })

  it('keeps disabled production trajectory at zero network on shutdown', async () => {
    const dataDir = scratch()
    const trajectoryFetch = vi.fn(async () => new Response(null, { status: 204 }))
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: {
        AGNES_TRACE_ENDPOINT: 'https://trace.example',
        AGNES_TRACE_ALLOWED_ORIGINS: 'https://trace.example',
      },
      trajectoryFetch: trajectoryFetch as typeof fetch,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: 'trajectory-disabled' })
      await session.close()
      expect(trajectoryFetch).not.toHaveBeenCalled()
    } finally {
      await host.close()
    }
  })

  it('requires operator authorization for a non-default trajectory origin', async () => {
    await expect(
      createTestHost({
        dataDir: scratch(),
        packageDirs: { '@agnes/base': baseDir },
        env: { AGNES_TRACE_ENDPOINT: 'https://trace.example' },
        trajectoryFetch: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow('not authorized by AGNES_TRACE_ALLOWED_ORIGINS')
  })

  it.each([
    [{ address: '169.254.169.254', family: 4 as const }],
    [{ address: '::ffff:a9fe:a9fe', family: 6 as const }],
    [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.4', family: 4 as const },
    ],
  ])('blocks private or rebinding DNS answers on the real Host path', async (...answers) => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: ANON\n')
    const resolver = vi.fn(async () => answers)
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: {
        AGNES_TRACE_ENDPOINT: 'https://trace.example',
        AGNES_TRACE_ALLOWED_ORIGINS: 'https://trace.example',
      },
      trajectoryResolver: resolver,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: `blocked-${answers.length}` })
      await session.close()
      expect(resolver).toHaveBeenCalledWith('trace.example', expect.any(AbortSignal))
      const reopened = await host.createSession({ cwd: dataDir, key: `blocked-${answers.length}` })
      expect(await reopened.scan({ type: 'x/agnes/privacy/egress', limit: 5 })).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('does not commit a receipt when the fixed endpoint returns a redirect', async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: FULL\n')
    const request = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    )
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com' },
      trajectoryFetch: request as typeof fetch,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: 'redirect-refused' })
      await session.close()
      expect(request).toHaveBeenCalledTimes(1)
      const reopened = await host.createSession({ cwd: dataDir, key: 'redirect-refused' })
      expect(await reopened.scan({ type: 'x/agnes/privacy/egress', limit: 5 })).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('bounds and cancels an error response on the Host upload path', async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: FULL\n')
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_096).fill(120))
      },
      cancel() {
        cancelled = true
      },
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com' },
      trajectoryFetch: (async () => new Response(body, { status: 503 })) as typeof fetch,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: 'bounded-error' })
      await session.close()
      expect(cancelled).toBe(true)
      const reopened = await host.createSession({ cwd: dataDir, key: 'bounded-error' })
      expect(await reopened.scan({ type: 'x/agnes/privacy/egress', limit: 5 })).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('aborts an in-flight Host upload when the shutdown hook deadline expires', async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dataDir, 'profiles', 'local-dev', 'consent.yaml'), 'telemetry:\n  consent: FULL\n')
    let aborted = false
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
    )
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com' },
      trajectoryFetch: request as typeof fetch,
    })
    try {
      const session = await host.createSession({ cwd: dataDir, key: 'shutdown-abort' })
      await session.close()
      expect(request).toHaveBeenCalledTimes(1)
      expect(aborted).toBe(true)
      const reopened = await host.createSession({ cwd: dataDir, key: 'shutdown-abort' })
      expect(await reopened.scan({ type: 'x/agnes/privacy/egress', limit: 5 })).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('runs subagent_fork with a published model id through the assembled host and core', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [callFork('m1'), say('child answer'), say('parent answer')],
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      treeBudgetCredits: 100,
      provider,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          model: { route: { primary: 'default' } },
          subagent: { tree_budget_credits: 100 },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'delegate this once' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })

      const result = (await session.scan({ type: 'tool/result', limit: 5 }))[0]?.data as
        | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
        | undefined
      expect(result?.content?.[0]?.text).toBe('child answer')
      expect(result).toMatchObject({ isError: false })
      expect(provider.calls[1]).toMatchObject({ route: 'gw', model: 'm1' })
    } finally {
      await host.close()
    }
  })

  it('injects the assembled sandbox into hooks-runner instead of exposing raw host exec', async () => {
    const dataDir = scratch()
    writeFileSync(
      join(dataDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: './deny.sh' }] }],
        },
      }),
    )
    const exec = vi.fn(async (argv: string[]) => ({
      code: argv[1] === './deny.sh' ? 2 : 0,
      stdout: '',
      stderr: 'blocked by assembled sandbox',
      truncated: false,
    }))
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      seams: {
        sandbox: {
          exec,
          fsPolicy: () => {
            const policy = testFsPolicy('/workspace')
            const workspaceRoot = realpathSync.native(dataDir)
            const rules = policy.rules.map((rule) => ({
              ...rule,
              path: join(workspaceRoot, ...rule.path.slice(policy.workspaceRoot.length).split('/')),
            }))
            const content = { ...policy, workspaceRoot, rules }
            return { ...content, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
          },
          enforcement: () => ({ level: 'full', scope: ['process'] }),
        },
      },
    })
    try {
      expect(host.extensions().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
        loaded: true,
      })
      expect(host.kernel.hooks.snapshot().entries('tool_call')).toHaveLength(1)
      const session = await host.createSession({ cwd: dataDir })
      const payload = {
        toolUseId: 'tool-1',
        name: 'shell',
        args: { command: 'rm -rf /' },
        meta: {
          isReadOnly: false,
          isDestructive: true,
          isConcurrencySafe: false,
          isOpenWorld: true,
          replay: 'never',
          costHint: undefined,
          deferLoading: false,
          requiresApproval: 'destructive',
        },
        actor: session.d.actor,
        taint: false,
        resolvedPolicy: {
          isReadOnly: false,
          isDestructive: true,
          replay: 'never',
          requiresApproval: 'destructive',
          approvalScopes: [] as string[],
          policyVersion: 'static-v1',
        },
        executionDomain: 'workspace',
        definitionFingerprint: 'a'.repeat(64),
        policyHash: 'b'.repeat(64),
      } as const
      const verdict = await session.hooks.toolCall(payload)
      expect(exec).toHaveBeenCalledWith(
        ['$SHELL', './deny.sh'],
        expect.objectContaining({
          cwd: realpathSync.native(dataDir),
          stdin: expect.stringContaining('"hook_event_name":"PreToolUse"'),
        }),
      )
      expect(verdict).toEqual({ allow: false, reason: 'blocked by assembled sandbox' })
    } finally {
      await host.close()
    }
  })

  it('registers nothing when the profile packages are not on disk', async () => {
    const { host } = await createTestHost({ dataDir: scratch() })
    try {
      expect(host.extensions()).toEqual([])
      expect(host.kernel.tools.size).toBe(0)
    } finally {
      await host.close()
    }
  })
})
