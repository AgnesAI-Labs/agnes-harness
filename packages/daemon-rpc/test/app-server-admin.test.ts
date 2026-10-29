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
  createPlatform,
  createSecretsFile,
  resolveProfile,
} from '@agnes/host'
import { jcs } from '@agnes/protocol'
import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
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
    const credential = {
      provider: 'mcp-oauth',
      accessToken: 'fixture-token',
      expiresAt: 2000000000000,
      refreshToken: 'synthetic-refresh',
      scope: ['read'],
      grantId: 'synthetic-grant',
    }
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: 'srv-1', credential })).toMatchObject({
      result: {},
    })
    expect(await createCredentialStore({ root: home }).read('secret://mcp-oauth/srv-1')).toMatchObject({
      kind: 'oauth',
      ...credential,
    })
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: '../other', credential })).toMatchObject({
      error: { code: -32602, data: { messageKey: 'appServer.errors.invalidParams' } },
    })
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
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: 'srv-1', credential })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
  } finally {
    await endpoint.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
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
