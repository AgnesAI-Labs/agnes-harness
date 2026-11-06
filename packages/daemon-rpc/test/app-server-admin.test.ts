import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPlanCommand } from '@agnes/base/plan-mode'
import { localPackageAdminAuthority, localWebSkinReadAuthority } from '@agnes/daemon-admin/packages/index'
import { McpResourceStore, RESOURCE_ALL_PERMISSIONS } from '@agnes/daemon-admin/resources/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import { compilePluginConfig } from '@agnes/extension-api'
import {
  createCredentialStore,
  createExtensionActivationBarrier,
  createMcpOAuthStore,
  createPlatform,
  createSecretsFile,
  resolveProfile,
} from '@agnes/host'
import { jcs } from '@agnes/protocol'
import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { createAppServerAdmin, registerAppServerAdmin } from '../src/local/methods/admin.js'
import { createPlanCommands } from '../src/local/plan-commands.js'

it('owns settings and plan writes behind local admin and registered-workspace authority', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agh-app-admin-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const cwd = join(home, 'project')
  await mkdir(cwd)
  await mkdir(join(home, 'data'))
  await writeFile(join(cwd, 'AGENTS.md'), 'Project rules')
  const plan = vi.fn(async (input: { cwd: string; line: string }) => applyPlanCommand(input.cwd, input.line))
  const service = createAppServerAdmin({
    plan,
    home,
    dataDir: join(home, 'data'),
    profileDir: join(home, 'profiles/local-dev'),
    resolveProfile: async () =>
      resolveProfile(
        { builtin: 'local-dev' },
        { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
      ),
    workspaces: async () => ({ items: [{ path: cwd, available: true }] }),
  })
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoint.conn.initialized = true
  let authority = localPackageAdminAuthority()
  registerAppServerAdmin(endpoint, service, (context) => authority(context))
  let id = 0
  const call = (method: string, params: unknown) =>
    endpoint.handle({ jsonrpc: '2.0', id: ++id, method, params })
  try {
    expect(await call('_agnes/v1/admin.context', {})).toMatchObject({
      error: { code: -32006, data: { messageKey: 'appServer.errors.forbidden' } },
    })
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    expect(await call('_agnes/v1/admin.context', { cwd: home, config: { timeZone: 'UTC' } })).toMatchObject({
      error: { code: -32006 },
    })
    expect(
      await call('_agnes/v1/admin.context', {
        cwd,
        config: { timeZone: 'Asia/Shanghai', customSkillRoots: [join(home, '技能')] },
      }),
    ).toMatchObject({
      result: { config: { timeZone: 'Asia/Shanghai' }, rules: { files: [{ content: 'Project rules' }] } },
    })
    expect(JSON.parse(await readFile(join(home, 'context.json'), 'utf8')).customSkillRoots).toEqual([
      join(home, '技能'),
    ])
    expect(await call('_agnes/v1/admin.plan', { cwd, line: '/plan look first' })).toMatchObject({
      result: { active: true, text: 'Plan mode is on: look first' },
    })
    expect(plan).toHaveBeenCalledWith({ cwd: await realpath(cwd), line: '/plan look first' })
    expect(JSON.parse(await readFile(join(cwd, '.agh/plan-mode.json'), 'utf8'))).toMatchObject({
      active: true,
      instruction: 'look first',
    })
    expect(await call('_agnes/v1/admin.plan', { cwd, line: '/plan off' })).toMatchObject({
      result: { active: false },
    })
    plan.mockResolvedValueOnce({ active: false, text: 'Plan mode is off (provider unavailable)' })
    expect(await call('_agnes/v1/admin.plan', { cwd, line: '/plan' })).toMatchObject({
      result: { active: false, text: 'Plan mode is off (provider unavailable)' },
    })
    for (const params of [
      { cwd: home, line: '/plan' },
      { cwd: 'relative', line: '/plan' },
      { cwd: join(home, 'missing'), line: '/plan' },
      { cwd, line: 'hello' },
    ])
      expect(await call('_agnes/v1/admin.plan', params)).toHaveProperty('error')
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toMatchObject({ result: { items: [], truncated: false } })
    for (const permissions of [['packages.read'], ['packages.activate'], []] as const) {
      authority = localPackageAdminAuthority(permissions)
      const history = await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' })
      if (permissions.some((permission) => permission === 'packages.read'))
        expect(history).toMatchObject({ result: { items: [], truncated: false } })
      else expect(history).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    }
    authority = localWebSkinReadAuthority
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    authority = localPackageAdminAuthority()
    endpoint.conn.authKind = 'jwt'
    expect(
      await call('_agnes/v1/admin.mcp.oauth.get', { profile: 'local-dev', serverId: 'srv-1' }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
  } finally {
    await endpoint.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

describe('MCP OAuth sign-in in the daemon', () => {
  const SERVER_URL = 'https://mcp.example.test/mcp'
  const REDIRECT = 'http://127.0.0.1:4177/oauth/srv-1/callback'
  const VERIFIER = 'v'.repeat(43)

  async function setup(secretBinding: Record<string, unknown> = { kind: 'oauth' }) {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'agh-mcp-oauth-admin-'))
    const home = join(fixtureRoot, 'home')
    createPrivateDirectorySync(home)
    await mkdir(join(home, 'data'))
    const tokenRequests: { headers: Headers; form: URLSearchParams }[] = []
    // No metadata anywhere: the token endpoint is the server origin's /token.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname !== '/token') return new Response('', { status: 404 })
      tokenRequests.push({
        headers: new Headers(init?.headers),
        form: new URLSearchParams(String(init?.body)),
      })
      return Response.json({
        access_token: 'issued-access',
        token_type: 'Bearer',
        refresh_token: 'issued-refresh',
      })
    }) as typeof fetch
    const service = createAppServerAdmin({
      home,
      dataDir: join(home, 'data'),
      profileDir: join(home, 'profiles/local-dev'),
      resolveProfile: async () =>
        resolveProfile(
          { builtin: 'local-dev' },
          { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
        ),
      workspaces: async () => ({ items: [] }),
      mcpServer: async (profile, serverId) =>
        profile === 'local-dev' && serverId === 'srv-1'
          ? ({
              serverId,
              displayName: 'Server',
              transport: { kind: 'http', url: SERVER_URL },
              secretBinding,
              toolPolicy: { allow: [] },
            } as never)
          : undefined,
      fetchImpl,
    })
    const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    endpoint.conn.initialized = true
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    registerAppServerAdmin(endpoint, service, localPackageAdminAuthority())
    let id = 0
    const call = (method: string, params: unknown) =>
      endpoint.handle({ jsonrpc: '2.0', id: ++id, method, params })
    const complete = (extra: Record<string, unknown> = {}) =>
      call('_agnes/v1/admin.mcp.oauth.complete', {
        profile: 'local-dev',
        serverId: 'srv-1',
        expectedEpoch: 0,
        code: 'code-1',
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT,
        client: { clientId: 'client-1' },
        requestedScope: ['read'],
        // No metadata in this fixture: the token endpoint is the server origin's /token.
        authorization: { tokenEndpoint: 'https://mcp.example.test/token', resource: SERVER_URL },
        ...extra,
      })
    return {
      home,
      call,
      complete,
      tokenRequests,
      store: createMcpOAuthStore({ root: home }),
      async close() {
        await endpoint.close()
        await rm(fixtureRoot, { recursive: true, force: true })
      },
    }
  }

  it('admin.mcp.oauth.get returns no secret fields', async () => {
    const t = await setup()
    try {
      await t.store.update('srv-1', async () => ({
        value: undefined,
        next: {
          epoch: 3,
          client: { clientId: 'client-1', clientSecret: 'dcr-secret-9', redirectUri: REDIRECT },
          server: {
            endpoint: SERVER_URL,
            authorizationServer: 'https://mcp.example.test/',
            tokenEndpoint: 'https://mcp.example.test/token',
            resource: SERVER_URL,
          },
          tokens: {
            accessToken: 'stored-access',
            refreshToken: 'stored-refresh',
            expiresAt: 5,
            scope: ['read'],
          },
          requiredScope: [],
        },
      }))
      const response = await t.call('_agnes/v1/admin.mcp.oauth.get', {
        profile: 'local-dev',
        serverId: 'srv-1',
      })
      expect(response).toMatchObject({
        result: {
          epoch: 3,
          signedIn: true,
          refreshable: true,
          expiresAt: 5,
          scope: ['read'],
          requiredScope: [],
          client: { clientId: 'client-1', redirectUri: REDIRECT },
        },
      })
      const text = JSON.stringify(response)
      for (const leak of ['accessToken', 'refreshToken', 'clientSecret', 'stored-access', 'dcr-secret-9'])
        expect(text).not.toContain(leak)
      expect(
        await t.call('_agnes/v1/admin.mcp.oauth.get', { profile: 'local-dev', serverId: 'other' }),
      ).toHaveProperty('error')
    } finally {
      await t.close()
    }
  })

  it('admin.mcp.oauth.complete rejects unknown params', async () => {
    const t = await setup()
    try {
      expect(await t.complete({ accessToken: 'smuggled' })).toMatchObject({ error: { code: -32602 } })
      expect(await t.complete({ client: { clientId: 'client-1', refreshToken: 'x' } })).toMatchObject({
        error: { code: -32602 },
      })
      expect(await t.complete({ serverId: '../other' })).toMatchObject({ error: { code: -32602 } })
      expect(
        await t.complete({
          authorization: { tokenEndpoint: 'https://mcp.example.test/token', resource: SERVER_URL, extra: 1 },
        }),
      ).toMatchObject({ error: { code: -32602 } })
      expect(t.tokenRequests).toEqual([])
      expect(await t.store.read('srv-1')).toBeNull()
    } finally {
      await t.close()
    }
  })

  it('admin.mcp.oauth.save is gone', async () => {
    const t = await setup()
    try {
      expect(
        await t.call('_agnes/v1/admin.mcp.oauth.save', { serverId: 'srv-1', credential: {} }),
      ).toMatchObject({
        error: { code: -32601 },
      })
    } finally {
      await t.close()
    }
  })

  it('completes with the static client secret read from its reference, and stores no copy of it', async () => {
    const t = await setup({
      kind: 'oauth',
      staticClientId: 'static-client',
      clientSecretRef: 'secret://mcp/client',
    })
    try {
      await createCredentialStore({ root: t.home }).putApiKey('secret://mcp/client', 'static-secret-value')
      expect(await t.complete({ client: { clientId: 'static-client' } })).toMatchObject({ result: {} })
      const [request] = t.tokenRequests
      expect(request?.headers.get('authorization')).toBe(
        `Basic ${Buffer.from('static-client:static-secret-value').toString('base64')}`,
      )
      expect(request?.form.get('resource')).toBe(SERVER_URL)
      const stored = await t.store.read('srv-1')
      expect(stored).toMatchObject({ epoch: 0, rev: 1, tokens: { accessToken: 'issued-access' } })
      expect(JSON.stringify(stored)).not.toContain('static-secret-value')
    } finally {
      await t.close()
    }
  })

  it('refuses a sign-in whose token endpoint changed since it started, with a readable reason', async () => {
    const t = await setup()
    try {
      const response = await t.complete({
        authorization: { tokenEndpoint: 'https://elsewhere.example.test/token', resource: SERVER_URL },
      })
      expect(response).toHaveProperty('error')
      expect(JSON.stringify(response)).toContain('MCP_OAUTH_LOGIN_ENDPOINT_CHANGED')
      expect(t.tokenRequests).toEqual([])
      expect(await t.store.read('srv-1')).toBeNull()
    } finally {
      await t.close()
    }
  })

  it('refuses a sign-in that a sign-out overtook, with a readable reason', async () => {
    const t = await setup()
    try {
      await t.store.update('srv-1', async () => ({ value: undefined, next: { epoch: 1, requiredScope: [] } }))
      const response = await t.complete({ expectedEpoch: 0 })
      expect(response).toHaveProperty('error')
      expect(JSON.stringify(response)).toContain('MCP_OAUTH_LOGIN_SUPERSEDED')
      expect(t.tokenRequests).toEqual([])
      expect(await t.store.read('srv-1')).toMatchObject({ epoch: 1, rev: 1 })
    } finally {
      await t.close()
    }
  })

  it('refuses a server whose credential is a bearer or header secret, or that runs locally', async () => {
    const t = await setup({ kind: 'http-bearer', credentialRef: 'secret://mcp/token' })
    try {
      expect(await t.complete()).toHaveProperty('error')
      expect(
        await t.call('_agnes/v1/admin.mcp.oauth.get', { profile: 'local-dev', serverId: 'srv-1' }),
      ).toHaveProperty('error')
      expect(t.tokenRequests).toEqual([])
    } finally {
      await t.close()
    }
  })
})

it('keeps doctor local-only and refuses caller-supplied homes and implicit model probes', async () => {
  const { registerDoctor } = await import('../src/local/methods/doctor.js')
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoint.conn.initialized = true
  const safe = async () => ({ status: 'ok' as const })
  registerDoctor(endpoint, {
    home: '/synthetic-unused',
    profile: 'local-dev',
    probes: {
      node: safe,
      native: safe,
      home: safe,
      permissions: safe,
      credentials: safe,
      sandbox: safe,
      connection: safe,
      disk: safe,
      accounts: safe,
      plugins: safe,
      mcp: safe,
    },
  })
  const call = (params: unknown) =>
    endpoint.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/doctor.run', params })
  expect(await call({})).toMatchObject({ error: { data: { messageKey: 'appServer.errors.forbidden' } } })
  endpoint.conn.authKind = 'local'
  endpoint.conn.credentialKind = 'local'
  expect(await call({ home: '/caller-selected' })).toMatchObject({ error: { code: -32602 } })
  expect(await call({ probeAccounts: 'yes' })).toMatchObject({ error: { code: -32602 } })
  expect(await call({})).toMatchObject({
    result: {
      status: 'ok',
      checks: expect.arrayContaining([expect.objectContaining({ id: 'credentials', status: 'ok' })]),
    },
  })
})

it('manages write-only generic credentials with MCP references, restart persistence and local permissions', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agh-generic-admin-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const dataDir = join(home, 'data')
  const canary = 'synthetic-generic-canary-never-log'
  const logs: unknown[] = []
  const profile = await resolveProfile(
    { builtin: 'local-dev' },
    { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
  )
  let unavailable = false
  let envAdapter = false
  const pluginConfigurations: { kind: 'plugin'; profile: string; configId: string; value: unknown }[] = []
  const factory = () =>
    createAppServerAdmin({
      home,
      dataDir,
      profileDir: join(home, 'profiles/local-dev'),
      resolveProfile: async () =>
        envAdapter ? { ...profile, adapters: { ...profile.adapters, secrets: { kind: 'env' } } } : profile,
      workspaces: async () => ({ items: [{ path: home, available: true }] }),
      credentialConfigurations: async () => {
        if (unavailable) throw new Error(canary)
        return pluginConfigurations
      },
    })
  let endpoint = new LocalEndpoint({
    clock: Date.now,
    principalId: 'credential-owner',
    profile: 'local-dev',
    audit: (row) => logs.push(row),
  })
  endpoint.conn.initialized = true
  let authority = localPackageAdminAuthority()
  let recovery = false
  const administration = {
    call: async () => (recovery ? { unavailable: true } : { packages: [] }),
    recover: async () => {},
    rebuildClientModules: async () => {},
    subscribe: () => () => {},
    subscribeClientModules: () => () => {},
    closeClientModules: () => {},
  }
  let service = factory()
  registerAppServerAdmin(endpoint, service, (context) => authority(context), administration)
  let command = 0
  const responses: unknown[] = []
  const call = async (action: string, params: unknown) => {
    const response = (await endpoint.handle({
      jsonrpc: '2.0',
      id: ++command,
      method: `_agnes/v1/admin.credentials.${action}`,
      params,
    })) as {
      result?: AdminCredentialMetadata & { items?: AdminCredentialMetadata[] }
      error?: { data?: { code?: string; cause?: { code?: string } } }
    }
    responses.push(response)
    return response
  }
  try {
    expect(await call('create', { label: 'MCP', value: canary })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    for (const permissions of [[], ['packages.read', 'credentials.read'], ['packages.activate']] as const) {
      authority = localPackageAdminAuthority(permissions)
      expect(await call('create', { label: 'MCP', value: canary })).toHaveProperty(
        'error.data.code',
        'CAPABILITY_DENIED',
      )
    }
    authority = localPackageAdminAuthority()
    expect(await call('create', { label: 'MCP', value: canary, actor: 'forged' })).toHaveProperty('error')
    envAdapter = true
    expect(await call('create', { label: 'MCP', value: canary })).toHaveProperty('error')
    envAdapter = false
    recovery = true
    expect(await call('create', { label: 'MCP', value: canary })).toHaveProperty('error')
    recovery = false
    const created = await call('create', { label: 'MCP', value: canary })
    expect(created.error).toBeUndefined()
    const metadata = created.result
    if (!metadata) throw new Error('credential metadata missing')
    const id = metadata.id
    expect(id).toMatch(/^secret:\/\/generic\//)
    const resolver = createSecretsFile({ dir: join(home, 'secrets') })
    const definition = {
      serverId: 'canary-mcp',
      displayName: 'Canary MCP',
      transport: { kind: 'http' as const, url: 'https://example.test/mcp' },
      secretBinding: { kind: 'http-bearer' as const, credentialRef: id },
    }
    let used = false
    const status = {
      serverId: 'canary-mcp',
      connectionState: 'disabled' as const,
      observedRevision: 'a'.repeat(64),
      catalogRevision: 'a'.repeat(64),
      toolCount: 0,
      observedAt: new Date().toISOString(),
    }
    const mcp = new McpResourceStore(
      join(dataDir, 'resource-control/mcp'),
      { allowedProfiles: ['local-dev'] },
      {
        reconcile: async () => ({ status }),
        reconnect: async () => ({ status }),
        tools: async () => ({ serverId: 'canary-mcp', catalogRevision: 'a'.repeat(64), items: [] }),
        test: async ({ definition: configured }) => {
          if (configured.secretBinding.kind !== 'http-bearer') throw new Error('missing reference')
          expect(resolver.resolve(configured.secretBinding.credentialRef)).toBe(canary)
          used = true
          return { toolCount: 0, catalogRevision: 'a'.repeat(64) }
        },
      },
    )
    mcp.setDeferredDrive(true)
    const grant = {
      audience: 'admin' as const,
      principalId: 'credential-owner',
      clientId: 'fixture-client',
      permissions: RESOURCE_ALL_PERMISSIONS,
    }
    const effect = async (
      method: import('@agnes/protocol').ResourceControlMethodName,
      params: Record<string, unknown>,
    ) => {
      const result = (await mcp.call(
        method,
        { profile: 'local-dev', clientId: 'fixture-client', commandId: `mcp-${++command}`, ...params },
        grant,
      )) as { operationId: string }
      await mcp.driveOperation('local-dev', result.operationId)
    }
    await effect('_agnes/v1/mcp.servers.create', { definition })
    await effect('_agnes/v1/mcp.servers.test', {
      serverId: definition.serverId,
      expectedRevision: createHash('sha256').update(jcs(definition)).digest('hex'),
    })
    expect(used).toBe(true)
    const listed = await call('list', {})
    expect(listed.result?.items).toEqual([
      { ...metadata, references: [{ kind: 'mcp', profile: 'local-dev', configId: 'canary-mcp' }] },
    ])
    expect(
      compilePluginConfig({
        type: 'object',
        properties: { apiKey: { type: 'string', 'x-secret': true } },
        additionalProperties: false,
      })({ apiKey: id }),
    ).toEqual([])
    pluginConfigurations.push({
      kind: 'plugin',
      profile: 'local-dev',
      configId: 'ext:business',
      value: { apiKey: id },
    })
    const triggers = await service.triggers({
      action: 'upsert',
      rule: {
        id: 'credential-trigger',
        enabled: false,
        provider: 'generic',
        auth: 'bearer',
        secretRef: id,
        event: 'created',
        filters: {},
        workspace: home,
        agent: 'default',
        bundles: [],
        template: '{{$.title}}',
        timestampPath: '$.time',
        windowSeconds: 300,
        ratePerMinute: 10,
      },
    })
    expect(triggers.snapshot?.secretRefs).toContain(id)
    const allRefs = (await call('list', {})).result?.items?.[0]?.references
    expect(allRefs).toEqual(
      expect.arrayContaining([
        { kind: 'plugin', profile: 'local-dev', configId: 'ext:business' },
        { kind: 'trigger', profile: 'local-dev', configId: 'credential-trigger' },
      ]),
    )
    expect(await call('delete', { id })).toHaveProperty(
      'error.data.cause.code',
      'CONFIG_CREDENTIAL_REFERENCED',
    )
    expect(resolver.resolve(id)).toBe(canary)
    expect(await call('delete', { id, force: true })).toHaveProperty(
      'error.data.cause.code',
      'CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED',
    )
    const updates = await Promise.all(
      ['first-write', 'last-write'].map((value) => call('set', { id, value })),
    )
    expect(updates.every((response) => !response.error)).toBe(true)
    expect(resolver.resolve(id)).toBe('last-write')
    expect(await call('rename', { id, label: 'Renamed' })).toHaveProperty('result.label', 'Renamed')
    await endpoint.close()
    endpoint = new LocalEndpoint({
      clock: Date.now,
      principalId: 'credential-owner',
      profile: 'local-dev',
      audit: (row) => logs.push(row),
    })
    endpoint.conn.initialized = true
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    service = factory()
    registerAppServerAdmin(endpoint, service, (context) => authority(context), administration)
    expect((await call('list', {})).result?.items?.[0]).toMatchObject({
      id,
      label: 'Renamed',
      createdAt: metadata.createdAt,
    })
    expect(resolver.resolve(id)).toBe('last-write')
    unavailable = true
    expect(await call('delete', { id, force: true, confirm: true })).toHaveProperty(
      'error.data.cause.code',
      'CONFIG_CREDENTIAL_STORE',
    )
    unavailable = false
    authority = localWebSkinReadAuthority
    expect(await call('list', {})).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    authority = localPackageAdminAuthority()
    endpoint.conn.authKind = 'jwt'
    expect(await call('set', { id, value: canary })).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    endpoint.conn.authKind = 'local'
    expect(await call('delete', { id, force: true, confirm: true })).toHaveProperty('result')
    expect((await call('list', {})).result?.items).toEqual([])
    const audit = await readFile(join(dataDir, 'audit/credentials.jsonl'), 'utf8')
    expect(audit).not.toContain(canary)
    for (const line of audit.trim().split('\n'))
      expect(JSON.parse(line).detail).toMatchObject({ actor: 'credential-owner', id })
    expect(audit).not.toContain('Renamed')
    expect(JSON.stringify([responses, logs])).not.toContain(canary)
  } finally {
    await endpoint.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

it('dispatches plan operations to the session binding with narrow grants, durable effects and workspace refusal', async () => {
  const queue = new CommandQueue()
  const calls: string[] = []
  const services = {
    activationBarrier: createExtensionActivationBarrier(),
    journal: new MemoryJournal(Date.now),
    commandQueue: queue,
    resolveService: async (key: string) =>
      key === 'disabled'
        ? undefined
        : { extension: 'community/plan', packageId: '@community/plan', workspaceRoot: '/workspace' },
    inspectService: async () => ({ kind: 'effect' as const }),
    callService: async (
      params: import('@agnes/protocol').ExtensionCallParams,
      credential: unknown,
      _signal?: AbortSignal,
      admission?: { commandId: string },
    ) => {
      expect(params.extension).toBe('community/plan')
      expect(params.service).toBe('plan.command')
      expect(credential).toMatchObject({
        source: 'plan-admin',
        grants: [{ extension: 'community/plan', name: 'plan.command', range: '*' }],
      })
      expect(admission?.commandId).toBe(params.commandId)
      calls.push(params.sessionId)
      return { output: { active: true, text: 'Plan mode is on' } }
    },
  }
  const plan = createPlanCommands(services)
  try {
    await expect(plan({ cwd: '/workspace', sessionId: 'selected', line: '/plan on' })).resolves.toEqual({
      active: true,
      text: 'Plan mode is on',
    })
    await expect(plan({ cwd: '/other', sessionId: 'selected', line: '/plan off' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(plan({ cwd: '/workspace', sessionId: 'disabled', line: '/plan on' })).resolves.toMatchObject(
      { active: false, text: expect.stringContaining('unavailable') },
    )
    await expect(plan({ cwd: '/workspace', line: '/plan on' })).resolves.toMatchObject({ active: false })
    expect(calls).toEqual(['selected'])
  } finally {
    await queue.close()
  }
})
