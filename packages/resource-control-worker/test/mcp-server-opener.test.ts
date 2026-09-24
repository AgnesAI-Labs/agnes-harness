import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpConnection, McpServerConfig } from '@agnes/base'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createMcpServerOpener,
  createWorkerMcpServerOpener,
  managedMcpExecutableShape,
  syncManagedMcpExecutableAllowlist,
  verifyManagedMcpExecutable,
} from '../src/mcp-server-opener.js'

const fakeConnection = { id: 'x' } as unknown as McpConnection
const connectMcp = vi.fn(
  async (
    _config: McpServerConfig,
    _deps: unknown,
    _options: { signal: AbortSignal; connectTimeoutMs?: number; validateRedirectUrl?: (url: URL) => void },
  ): Promise<McpConnection> => fakeConnection,
)

vi.mock('@agnes/base', async (original) => ({
  ...(await original<typeof import('@agnes/base')>()),
  connectMcp: (config: McpServerConfig, deps: unknown, options: unknown) =>
    connectMcp(config, deps, options as never),
}))

const stdioDefinition: McpServerDefinitionInput = {
  serverId: 'gh',
  displayName: 'GitHub',
  transport: { kind: 'stdio', executable: '/usr/local/bin/gh-mcp', args: [] },
  secretBinding: { kind: 'stdio-env', env: { GH_TOKEN: 'secret:gh-token' } },
} as McpServerDefinitionInput

const httpDefinition: McpServerDefinitionInput = {
  serverId: 'remote',
  displayName: 'Remote',
  transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
  secretBinding: { kind: 'http-bearer', credentialRef: 'secret:remote-token' },
} as McpServerDefinitionInput

describe('createMcpServerOpener', () => {
  it('resolves the credential and connects with the fully-resolved config', async () => {
    connectMcp.mockClear()
    const resolver = vi.fn(async (ref: string) => (ref === 'secret:gh-token' ? 'tok-123' : 'unexpected'))
    const opener = createMcpServerOpener({
      resolver,
      baseEnv: {},
      stdioPolicy: { allowedExecutables: ['/usr/local/bin/gh-mcp'] },
      httpPolicy: {},
    })
    const controller = new AbortController()
    const connection = await opener.connect(stdioDefinition, controller.signal)

    expect(connection).toBe(fakeConnection)
    expect(resolver).toHaveBeenCalledWith('secret:gh-token', controller.signal)
    expect(connectMcp).toHaveBeenCalledOnce()
    const [config, , options] = connectMcp.mock.calls[0] as [
      McpServerConfig,
      unknown,
      { signal: AbortSignal },
    ]
    expect(config).toMatchObject({
      id: 'gh',
      transport: 'stdio',
      cmd: ['/usr/local/bin/gh-mcp'],
      env: { GH_TOKEN: 'tok-123' },
    })
    expect(options.signal).toBe(controller.signal)
  })

  it('resolves an http bearer credential into the Authorization header', async () => {
    connectMcp.mockClear()
    const resolver = vi.fn(async () => 'bearer-xyz')
    const opener = createMcpServerOpener({
      resolver,
      baseEnv: {},
      stdioPolicy: { allowedExecutables: [] },
      httpPolicy: {},
    })
    await opener.connect(httpDefinition, new AbortController().signal)

    const [config] = connectMcp.mock.calls[0] as [McpServerConfig, unknown, unknown]
    expect(config).toMatchObject({
      id: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { authorization: 'Bearer bearer-xyz' },
    })
  })

  it('rejects a disallowed stdio executable before ever resolving a credential or connecting', async () => {
    connectMcp.mockClear()
    const resolver = vi.fn(async () => 'tok')
    const opener = createMcpServerOpener({
      resolver,
      baseEnv: {},
      // gh-mcp is not on the allow list.
      stdioPolicy: { allowedExecutables: ['/usr/local/bin/other-mcp'] },
      httpPolicy: {},
    })
    await expect(opener.connect(stdioDefinition, new AbortController().signal)).rejects.toThrow()
    expect(resolver).not.toHaveBeenCalled()
    expect(connectMcp).not.toHaveBeenCalled()
  })

  it('wires validateRedirectUrl to the same httpPolicy, refusing what validateManagedHttpUrl refuses', async () => {
    connectMcp.mockClear()
    const opener = createMcpServerOpener({
      resolver: async () => 'bearer-xyz',
      baseEnv: {},
      stdioPolicy: { allowedExecutables: [] },
      // No loopback allowance: a loopback redirect target must be refused.
      httpPolicy: {},
    })
    await opener.connect(httpDefinition, new AbortController().signal)

    const [, , options] = connectMcp.mock.calls[0] as [
      unknown,
      unknown,
      { validateRedirectUrl?: (url: URL) => void },
    ]
    expect(options.validateRedirectUrl).toBeInstanceOf(Function)
    expect(() => options.validateRedirectUrl?.(new URL('http://127.0.0.1:9/hook'))).toThrow()
    expect(() => options.validateRedirectUrl?.(new URL('https://mcp.example.com/redirected'))).not.toThrow()
  })

  it('passes connectTimeoutMs through when configured', async () => {
    connectMcp.mockClear()
    const opener = createMcpServerOpener({
      resolver: async () => 'tok',
      baseEnv: {},
      stdioPolicy: { allowedExecutables: ['/usr/local/bin/gh-mcp'] },
      httpPolicy: {},
      connectTimeoutMs: 5_000,
    })
    await opener.connect(stdioDefinition, new AbortController().signal)
    const [, , options] = connectMcp.mock.calls[0] as [unknown, unknown, { connectTimeoutMs?: number }]
    expect(options.connectTimeoutMs).toBe(5_000)
  })
})

describe('createWorkerMcpServerOpener', () => {
  const profile = { name: 'local', dataDir: '/nowhere', adapters: { secrets: { kind: 'env' } } }
  const policyEnv = (policy: unknown) => ({ AGNES_RESOURCE_MCP_POLICY: JSON.stringify(policy) })
  const noneDefinition = (executable: string): McpServerDefinitionInput =>
    ({
      serverId: 'plain',
      displayName: 'Plain',
      transport: { kind: 'stdio', executable, args: [] },
      secretBinding: { kind: 'none' },
    }) as McpServerDefinitionInput

  it('accepts only native Windows executable shapes for automatic authorization', async () => {
    expect(managedMcpExecutableShape('C:\\Tools\\agent-browser.exe', 'win32')).toBe(true)
    expect(managedMcpExecutableShape('C:\\Tools\\agent-browser.cmd', 'win32')).toBe(false)
    expect(managedMcpExecutableShape('C:\\Tools\\cmd.exe', 'win32')).toBe(false)
    expect(managedMcpExecutableShape('/opt/homebrew/bin/agent-browser', 'darwin')).toBe(false)
    expect(managedMcpExecutableShape('/bin/sh', 'darwin')).toBe(false)
    expect(managedMcpExecutableShape('agent-browser', 'darwin')).toBe(false)
    if (process.platform === 'win32')
      await expect(verifyManagedMcpExecutable(process.execPath)).resolves.toBeUndefined()
    await expect(verifyManagedMcpExecutable('missing-agent-browser')).rejects.toThrow()
  })

  it.skipIf(process.platform !== 'win32')(
    'rejects an .exe file without a Windows executable header',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-invalid-exe-'))
      const executable = join(directory, 'server.exe')
      try {
        await writeFile(executable, 'not a native executable')
        await expect(verifyManagedMcpExecutable(executable)).rejects.toThrow('not a Windows executable')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'rebuilds the Windows allowlist and revokes it on disable',
    async () => {
      const env: NodeJS.ProcessEnv = {}
      const managed: string[] = []
      const enabled = {
        definition: noneDefinition(process.execPath),
        trust: 'trusted',
        desired: 'enabled',
      }
      await syncManagedMcpExecutableAllowlist(
        [enabled, enabled, { ...enabled, desired: 'disabled' }, { ...enabled, trust: 'untrusted' }],
        ['/deployment/approved'],
        managed,
        env,
        true,
      )
      expect(managed).toEqual([process.execPath])
      expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBe(['/deployment/approved', process.execPath].join(','))
      await syncManagedMcpExecutableAllowlist(
        [{ ...enabled, desired: 'disabled' }],
        ['/deployment/approved'],
        managed,
        env,
        true,
      )
      expect(managed).toEqual([])
      expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBe('/deployment/approved')
      await syncManagedMcpExecutableAllowlist(
        [
          { ...enabled, trust: 'rejected' },
          { ...enabled, definition: noneDefinition('missing-file') },
        ],
        [],
        managed,
        env,
        true,
      )
      expect(managed).toEqual([])
      expect(env.AGNES_MCP_STDIO_ALLOWLIST).toBeUndefined()
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'applies Windows authorization without a worker restart',
    async () => {
      connectMcp.mockClear()
      const managed: string[] = []
      const executable = process.execPath
      const opener = createWorkerMcpServerOpener(
        {
          env: policyEnv({ allowedExecutables: [] }),
          profile,
          createSecrets: () => ({ resolve: () => 'unused' }),
        },
        managed,
      )
      await expect(opener.connect(noneDefinition(executable), new AbortController().signal)).rejects.toThrow()
      managed.push(executable)
      await opener.connect(noneDefinition(executable), new AbortController().signal)
      expect(connectMcp).toHaveBeenCalledOnce()
    },
  )

  it('applies the deployment stdio allowlist from AGNES_RESOURCE_MCP_POLICY', async () => {
    connectMcp.mockClear()
    const opener = createWorkerMcpServerOpener({
      env: policyEnv({ allowedExecutables: ['/usr/local/bin/allowed-mcp'] }),
      profile,
      createSecrets: () => ({ resolve: () => 'unused' }),
    })
    await expect(
      opener.connect(noneDefinition('/usr/local/bin/other-mcp'), new AbortController().signal),
    ).rejects.toThrow()
    expect(connectMcp).not.toHaveBeenCalled()
    await opener.connect(noneDefinition('/usr/local/bin/allowed-mcp'), new AbortController().signal)
    expect(connectMcp).toHaveBeenCalledOnce()
  })

  it('applies the deployment HTTP loopback policy, to the configured URL and to redirects', async () => {
    connectMcp.mockClear()
    const loopback = {
      serverId: 'local-http',
      displayName: 'Local',
      transport: { kind: 'http', url: 'http://127.0.0.1:7777/mcp' },
      secretBinding: { kind: 'none' },
    } as McpServerDefinitionInput
    const strict = createWorkerMcpServerOpener({
      env: policyEnv({ allowedExecutables: [] }),
      profile,
      createSecrets: () => ({ resolve: () => 'unused' }),
    })
    await expect(strict.connect(loopback, new AbortController().signal)).rejects.toThrow()
    expect(connectMcp).not.toHaveBeenCalled()

    const local = createWorkerMcpServerOpener({
      env: policyEnv({ allowedExecutables: [], allowLoopbackHttp: true, localDaemon: true }),
      profile,
      createSecrets: () => ({ resolve: () => 'unused' }),
    })
    await local.connect(loopback, new AbortController().signal)
    const [, , options] = connectMcp.mock.calls[0] as [
      unknown,
      unknown,
      { validateRedirectUrl?: (url: URL) => void },
    ]
    expect(() => options.validateRedirectUrl?.(new URL('http://127.0.0.1:9/hook'))).not.toThrow()
  })

  it('builds the secret resolver lazily, once per worker, and resolves on every connect', async () => {
    connectMcp.mockClear()
    const resolve = vi.fn((ref: string) => `value-of-${ref}`)
    const createSecrets = vi.fn(() => ({ resolve }))
    const opener = createWorkerMcpServerOpener({
      env: policyEnv({ allowedExecutables: ['/usr/local/bin/gh-mcp', '/usr/local/bin/plain-mcp'] }),
      profile,
      createSecrets,
    })
    // secretBinding: none never needs a secret backend.
    await opener.connect(noneDefinition('/usr/local/bin/plain-mcp'), new AbortController().signal)
    expect(createSecrets).not.toHaveBeenCalled()

    await opener.connect(stdioDefinition, new AbortController().signal)
    await opener.connect(stdioDefinition, new AbortController().signal)
    expect(createSecrets).toHaveBeenCalledOnce()
    expect(createSecrets).toHaveBeenCalledWith(profile)
    // Resolved afresh each time, so a rotated secret reaches the next reconnect.
    expect(resolve).toHaveBeenCalledTimes(2)
    const [config] = connectMcp.mock.calls[2] as [McpServerConfig, unknown, unknown]
    expect(config).toMatchObject({ env: { GH_TOKEN: 'value-of-secret:gh-token' } })
  })
})
