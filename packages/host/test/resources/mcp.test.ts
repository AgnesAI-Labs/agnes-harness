import { describe, expect, it, vi } from 'vitest'
import { createExtensionActivationBarrier } from '../../src/ext-host/activation-barrier.js'
import type { McpConnection, McpManagedInput, McpServerConfig } from '../../src/resources/mcp.js'
import { createMcpResourceManager } from '../../src/resources/mcp.js'

const revision = (letter: string) => letter.repeat(64)
const definition = (overrides: Record<string, unknown> = {}) => ({
  serverId: 'github',
  displayName: 'GitHub',
  transport: { kind: 'stdio' as const, executable: 'mcp-github', args: ['--stdio'] },
  secretBinding: { kind: 'stdio-env' as const, env: { TOKEN: 'secret://github/token' } },
  toolPolicy: { allow: ['issues'] },
  ...overrides,
})
const managed = (overrides: Partial<McpManagedInput> = {}): McpManagedInput => ({
  definition: definition(),
  revision: revision('a'),
  desired: 'enabled',
  trust: 'trusted',
  ...overrides,
})
const connection = (id = 'github'): McpConnection => ({
  id,
  listTools: vi.fn(async () => [
    {
      name: 'issues',
      description: 'List issues',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'admin',
      description: 'Admin tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]),
  callTool: vi.fn(async () => ({ content: [] })),
  close: vi.fn(async () => undefined),
})

function setup(
  connect: (config: McpServerConfig) => Promise<McpConnection>,
  httpPolicy?: { localDaemon?: boolean; allowLoopbackHttp?: boolean },
  profile = 'local',
) {
  const apply = vi.fn(async () => undefined)
  const manager = createMcpResourceManager({
    barrier: createExtensionActivationBarrier(),
    profile,
    credentials: vi.fn(async () => 'credential-test-marker'),
    baseEnvironment: { PATH: '/host/bin', HOME: '/host/home', NODE_OPTIONS: '--blocked' },
    stdioPolicy: { allowedExecutables: ['mcp-github'] },
    ...(httpPolicy ? { httpPolicy } : {}),
    connect,
    inspectCatalog: async (conn, config) =>
      (await conn.listTools()).filter((tool) => config.allowedTools?.includes(tool.name) ?? false),
    apply,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  })
  return { apply, manager }
}

describe('MCP resource manager', () => {
  it.each(['C:\\Program Files\\PowerShell\\7\\PWSH.EXE', '/bin/BaSh', 'C:/Tools/CMD.exe'])(
    'refuses an allowlisted shell path before resolving credentials or connecting: %s',
    async (executable) => {
      const credentials = vi.fn(async () => 'unused')
      const connect = vi.fn(async () => connection())
      const manager = createMcpResourceManager({
        barrier: createExtensionActivationBarrier(),
        profile: 'local',
        credentials,
        stdioPolicy: { allowedExecutables: [executable] },
        connect,
        inspectCatalog: async () => [],
        apply: async () => undefined,
      })
      const item = managed({ definition: definition({ transport: { kind: 'stdio', executable, args: [] } }) })
      manager.stage(item)
      await expect(
        manager.reconcile({
          profile: 'local',
          serverId: 'github',
          definition: item.definition,
          enabled: true,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })
      expect(credentials).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      await manager.close()
    },
  )

  it.each(['http-bearer', 'http-header'] as const)(
    'rejects NUL in resolved %s before invoking the transport',
    async (kind) => {
      const connect = vi.fn(async () => connection('remote'))
      const manager = createMcpResourceManager({
        barrier: createExtensionActivationBarrier(),
        profile: 'local',
        credentials: async () => 'credential-test-marker\0',
        stdioPolicy: { allowedExecutables: [] },
        connect,
        inspectCatalog: async () => [],
        apply: async () => undefined,
      })
      const item = managed({
        definition: {
          serverId: 'remote',
          displayName: 'Remote',
          transport: { kind: 'http', url: 'https://example.test/mcp' },
          secretBinding:
            kind === 'http-bearer'
              ? { kind, credentialRef: 'secret://remote/key' }
              : { kind, headerName: 'x-api-key', credentialRef: 'secret://remote/key' },
        },
      })
      manager.stage(item)
      const result = await manager.reconcile({
        profile: 'local',
        serverId: 'remote',
        definition: item.definition,
        enabled: true,
        signal: new AbortController().signal,
      })
      expect(result.error?.code).toBe('MCP_CONNECT_FAILED')
      expect(connect).not.toHaveBeenCalled()
      expect(JSON.stringify({ result, descriptors: manager.list() })).not.toContain('credential-test-marker')
      await manager.close()
    },
  )

  it('does not open a transport when cancellation occurs during credential resolution', async () => {
    const controller = new AbortController()
    const connect = vi.fn(async () => connection('remote'))
    const manager = createMcpResourceManager({
      barrier: createExtensionActivationBarrier(),
      profile: 'local',
      credentials: async () => {
        controller.abort()
        return 'credential-test-marker'
      },
      stdioPolicy: { allowedExecutables: [] },
      connect,
      inspectCatalog: async () => [],
      apply: async () => undefined,
    })
    const item = managed({
      definition: {
        serverId: 'remote',
        displayName: 'Remote',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
        secretBinding: { kind: 'http-bearer', credentialRef: 'secret://remote/key' },
      },
    })
    manager.stage(item)
    const result = await manager.reconcile({
      profile: 'local',
      serverId: 'remote',
      definition: item.definition,
      enabled: true,
      signal: controller.signal,
    })
    expect(result.error?.code).toBe('MCP_CONNECT_FAILED')
    expect(connect).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('credential-test-marker')
    await manager.close()
  })

  it('closes the candidate without applying when cancellation wins after catalog inspection', async () => {
    const controller = new AbortController()
    const candidate = connection()
    const apply = vi.fn(async () => undefined)
    const manager = createMcpResourceManager({
      barrier: createExtensionActivationBarrier(),
      profile: 'local',
      credentials: async () => 'credential-test-marker',
      stdioPolicy: { allowedExecutables: ['mcp-github'] },
      connect: async () => candidate,
      inspectCatalog: async () => {
        controller.abort()
        return candidate.listTools()
      },
      apply,
    })
    const item = managed()
    manager.stage(item)
    const result = await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: controller.signal,
    })
    expect(result.error?.code).toBe('MCP_CONNECT_FAILED')
    expect(apply).not.toHaveBeenCalled()
    expect(manager.snapshot().list()).toEqual([])
    expect(candidate.close).toHaveBeenCalledOnce()
  })

  it('rejects a managed catalog schema outside the bounded wire envelope before ready', async () => {
    const candidate = connection()
    candidate.listTools = vi.fn(async () => [
      {
        name: 'issues',
        description: 'List issues',
        inputSchema: {
          type: 'object',
          properties: [],
          additionalProperties: false,
        },
      },
    ])
    const { apply, manager } = setup(async () => candidate)
    const item = managed()
    manager.stage(item)
    const result = await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(result.error?.code).toBe('MCP_CONNECT_FAILED')
    expect(result.status.connectionState).toBe('unavailable')
    expect(apply).not.toHaveBeenCalled()
    expect(candidate.close).toHaveBeenCalledOnce()
  })

  it('runs test as a short-lived strict candidate without activation or registration', async () => {
    const transient = connection()
    const { apply, manager } = setup(async () => transient)
    const item = managed()
    manager.stage(item)

    await expect(
      manager.test({
        profile: 'local',
        serverId: 'github',
        definition: item.definition,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ toolCount: 1, catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(apply).not.toHaveBeenCalled()
    expect(manager.snapshot().list()).toEqual([])
    expect(transient.callTool).not.toHaveBeenCalled()
    expect(transient.close).toHaveBeenCalledTimes(1)
  })

  it('binds resolved stdio credentials at connect time, applies filtered health catalog atomically, and swaps connections once', async () => {
    const first = connection()
    const second = connection()
    const seen: McpServerConfig[] = []
    const { apply, manager } = setup(async (config) => {
      seen.push(config)
      return seen.length === 1 ? first : second
    })
    const item = managed()
    manager.stage(item)
    const request = {
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    }

    await expect(manager.reconcile(request)).resolves.toMatchObject({
      status: { connectionState: 'ready', toolCount: 1 },
      tools: { items: [{ name: 'issues' }] },
    })
    expect(seen[0]).toMatchObject({
      cmd: ['mcp-github', '--stdio'],
      baseEnv: { PATH: '/host/bin', HOME: '/host/home' },
      env: { TOKEN: 'credential-test-marker' },
      allowedTools: ['issues'],
    })
    expect(seen[0]?.baseEnv).not.toHaveProperty('NODE_OPTIONS')
    const oldTurn = manager.snapshot()
    await expect(manager.reconnect({ ...request, enabled: undefined } as never)).resolves.toMatchObject({
      status: { connectionState: 'ready' },
    })
    expect(oldTurn.list()[0]?.connection).toBe(first)
    expect(manager.snapshot().list()[0]?.connection).toBe(second)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('retains the active catalog if a reconnect health check fails and exposes only a safe error', async () => {
    const live = connection()
    const failing = connection()
    failing.listTools = vi.fn(async () => {
      throw new Error('stderr /private/path credential-test-marker')
    })
    let calls = 0
    const { manager } = setup(async () => (++calls === 1 ? live : failing))
    const item = managed()
    manager.stage(item)
    const request = {
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    }
    await manager.reconcile(request)
    const held = manager.snapshot()

    const result = await manager.reconnect({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      status: { connectionState: 'ready', toolCount: 1 },
      error: { code: 'MCP_CONNECT_FAILED' },
    })
    expect(JSON.stringify(result)).not.toContain('credential-test-marker')
    expect(JSON.stringify(result)).not.toContain('/private/path')
    expect(held.list()[0]?.connection).toBe(live)
    expect(manager.snapshot().list()[0]?.connection).toBe(live)
    expect(failing.close).toHaveBeenCalledTimes(1)
    expect(live.close).not.toHaveBeenCalled()
  })

  it('keeps an unrelated server active when a second server candidate cannot connect', async () => {
    const github = connection('github')
    const { manager } = setup(async (config) => {
      if (config.id === 'github') return github
      throw new Error('gitlab candidate unavailable')
    })
    const githubItem = managed()
    const gitlabItem = managed({
      definition: definition({
        serverId: 'gitlab',
        displayName: 'GitLab',
        transport: { kind: 'stdio', executable: 'mcp-github', args: ['--gitlab'] },
      }),
    })
    manager.stage(githubItem)
    manager.stage(gitlabItem)
    await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: githubItem.definition,
      enabled: true,
      signal: new AbortController().signal,
    })

    const failed = await manager.reconcile({
      profile: 'local',
      serverId: 'gitlab',
      definition: gitlabItem.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(failed.error?.code).toBe('MCP_CONNECT_FAILED')
    expect(manager.status('github')).toMatchObject({
      connectionState: 'ready',
      observedRevision: revision('a'),
    })
    expect(
      manager
        .snapshot()
        .list()
        .find((server) => server.config.id === 'github')?.connection,
    ).toBe(github)
    expect(github.close).not.toHaveBeenCalled()
  })

  it.each(['http-bearer', 'http-header'] as const)(
    'supports %s injection and disables through the barrier before close',
    async (kind) => {
      const live = connection('remote')
      const captured: McpServerConfig[] = []
      const { apply, manager } = setup(async (config) => {
        captured.push(config)
        return live
      })
      const item = managed({
        definition: definition({
          serverId: 'remote',
          displayName: 'Remote',
          transport: { kind: 'http', url: 'https://example.test/mcp' },
          secretBinding:
            kind === 'http-bearer'
              ? { kind, credentialRef: 'secret://remote/key' }
              : { kind, headerName: 'x-api-key', credentialRef: 'secret://remote/key' },
        }),
        revision: revision('b'),
      })
      manager.stage(item)
      await manager.reconcile({
        profile: 'local',
        serverId: 'remote',
        definition: item.definition,
        enabled: true,
        signal: new AbortController().signal,
      })
      expect(captured[0]).toMatchObject({
        transport: 'http',
        headers:
          kind === 'http-bearer'
            ? { authorization: ['Bearer', 'credential-test-marker'].join(' ') }
            : { 'x-api-key': 'credential-test-marker' },
      })
      expect(JSON.stringify(manager.status('remote'))).not.toContain('credential-test-marker')
      await manager.reconcile({
        profile: 'local',
        serverId: 'remote',
        definition: item.definition,
        enabled: false,
        signal: new AbortController().signal,
      })
      expect(manager.status('remote')).toMatchObject({ connectionState: 'disabled', toolCount: 0 })
      expect(live.close).toHaveBeenCalledTimes(1)
      expect(apply).toHaveBeenCalledTimes(2)
    },
  )
})

describe('MCP catalog and observed generation', () => {
  it('paginates the complete stable catalog and reports a staged new revision as degraded until applied', async () => {
    const conn = connection()
    conn.listTools = vi.fn(async () =>
      Array.from({ length: 101 }, (_, index) => ({
        name: `tool-${String(index).padStart(3, '0')}`,
        description: `tool ${index}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })),
    )
    const { manager } = setup(async () => conn)
    const item = managed({
      definition: definition({
        toolPolicy: {
          allow: Array.from({ length: 101 }, (_, index) => `tool-${String(index).padStart(3, '0')}`),
        },
      }),
    })
    manager.stage(item)
    await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    const first = manager.tools('github')
    const second = manager.tools('github', first?.nextCursor)
    expect(first).toMatchObject({ items: expect.any(Array), nextCursor: '100' })
    expect(first?.items).toHaveLength(100)
    expect(second?.items).toHaveLength(1)
    manager.stage({ ...item, revision: revision('c') })
    expect(manager.get('github')).toMatchObject({ revision: revision('c'), actual: 'degraded' })
    expect(manager.status('github')).toMatchObject({
      observedRevision: revision('a'),
      connectionState: 'ready',
    })
  })

  it('rejects cross-profile lifecycle calls', async () => {
    const { manager } = setup(async () => connection())
    const item = managed()
    manager.stage(item)
    await expect(
      manager.test({
        profile: 'other',
        serverId: 'github',
        definition: item.definition,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('profile mismatch')
  })

  it('retains an old two-server generation when extension registration rejects the candidate generation', async () => {
    const githubOld = connection('github')
    const gitlabOld = connection('gitlab')
    const githubNew = connection('github')
    const gitlabNew = connection('gitlab')
    const connections = [githubOld, gitlabOld, githubNew, gitlabNew]
    let calls = 0
    const apply = vi.fn(async (runtime) => {
      const ids = runtime
        .list()
        .map((server: { config: { id: string } }) => server.config.id)
        .sort()
      if (calls++ === 2 && ids.join(',') === 'github,gitlab') throw new Error('managed registration failed')
    })
    const manager = createMcpResourceManager({
      barrier: createExtensionActivationBarrier(),
      profile: 'local',
      credentials: async () => 'credential-test-marker',
      stdioPolicy: { allowedExecutables: ['mcp-github', 'mcp-gitlab'] },
      connect: async () => connections.shift() as McpConnection,
      inspectCatalog: async (conn) => conn.listTools(),
      apply,
    })
    const github = managed()
    const gitlab = managed({
      definition: definition({
        serverId: 'gitlab',
        displayName: 'GitLab',
        transport: { kind: 'stdio', executable: 'mcp-gitlab', args: [] },
      }),
    })
    manager.stage(github)
    manager.stage(gitlab)
    await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: github.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    await manager.reconcile({
      profile: 'local',
      serverId: 'gitlab',
      definition: gitlab.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    const held = manager.snapshot()

    const result = await manager.reconnect({
      profile: 'local',
      serverId: 'github',
      definition: github.definition,
      signal: new AbortController().signal,
    })
    expect(result.error?.code).toBe('MCP_APPLY_FAILED')
    expect(held.list().find((server) => server.config.id === 'github')?.connection).toBe(githubOld)
    expect(held.list().find((server) => server.config.id === 'gitlab')?.connection).toBe(gitlabOld)
    expect(
      manager
        .snapshot()
        .list()
        .find((server) => server.config.id === 'github')?.connection,
    ).toBe(githubOld)
    expect(githubOld.close).not.toHaveBeenCalled()
    expect(gitlabOld.close).not.toHaveBeenCalled()
    expect(githubNew.close).toHaveBeenCalledTimes(1)
    expect(gitlabNew.close).not.toHaveBeenCalled()
  })

  it('retains staged definition when retirement apply fails, and does not close the still-active generation', async () => {
    const live = connection()
    let fail = false
    const apply = vi.fn(async () => {
      if (fail) throw new Error('retire failed')
    })
    const failing = createMcpResourceManager({
      barrier: createExtensionActivationBarrier(),
      profile: 'local',
      credentials: async () => 'credential-test-marker',
      stdioPolicy: { allowedExecutables: ['mcp-github'] },
      connect: async () => live,
      inspectCatalog: async (conn) => conn.listTools(),
      apply,
    })
    const item = managed()
    failing.stage(item)
    await failing.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    fail = true
    await expect(failing.unstage('github')).rejects.toThrow('definition was retained')
    expect(failing.get('github')).toBeDefined()
    expect(failing.snapshot().list()[0]?.connection).toBe(live)
    expect(live.close).not.toHaveBeenCalled()
  })

  it('permits only policy-enabled local loopback HTTP and rejects remote or credential-shaped URLs', async () => {
    const { manager } = setup(async () => connection())
    const denied = managed({
      definition: definition({ transport: { kind: 'stdio', executable: 'unlisted', args: [] } }),
    })
    manager.stage(denied)
    await expect(
      manager.reconcile({
        profile: 'local',
        serverId: 'github',
        definition: denied.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })

    const remote = managed({
      definition: definition({
        transport: { kind: 'http', url: 'http://example.test/mcp' },
        secretBinding: { kind: 'none' },
      }),
    })
    manager.stage(remote)
    await expect(
      manager.reconcile({
        profile: 'local',
        serverId: 'github',
        definition: remote.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })

    // `default` is a normal local profile name. Locality comes only from the daemon
    // deployment policy, never from a profile-string convention.
    const { manager: loopback } = setup(
      async () => connection(),
      { localDaemon: true, allowLoopbackHttp: true },
      'default',
    )
    const local = managed({
      definition: definition({
        transport: { kind: 'http', url: 'http://127.0.0.1:4312/mcp' },
        secretBinding: { kind: 'none' },
      }),
    })
    loopback.stage(local)
    await expect(
      loopback.reconcile({
        profile: 'default',
        serverId: 'github',
        definition: local.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: { connectionState: 'ready' } })
    const poisoned = managed({
      definition: definition({
        transport: { kind: 'http', url: 'http://127.0.0.1:4312/mcp?token=secret' },
        secretBinding: { kind: 'none' },
      }),
    })
    loopback.stage(poisoned)
    await expect(
      loopback.reconcile({
        profile: 'default',
        serverId: 'github',
        definition: poisoned.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })

    // A remote daemon must not turn a stored request definition into a clear-text tunnel,
    // even when that definition points at a syntactic loopback URL.
    const { manager: remoteDaemon } = setup(
      async () => connection(),
      { localDaemon: false, allowLoopbackHttp: true },
      'remote-prod',
    )
    remoteDaemon.stage(local)
    await expect(
      remoteDaemon.reconcile({
        profile: 'remote-prod',
        serverId: 'github',
        definition: local.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })
  })

  it('validates an sse transport url with the same HTTPS/loopback policy as http', async () => {
    const { manager } = setup(async () => connection())
    const plainHttp = managed({
      definition: definition({
        transport: { kind: 'sse', url: 'http://example.test/sse' },
        secretBinding: { kind: 'none' },
      }),
    })
    manager.stage(plainHttp)
    await expect(
      manager.reconcile({
        profile: 'local',
        serverId: 'github',
        definition: plainHttp.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ error: { code: 'MCP_CONNECT_FAILED' } })

    const overHttps = managed({
      definition: definition({
        transport: { kind: 'sse', url: 'https://example.test/sse' },
        secretBinding: { kind: 'none' },
      }),
    })
    manager.stage(overHttps)
    await expect(
      manager.reconcile({
        profile: 'local',
        serverId: 'github',
        definition: overHttps.definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: { connectionState: 'ready' } })
  })

  it('resolves an sse definition into an sse-transport McpServerConfig, not http', async () => {
    const seenConfigs: McpServerConfig[] = []
    const { manager } = setup(async (config) => {
      seenConfigs.push(config)
      return connection()
    })
    const sseServer = managed({
      definition: definition({
        transport: { kind: 'sse', url: 'https://example.test/sse' },
        secretBinding: { kind: 'none' },
      }),
    })
    manager.stage(sseServer)
    await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: sseServer.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    // Base's connectMcp() dispatches on config.transport ('sse' -> SSEClientTransport, anything else
    // non-stdio -> StreamableHTTPClientTransport), so resolvedConfig() mislabeling an sse definition
    // as 'http' would silently connect it with the wrong wire protocol.
    expect(seenConfigs).toHaveLength(1)
    expect(seenConfigs[0]).toMatchObject({ transport: 'sse', url: 'https://example.test/sse' })
  })

  it('does not close or forget active connections when host-wide retirement fails', async () => {
    const live = connection()
    let rejectRetirement = false
    const manager = createMcpResourceManager({
      barrier: createExtensionActivationBarrier(),
      profile: 'local',
      credentials: async () => 'credential-test-marker',
      stdioPolicy: { allowedExecutables: ['mcp-github'] },
      connect: async () => live,
      inspectCatalog: async (conn) => conn.listTools(),
      apply: async () => {
        if (rejectRetirement) throw new Error('extension reload failed')
      },
    })
    const item = managed()
    manager.stage(item)
    await manager.reconcile({
      profile: 'local',
      serverId: 'github',
      definition: item.definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    rejectRetirement = true
    await expect(manager.close()).rejects.toThrow('extension reload failed')
    expect(manager.snapshot().list()[0]?.connection).toBe(live)
    expect(live.close).not.toHaveBeenCalled()
  })
})
