import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import {
  canAccessResourceControl,
  jcs,
  type McpServerDefinitionInput,
  type ResourceControlMethodName,
  rpcError,
  type SkillImportParams,
  sha256Hex,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeIntegrity } from '../src/packages/mcp-import-artifacts.js'
import { resourcePort } from '../src/packages/mcp-import-state.js'
import type { PackageAdminAuthority } from '../src/packages/permissions.js'
import { skillEnvironment } from '../src/packages/skill-environment.js'
import { createSkillImportService } from '../src/packages/skill-import.js'

// Capture the authority the installer receives so its resource callback can be exercised directly.
const seen = vi.hoisted(() => ({
  authority: undefined as undefined | { resources: (m: string, d: object) => Promise<unknown> },
}))
vi.mock('@agnes/host', async (importActual) => {
  const actual = await importActual<typeof import('@agnes/host')>()
  return {
    ...actual,
    createSkillInstaller: (...args: Parameters<typeof actual.createSkillInstaller>) => {
      const installer = actual.createSkillInstaller(...args)
      return {
        ...installer,
        request: (invocation: never, authority: never, signal: never) => {
          seen.authority = authority
          return installer.request(invocation, authority, signal)
        },
      }
    },
  }
})

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
function fixture(chosenMcp: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-complete-skill-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  for (const path of [source, home, workspace]) mkdirSync(path)
  for (const name of ['first', 'second']) {
    const path = join(source, name)
    mkdirSync(join(path, 'bin'), { recursive: true })
    writeFileSync(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Synthetic fixture\n---\nRun the bundled tool.`,
    )
    writeFileSync(join(path, 'bin', 'main.mjs'), "throw Error('installation must never execute this')")
  }
  let revision = ''
  const calls: { method: string; permissions: readonly string[] }[] = []
  const servers = new Map<
    string,
    {
      serverId: string
      definition: McpServerDefinitionInput
      revision: string
      trust: string
      desired: string
      actual: string
    }
  >()
  const operations = new Map<string, Record<string, unknown>>()
  let environmentState: 'satisfied' | 'missing' = 'satisfied',
    nodeVersion = '24.20.0',
    failEnable = false
  let failingServer: string | undefined, failingDisable: string | undefined
  let beforeEnable: (() => Promise<void>) | undefined
  const skillState = { desired: 'disabled', trust: 'untrusted', actual: 'disabled' }
  const serviceOptions: Parameters<typeof createSkillImportService>[0] = {
    directory: join(root, 'operations'),
    home,
    workspace,
    profile: 'local-dev',
    discovery: { roots: skillRoots, discover: discoverSkillRoot },
    environment: async () => [{ name: 'node', state: 'satisfied', evidence: 'probed', actual: '24.20.0' }],
    mcpEnvironment: async () => [
      { name: 'node', state: environmentState, evidence: 'probed', actual: nodeVersion },
    ],
    resources: {
      call: async (method, params, granted) => {
        calls.push({ method, permissions: granted?.permissions ?? [] })
        const data = params as Record<string, unknown>
        if (method === '_agnes/v1/resources.operation.get')
          return operations.get(String(data.operationId)) ?? { state: 'succeeded' }
        if (method === '_agnes/v1/mcp.servers.list') return { items: [...servers.values()] }
        if (method === '_agnes/v1/mcp.servers.get') {
          const server = servers.get(String(data.serverId))
          if (!server) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_NOT_FOUND' })
          return server
        }
        if (method.startsWith('_agnes/v1/mcp.servers.')) {
          const definition = data.definition as McpServerDefinitionInput | undefined
          const id = definition?.serverId ?? String(data.serverId),
            prior = servers.get(id)
          if (method.endsWith('.create')) {
            if (prior) throw rpcError('SEMANTIC_REJECTED', { code: 'MCP_ALREADY_EXISTS' })
            if (!definition) throw new Error('Missing definition')
            servers.set(id, {
              serverId: id,
              definition,
              revision: sha256Hex(jcs(definition)),
              trust: 'untrusted',
              desired: 'disabled',
              actual: 'disabled',
            })
          } else {
            if (!prior || prior.revision !== data.expectedRevision)
              throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
            if (method.endsWith('.remove')) servers.delete(id)
            if (method.endsWith('.trust.set')) prior.trust = String(data.trust)
            if (method.endsWith('.disable') && id !== failingDisable) {
              prior.desired = 'disabled'
              prior.actual = 'disabled'
            }
            if (method.endsWith('.enable') || method.endsWith('.reconnect')) {
              prior.desired = 'enabled'
              prior.actual = failEnable || id === failingServer ? 'unavailable' : 'ready'
              await beforeEnable?.()
            }
          }
          const operationId = String(data.commandId)
          operations.set(operationId, {
            state:
              ((method.endsWith('.enable') || method.endsWith('.reconnect')) &&
                (failEnable || id === failingServer)) ||
              (method.endsWith('.disable') && id === failingDisable)
                ? 'failed'
                : 'succeeded',
            ...(((method.endsWith('.enable') || method.endsWith('.reconnect')) &&
              (failEnable || id === failingServer)) ||
            (method.endsWith('.disable') && id === failingDisable)
              ? { lastSafeError: { code: 'E_MCP_PROCESS_EXITED' } }
              : {}),
            ...(method.endsWith('.test') ? { result: { toolCount: 2 } } : {}),
          })
          return { operationId }
        }
        if (method === '_agnes/v1/skills.remove') {
          rmSync(join(home, 'skills', 'companion'), { recursive: true, force: true })
          return { operationId: data.commandId }
        }
        if (method === '_agnes/v1/resources.get' && String(data.resourceId).startsWith('mcp/')) {
          const server = servers.get(String(data.resourceId).slice(4))
          if (!server) throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND' })
          return server
        }
        if (method === '_agnes/v1/resources.get')
          return { revision, stale: false, resolution: { winner: true }, ...skillState }
        if (method === '_agnes/v1/skills.trust.set' || method === '_agnes/v1/resources.desired.set') {
          if (data.expectedRevision !== revision)
            throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
          if (method === '_agnes/v1/skills.trust.set') skillState.trust = String(data.trust)
          else {
            skillState.desired = String(data.state)
            skillState.actual = data.state === 'enabled' ? 'ready' : 'disabled'
          }
          return { operationId: data.commandId }
        }
        return { operationId: data.commandId }
      },
    },
  }
  let service = createSkillImportService(serviceOptions)
  cleanup.push(() => service.close())
  const authority: PackageAdminAuthority = {
    audience: 'admin',
    principalId: 'owner',
    clientId: 'client',
    permissions: ['packages.install', 'packages.read'],
  }
  let command = 0
  const request = (
    input: Omit<SkillImportParams, 'profile' | 'clientId' | 'commandId'>,
    changes: Partial<PackageAdminAuthority> = {},
  ) =>
    service.call(
      {
        ...input,
        ...(['prepare', 'check', 'commit'].includes(input.action) &&
        input.mcpServers === undefined &&
        chosenMcp.length
          ? { mcpServers: chosenMcp }
          : {}),
        profile: 'local-dev',
        clientId: changes.clientId ?? 'client',
        commandId: `command-${++command}`,
      },
      { ...authority, ...changes },
    )
  return {
    root,
    calls,
    source,
    home,
    service,
    list: (changes: Partial<PackageAdminAuthority> = {}) =>
      service.list('local-dev', { ...authority, ...changes }),
    restart: async () => {
      await service.close()
      service = createSkillImportService(serviceOptions)
    },
    servers,
    skillState,
    environment: (state: 'satisfied' | 'missing', actual = '24.22.1') => {
      environmentState = state
      nodeVersion = actual
    },
    failEnable: (value: boolean) => {
      failEnable = value
    },
    failServer: (id?: string) => {
      failingServer = id
    },
    failDisable: (id?: string) => {
      failingDisable = id
    },
    beforeEnable: (fn: () => Promise<void>) => {
      beforeEnable = fn
    },
    authority,
    request,
    revision: (value: string) => {
      revision = value
    },
  }
}

it('selects and installs complete Skills through the shared installer without running source code', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'selection_required',
    candidates: ['first', 'second'],
  })
  const prepared = await s.request({ action: 'prepare', source, subdirectory: 'second' })
  if (!prepared.proposalId || !prepared.revision || !prepared.digest)
    throw new Error('missing prepared identity')
  const proposalId = prepared.proposalId
  expect(prepared).toMatchObject({
    state: 'prepared',
    name: 'second',
    scope: 'user',
    files: ['AGH-SKILL.json', 'SKILL.md', 'bin/main.mjs'],
    environment: [{ name: 'node', state: 'satisfied' }],
  })
  expect(existsSync(join(s.home, 'skills/second'))).toBe(false)
  await expect(
    s.request({ action: 'commit', proposalId: prepared.proposalId, expectedDigest: '0'.repeat(64) }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_SOURCE_CHANGED' } })
  await expect(
    s.request({ action: 'status', proposalId: prepared.proposalId }, { principalId: 'other' }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_PROPOSAL_UNAVAILABLE' } })
  s.revision(prepared.revision)
  await s.request(
    { action: 'commit', proposalId: prepared.proposalId, expectedDigest: prepared.digest },
    { clientId: 'second-connection' },
  )
  await expect.poll(async () => (await s.request({ action: 'status', proposalId })).state).toBe('installed')
  expect(readFileSync(join(s.home, 'skills/second/bin/main.mjs'), 'utf8')).toContain('must never execute')
})

it('checks a repository asynchronously, resolves a sole Skill and allows cancellation without publication', async () => {
  const s = fixture()
  rmSync(join(s.source, 'second'), { recursive: true })
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const check = await s.request({ action: 'check', source })
  expect(check).toMatchObject({ state: 'running', phase: 'acquiring' })
  expect(check.proposalId).toBeTruthy()
  if (!check.proposalId) throw new Error('missing check id')
  const checkId = check.proposalId
  await expect(
    s.request({ action: 'status', proposalId: checkId }, { principalId: 'other' }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_PROPOSAL_UNAVAILABLE' } })
  await expect
    .poll(async () => (await s.request({ action: 'status', proposalId: checkId })).state)
    .toBe('prepared')
  const prepared = await s.request({ action: 'status', proposalId: check.proposalId })
  if (!prepared.proposalId) throw new Error('missing proposal')
  expect(prepared).toMatchObject({ state: 'prepared', name: 'first', fileCount: 3 })
  expect(existsSync(join(s.home, 'skills/first'))).toBe(false)
  await s.request({ action: 'cancel', proposalId: check.proposalId })
  expect(await s.request({ action: 'status', proposalId: prepared.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  const cancelled = await s.request({ action: 'check', source })
  if (!cancelled.proposalId) throw new Error('missing check id')
  expect(await s.request({ action: 'cancel', proposalId: cancelled.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  const failed = await s.request({ action: 'check', source: { type: 'path', ref: 'path:missing-fixture' } })
  if (!failed.proposalId) throw new Error('missing check id')
  const failedId = failed.proposalId
  await expect
    .poll(async () => (await s.request({ action: 'status', proposalId: failedId })).state)
    .toBe('failed')
  expect(await s.request({ action: 'status', proposalId: failed.proposalId })).toMatchObject({
    message: 'SKILL_SOURCE_UNAVAILABLE',
  })
})

it('refuses a foreign activation bundle and native declarations without falling back to Skill import', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  writeFileSync(join(s.source, 'package.json'), '{"dsh":null}')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_FOREIGN_RUNTIME_UNSUPPORTED',
  })
  writeFileSync(join(s.source, 'cordis.patch.yml'), '!!js throw new Error("must never execute")')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_FOREIGN_RUNTIME_UNSUPPORTED',
  })
  writeFileSync(join(s.source, 'package.json'), '{"agnes":null}')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_NATIVE_PACKAGE_USE_PLUGIN_INSTALL',
  })
  writeFileSync(
    join(s.source, 'first/SKILL.md'),
    '---\nname: first\ndescription: Restricted foreign Skill\nallowed-tools: private_tool\n---\nInstructions.',
  )
  expect(await s.request({ action: 'prepare', source, subdirectory: 'first' })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_DOCUMENT_PROFILE_UNSUPPORTED',
  })
})

it('binds retry identities and cancels prepared content without publication', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const input: SkillImportParams = {
    profile: 'local-dev',
    clientId: 'client',
    commandId: 'same-command',
    action: 'prepare',
    source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    subdirectory: 'first',
  }
  const first = await s.service.call(input, s.authority)
  if (!first.proposalId) throw new Error('missing prepared identity')
  expect(await s.service.call(input, s.authority)).toEqual(first)
  await expect(s.service.call({ ...input, subdirectory: 'second' }, s.authority)).rejects.toMatchObject({
    data: { reason: 'COMMAND_ID_CONFLICT' },
  })
  expect(await s.request({ action: 'cancel', proposalId: first.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  expect(existsSync(join(s.home, 'skills/first'))).toBe(false)
  await expect(s.request({ action: 'prepare', source }, { installer: 'agent' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
})

it('refuses local source trees overlapping private installation state before acquisition', async () => {
  const s = fixture()
  const secret = join(s.home, 'secrets')
  mkdirSync(secret)
  writeFileSync(join(secret, 'SKILL.md'), 'not an importable private resource')
  await expect(
    s.request({ action: 'prepare', source: { type: 'path', ref: `path:${secret.replaceAll('\\', '/')}` } }),
  ).rejects.toThrow('protected installation state')
  expect(existsSync(join(s.home, 'skills'))).toBe(false)
})

it.each([
  'default',
  'opt-in',
  'empty',
  'changed',
  'invalid',
  'test-without-selection',
  'unsupported',
] as const)('registers only explicitly selected MCP connections (%s)', async (scenario) => {
  const s = fixture(),
    path = '.agents/skills/companion'
  if (scenario !== 'empty') {
    mkdirSync(join(s.source, path), { recursive: true })
    writeFileSync(
      join(s.source, path, 'SKILL.md'),
      '---\nname: companion\ndescription: CLI workflow\n---\nUse the CLI without MCP.',
    )
  }
  writeFileSync(join(s.source, 'server.mjs'), 'throw Error("installation must not execute scripts")')
  writeFileSync(
    join(s.source, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        optional:
          scenario === 'unsupported'
            ? { command: 'node', args: ['./server.mjs'], env: { TOKEN: 'synthetic-inline-value' } }
            : { command: 'node', args: ['./server.mjs'] },
        private: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
      },
    }),
  )
  if (scenario === 'default') {
    s.environment('missing')
    s.servers.set('optional', {
      serverId: 'optional',
      definition: {
        serverId: 'optional',
        displayName: 'Foreign',
        transport: { kind: 'stdio', executable: 'node', args: [] },
        secretBinding: { kind: 'none' },
        sandboxProfile: 'strict',
      },
      revision: 'a'.repeat(64),
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
    })
  }
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  if (scenario === 'invalid') {
    await expect(s.request({ action: 'prepare', source, mcpServers: ['absent'] })).rejects.toMatchObject({
      code: 'MCP_SELECTION_INVALID',
    })
    expect(s.servers.size).toBe(0)
    return
  }
  const chosen = scenario === 'opt-in' ? ['optional'] : []
  const prepared = await s.request({
    action: 'prepare',
    source,
    ...(chosen.length ? { mcpServers: chosen } : {}),
  })
  expect(prepared.mcp?.requiredCredentials).toEqual([])
  expect(prepared.mcp?.issues).toEqual([])
  if (!chosen.length) expect(prepared.environment).toEqual([])
  if (scenario === 'unsupported') {
    expect(prepared.mcp?.servers).toEqual([])
    expect(prepared.warnings).toContain('MCP_OPTIONAL_CONFIG_UNSUPPORTED')
    expect(JSON.stringify(prepared)).not.toContain('synthetic-inline-value')
  } else
    expect(prepared.mcp?.servers.map((row) => ({ id: row.serverId, selected: row.selected }))).toEqual([
      { id: 'optional', selected: scenario === 'opt-in' },
      { id: 'private', selected: false },
    ])
  const identity = { proposalId: prepared.proposalId!, expectedDigest: prepared.digest! }
  if (scenario !== 'empty') s.revision(prepared.mcp!.skills[0]!.revision!)
  const commit = {
    action: 'commit' as const,
    ...identity,
    skillDirectories: scenario === 'empty' ? [] : [path],
    ...(scenario === 'opt-in' ? { mcpServers: chosen, testConnection: true } : {}),
  }
  const grant = {
    permissions: [
      'packages.read',
      'packages.install',
      'packages.activate',
      'packages.trust',
      'packages.remove',
    ] as PackageAdminAuthority['permissions'],
  }
  if (['empty', 'changed', 'test-without-selection'].includes(scenario)) {
    await expect(
      s.request(
        {
          ...commit,
          ...(scenario === 'changed'
            ? { mcpServers: ['optional'] }
            : scenario === 'test-without-selection'
              ? { testConnection: true }
              : {}),
        },
        grant,
      ),
    ).rejects.toMatchObject({
      code: scenario === 'changed' ? 'MCP_SELECTION_CHANGED' : 'MCP_SELECTION_REQUIRED',
    })
    expect(s.servers.size).toBe(0)
    expect(existsSync(join(s.home, 'skills/companion'))).toBe(false)
    return
  }
  await s.request(commit, grant)
  const settled = async () => {
    await expect
      .poll(async () => (await s.request({ action: 'status', proposalId: identity.proposalId })).state)
      .not.toBe('running')
    return s.request({ action: 'status', proposalId: identity.proposalId })
  }
  const installed = await settled()
  expect(installed.state).toBe('installed')
  expect(
    installed.mcp?.servers.filter((row) => !row.selected).every((row) => row.state === 'not-installed'),
  ).toBe(true)
  expect(existsSync(join(s.home, 'skills/companion/SKILL.md'))).toBe(true)
  expect(s.servers.size).toBe(scenario === 'opt-in' || scenario === 'default' ? 1 : 0)
  if (scenario === 'default') expect(s.servers.get('optional')!.revision).toBe('a'.repeat(64))
  expect((await s.list())[0]?.resources.filter((row) => row.kind === 'mcp')).toHaveLength(
    scenario === 'opt-in' ? 1 : 0,
  )
  if (scenario !== 'opt-in') {
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    const checked = await settled()
    expect(checked.activation?.resources).toHaveLength(1)
    expect(checked.activation?.environment).toEqual([])
    await s.request(
      {
        action: 'enable',
        ...identity,
        expectedActivationDigest: checked.activation!.digest,
        trustResources: true,
      },
      grant,
    )
    expect((await settled()).phase).toBe('enabled')
  }
  await s.restart()
  expect((await s.list())[0]?.resources.filter((row) => row.kind === 'mcp')).toHaveLength(
    scenario === 'opt-in' ? 1 : 0,
  )
  await s.request({ action: 'uninstall', ...identity }, grant)
  expect((await settled()).state).toBe('cancelled')
  expect(s.servers.size).toBe(scenario === 'default' ? 1 : 0)
})

it.each([false, true])(
  'imports MCP definitions and selected companion Skills without adopting existing resources (changed=%s)',
  async (changed) => {
    const s = fixture(['sample'])
    const path = '.agents/skills/companion'
    for (const name of ['companion-a', 'companion-b']) {
      mkdirSync(join(s.source, '.agents/skills', name), { recursive: true })
      writeFileSync(
        join(s.source, '.agents/skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Optional companion\n---\nInstructions.`,
      )
    }
    mkdirSync(join(s.source, path), { recursive: true })
    writeFileSync(
      join(s.source, path, 'SKILL.md'),
      '---\nname: companion\ndescription: Synthetic MCP companion\n---\nUse the registered MCP connection.',
    )
    writeFileSync(join(s.source, 'server.mjs'), 'throw Error("must not run during preview or registration")')
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({ mcpServers: { sample: { command: 'node', args: ['./server.mjs'] } } }),
    )
    const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
    const prepared = await s.request({ action: 'prepare', source })
    expect(prepared).toMatchObject({
      state: 'prepared',
      kind: 'mcp',
      mcp: {
        servers: [{ serverId: 'sample', state: 'planned' }],
        skills: expect.arrayContaining([
          {
            path,
            name: 'companion',
            state: 'prepared',
            fileCount: expect.any(Number),
            digest: expect.any(String),
            revision: expect.any(String),
          },
        ]),
      },
    })
    expect(s.servers.size).toBe(0)
    expect(await s.list()).toEqual([])
    expect(prepared.mcp?.skills).toHaveLength(3)
    expect(prepared.mcp?.skills.every((skill) => skill.state === 'prepared')).toBe(true)
    expect(existsSync(join(s.home, 'skills/companion'))).toBe(false)
    const id = prepared.proposalId,
      digest = prepared.digest,
      revision = prepared.mcp?.skills[0]?.revision
    if (!id || !digest || !revision) throw new Error('Missing prepared identity')
    s.revision(revision)
    await expect(
      s.request({ action: 'commit', proposalId: id, expectedDigest: digest, testConnection: true }),
    ).rejects.toMatchObject({ code: rpcError('CAPABILITY_DENIED').code })
    await expect(
      s.request({ action: 'commit', proposalId: id, expectedDigest: '0'.repeat(64) }),
    ).rejects.toMatchObject({ data: { reason: 'SKILL_SOURCE_CHANGED' } })
    await s.request({ action: 'commit', proposalId: id, expectedDigest: digest, skillDirectories: [path] })
    await expect
      .poll(async () => (await s.request({ action: 'status', proposalId: id })).state)
      .toBe('installed')
    expect(s.servers.get('sample')).toMatchObject({ trust: 'untrusted', desired: 'disabled' })
    expect(existsSync(join(s.home, 'skills/companion/SKILL.md'))).toBe(true)
    const inventory = await s.list()
    expect(inventory).toMatchObject([
      {
        id,
        name: 'source',
        resources: [
          { kind: 'mcp', resourceId: 'mcp/sample', state: 'present', desired: 'disabled' },
          { kind: 'skill', name: 'companion', state: 'present' },
        ],
      },
    ])
    expect(await s.list({ principalId: 'another-owner' })).toEqual([])
    await expect(s.list({ permissions: [] })).rejects.toMatchObject({
      code: rpcError('CAPABILITY_DENIED').code,
    })
    for (const action of ['uninstall', 'rollback'] as const)
      await expect(s.request({ action, proposalId: id, expectedDigest: digest })).rejects.toMatchObject({
        code: rpcError('CAPABILITY_DENIED').code,
      })
    const conflict = await s.request({ action: 'prepare', source })
    expect(conflict.mcp?.issues).toContain('MCP_SERVER_CONFLICT')
    if (changed) s.servers.get('sample')!.revision = 'b'.repeat(64)
    else {
      // Old receipts remain discoverable without newly added package metadata.
      const receipt = join(s.root, 'operations/mcp/receipts', `${id}.json`)
      const stored = JSON.parse(readFileSync(receipt, 'utf8'))
      delete stored.metadata
      writeFileSync(receipt, JSON.stringify(stored))
      s.servers.delete('sample')
    }
    await s.restart()
    expect((await s.list())[0]?.resources[0]?.state).toBe(changed ? 'changed' : 'missing')
    for (const action of ['uninstall', 'rollback'] as const)
      await expect(s.request({ action, proposalId: id, expectedDigest: digest })).rejects.toMatchObject({
        code: rpcError('CAPABILITY_DENIED').code,
      })
    await s.request(
      { action: changed ? 'uninstall' : 'rollback', proposalId: id, expectedDigest: digest },
      { permissions: ['packages.read', 'packages.install', 'packages.remove'] },
    )
    await expect
      .poll(async () => (await s.request({ action: 'status', proposalId: id })).state)
      .toBe(changed ? 'failed' : 'cancelled')
    expect(s.servers.has('sample')).toBe(changed)
    expect((await s.list()).length).toBe(changed ? 1 : 0)
    if (changed)
      expect((await s.request({ action: 'status', proposalId: id })).message).toBe('MCP_RESOURCE_CONFLICT')
  },
)

it.each([false, true])(
  'coordinates reviewed group state and preserves partial failures (failure=%s)',
  async (failure) => {
    const s = fixture(['group']),
      path = '.agents/skills/companion'
    mkdirSync(join(s.source, path), { recursive: true })
    writeFileSync(
      join(s.source, path, 'SKILL.md'),
      '---\nname: companion\ndescription: Group state fixture\n---\nUse the connection.',
    )
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({ mcpServers: { group: { command: 'node', args: ['./server.mjs'] } } }),
    )
    writeFileSync(
      join(s.source, 'server.mjs'),
      '// Runtime entry exists; this unit test does not execute it.',
    )
    s.environment('missing', '24.20.0')
    const prepared = await s.request({
      action: 'prepare',
      source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    })
    const id = prepared.proposalId!,
      digest = prepared.digest!
    s.revision(prepared.mcp!.skills[0]!.revision!)
    const identity = { proposalId: id, expectedDigest: digest }
    const grant = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.trust',
        'packages.activate',
      ] as PackageAdminAuthority['permissions'],
    }
    const status = () => s.request({ action: 'status', proposalId: id })
    const settled = async () => {
      await expect.poll(async () => (await status()).state).not.toBe('running')
      return status()
    }
    await s.request({ action: 'commit', ...identity, skillDirectories: [path] })
    await settled()
    await expect(s.request({ action: 'activation-check', ...identity, enable: true })).rejects.toMatchObject({
      code: rpcError('CAPABILITY_DENIED').code,
    })
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    expect((await settled()).activation?.resources.find((row) => row.kind === 'mcp')?.issues).toContain(
      'MCP_ENVIRONMENT_BLOCKED',
    )
    expect(s.servers.get('group')?.desired).toBe('disabled')
    s.environment('satisfied', '24.22.1')
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    let checked = await settled()
    expect(checked.activation).toMatchObject({
      issues: [],
      environment: [{ actual: '24.22.1', state: 'satisfied' }],
    })
    await s.request(
      { action: 'enable', ...identity, expectedActivationDigest: checked.activation!.digest },
      grant,
    )
    expect(
      (await settled()).activation?.outcomes?.every(
        (row) => row.status === 'skipped' && row.code === 'MCP_TRUST_REQUIRED',
      ),
    ).toBe(true)
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    checked = await settled()
    const revision = s.servers.get('group')!.revision
    await expect(
      s.request(
        {
          action: 'enable',
          ...identity,
          expectedActivationDigest: checked.activation!.digest,
          trustResources: true,
        },
        { permissions: ['packages.read', 'packages.trust', 'packages.activate'] },
      ),
    ).rejects.toMatchObject({ code: rpcError('CAPABILITY_DENIED').code })
    s.servers.get('group')!.revision = 'c'.repeat(64)
    await s.request(
      {
        action: 'enable',
        ...identity,
        expectedActivationDigest: checked.activation!.digest,
        trustResources: true,
      },
      grant,
    )
    expect((await settled()).activation?.outcomes).toEqual(
      expect.arrayContaining([
        { resourceId: 'mcp/group', status: 'skipped', code: 'MCP_ACTIVATION_CHANGED' },
      ]),
    )
    expect(s.skillState.desired).toBe('enabled')
    s.servers.get('group')!.revision = revision
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    checked = await settled()
    await s.restart()
    s.failEnable(failure)
    await s.request(
      {
        action: 'enable',
        ...identity,
        expectedActivationDigest: checked.activation!.digest,
        trustResources: true,
      },
      grant,
    )
    const enabled = await settled()
    expect(enabled.state).toBe('installed')
    expect(enabled.phase).toBe(failure ? 'partially-enabled' : 'enabled')
    expect(s.servers.get('group')).toMatchObject({ trust: 'trusted', desired: 'enabled' })
    expect(s.skillState.desired).toBe('enabled')
    expect((await s.list())[0]).toMatchObject({
      desired: 'enabled',
      primaryStatus: { state: failure ? 'blocked' : 'ready' },
    })
    if (failure)
      expect(enabled.activation?.outcomes).toEqual(
        expect.arrayContaining([{ resourceId: 'mcp/group', status: 'failed', code: 'E_MCP_PROCESS_EXITED' }]),
      )
    await s.restart()
    expect(await status()).toMatchObject({
      state: 'installed',
      activation: { enable: true, outcomes: enabled.activation!.outcomes },
    })
    // Stop remains available with an unavailable runtime and without permission to add new trust.
    s.environment('missing')
    const activateOnly = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.activate',
      ] as PackageAdminAuthority['permissions'],
    }
    await s.request({ action: 'activation-check', ...identity, enable: false }, activateOnly)
    checked = await settled()
    expect(checked).toMatchObject({ state: 'installed', activation: { environment: [], issues: [] } })
    await s.request(
      { action: 'disable', ...identity, expectedActivationDigest: checked.activation!.digest },
      activateOnly,
    )
    expect((await settled()).state).toBe('installed')
    expect(s.servers.get('group')?.desired).toBe('disabled')
    expect(s.skillState.desired).toBe('disabled')
    expect((await s.list())[0]?.desired).toBe('disabled')
  },
)

it.each(['failure', 'missing', 'credential', 'trust', 'cancel', 'stop-failure'] as const)(
  'continues safe members and records per-item outcomes (%s)',
  async (scenario) => {
    const s = fixture(['a-bad', 'z-good']),
      path = '.agents/skills/companion'
    mkdirSync(join(s.source, path), { recursive: true })
    writeFileSync(
      join(s.source, path, 'SKILL.md'),
      '---\nname: companion\ndescription: CLI capable fixture\n---\nUse the available CLI.',
    )
    const local = { command: 'node', args: ['./server.mjs'] }
    const bad =
      scenario === 'credential'
        ? { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }
        : scenario === 'missing'
          ? { command: 'node', args: ['./missing.mjs'] }
          : local
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'a-bad': bad, 'z-good': local } }),
    )
    writeFileSync(join(s.source, 'server.mjs'), '// synthetic entry; unit test never runs it')
    const prepared = await s.request({
      action: 'prepare',
      source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
      ...(scenario === 'credential'
        ? { credentialBindings: { 'a-bad.header.Authorization': 'secret://test/api' } }
        : {}),
    })
    const identity = { proposalId: prepared.proposalId!, expectedDigest: prepared.digest! }
    const status = () => s.request({ action: 'status', proposalId: identity.proposalId })
    const settled = async () => {
      await expect.poll(async () => (await status()).state).not.toBe('running')
      return status()
    }
    s.revision(prepared.mcp!.skills[0]!.revision!)
    await s.request({ action: 'commit', ...identity, skillDirectories: [path] })
    await settled()
    const grant = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.activate',
        ...(scenario === 'trust' ? [] : ['packages.trust']),
      ] as PackageAdminAuthority['permissions'],
    }
    if (scenario === 'trust') {
      s.servers.get('z-good')!.trust = 'trusted'
      s.skillState.trust = 'trusted'
    }
    const review = async (enable: boolean) => {
      await s.request({ action: 'activation-check', ...identity, enable }, grant)
      return (await settled()).activation!
    }
    let checked = await review(true)
    if (scenario === 'failure') s.failServer('a-bad')
    let release: () => void = () => {},
      started: () => void = () => {}
    const begun = new Promise<void>((done) => {
        started = done
      }),
      gate = new Promise<void>((done) => {
        release = done
      })
    if (scenario === 'cancel')
      s.beforeEnable(async () => {
        started()
        await gate
      })
    await s.request(
      { action: 'enable', ...identity, expectedActivationDigest: checked.digest, trustResources: true },
      grant,
    )
    if (scenario === 'cancel') {
      await begun
      const cancelled = s.request({ action: 'cancel', proposalId: identity.proposalId })
      release()
      await cancelled
      expect((await status()).state).toBe('interrupted')
      expect([...s.servers.values()].filter((row) => row.desired === 'enabled')).toHaveLength(1)
      expect(s.skillState.desired).toBe('disabled')
      return
    }
    let result = await settled()
    expect(s.servers.get('z-good')).toMatchObject({ desired: 'enabled', actual: 'ready' })
    expect(s.skillState).toMatchObject({ desired: 'enabled', actual: 'ready' })
    if (scenario !== 'stop-failure') {
      expect(result.phase).toBe('partially-enabled')
      expect(result.activation?.outcomes?.find((row) => row.resourceId === 'mcp/a-bad')).toMatchObject({
        status: scenario === 'failure' ? 'failed' : 'skipped',
      })
      expect((await s.list())[0]?.primaryStatus?.reason['zh-CN']).toContain('部分启用')
      await s.restart()
      expect((await s.list())[0]?.result.activation?.outcomes).toEqual(result.activation?.outcomes)
    }
    if (scenario === 'failure') {
      // Only the unhealthy connection should be attempted on retry. Restarting the ready one would now fail.
      s.failServer('z-good')
      checked = await review(true)
      await s.request(
        { action: 'enable', ...identity, expectedActivationDigest: checked.digest, trustResources: true },
        grant,
      )
      result = await settled()
      expect(result.phase).toBe('enabled')
      expect((await s.list())[0]?.primaryStatus?.state).toBe('ready')
    }
    if (scenario === 'stop-failure') s.failDisable('a-bad')
    checked = await review(false)
    await s.request({ action: 'disable', ...identity, expectedActivationDigest: checked.digest }, grant)
    result = await settled()
    expect(s.skillState.desired).toBe('disabled')
    expect(s.servers.get('z-good')!.desired).toBe('disabled')
    if (scenario === 'stop-failure') {
      expect(result.phase).toBe('partially-disabled')
      expect(s.servers.get('a-bad')!.desired).toBe('enabled')
      expect(result.activation?.outcomes?.find((row) => row.resourceId === 'mcp/a-bad')?.status).toBe(
        'failed',
      )
      // A delayed resource recovery must take precedence over the historical partial result.
      Object.assign(s.servers.get('a-bad')!, { desired: 'disabled', actual: 'disabled' })
      expect((await s.list())[0]?.primaryStatus?.state).toBe('disabled')
    }
  },
)

it('binds MCP credential references and tests only after an explicit current grant', async () => {
  const s = fixture(['remote'])
  writeFileSync(
    join(s.source, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${API_TOKEN}' },
        },
      },
    }),
  )
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const missing = await s.request({ action: 'prepare', source })
  expect(missing.mcp?.requiredCredentials).toEqual(['remote.header.Authorization'])
  const prepared = await s.request({
    action: 'prepare',
    source,
    credentialBindings: { 'remote.header.Authorization': 'secret://test/mcp-token' },
  })
  expect(prepared.mcp?.requiredCredentials).toEqual([])
  if (!prepared.proposalId || !prepared.digest) throw new Error('Missing proposal')
  const id = prepared.proposalId
  await s.request(
    { action: 'commit', proposalId: id, expectedDigest: prepared.digest, testConnection: true },
    {
      permissions: [
        'packages.install',
        'packages.read',
        'packages.trust',
        'packages.activate',
        'credentials.read',
      ],
    },
  )
  await expect
    .poll(async () => (await s.request({ action: 'status', proposalId: id })).state)
    .toBe('installed')
  expect((await s.request({ action: 'status', proposalId: id })).mcp?.servers[0]).toMatchObject({
    state: 'tested',
    toolCount: 2,
  })
  expect(s.servers.get('remote')).toMatchObject({
    desired: 'disabled',
    definition: { secretBinding: { kind: 'http-bearer', credentialRef: 'secret://test/mcp-token' } },
  })
})

it.each([false, true])(
  'preserves old prepared installations and detects changed artifacts (%s)',
  async (changed) => {
    const s = fixture(['legacy'])
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({ mcpServers: { legacy: { command: 'node', args: ['./server.mjs'] } } }),
    )
    writeFileSync(join(s.source, 'server.mjs'), '// legacy entry')
    const prepared = await s.request({
      action: 'prepare',
      source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    })
    const id = prepared.proposalId!,
      identity = { proposalId: id, expectedDigest: prepared.digest! }
    const status = () => s.request({ action: 'status', proposalId: id })
    const settled = async () => {
      await expect.poll(async () => (await status()).state).not.toBe('running')
      return status()
    }
    await s.request({ action: 'commit', ...identity })
    await settled()
    // Model the existing on-disk receipt, including an already-reviewed runtime preview.
    const attempt = '12345678-1234-1234-1234-123456789012'
    const payload = join(s.root, 'operations/mcp/runtimes', id, attempt, 'payload')
    mkdirSync(payload, { recursive: true })
    writeFileSync(join(payload, 'server.mjs'), '// old prepared entry')
    const server = s.servers.get('legacy')!
    if (server.definition.transport.kind !== 'stdio') throw Error('Expected stdio')
    server.definition.transport.args = [join(payload, 'server.mjs')]
    if ('workspacePath' in server.definition) server.definition.workspacePath = payload
    server.revision = sha256Hex(jcs(server.definition))
    const receipt = join(s.root, 'operations/mcp/receipts', `${id}.json`)
    const stored = JSON.parse(readFileSync(receipt, 'utf8'))
    stored.result.mcp.servers[0] = {
      ...stored.result.mcp.servers[0],
      revision: server.revision,
      args: [join(payload, 'server.mjs')],
      cwd: payload,
    }
    stored.runtime = {
      ready: true,
      attempts: [attempt],
      root: payload,
      integrity: await runtimeIntegrity(payload, new AbortController().signal),
      mode: 'release',
      release: { name: 'legacy', version: '1.0.0' },
    }
    writeFileSync(receipt, JSON.stringify(stored))
    if (changed) writeFileSync(join(payload, 'server.mjs'), '// externally changed')
    await s.restart()
    expect(await s.list()).toHaveLength(1)
    const grant = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.activate',
        'packages.trust',
        'packages.remove',
      ] as PackageAdminAuthority['permissions'],
    }
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    const checked = await settled()
    expect(checked.activation?.runtime).toBeUndefined()
    expect(checked.activation?.resources[0]?.issues).toEqual(changed ? ['MCP_RUNTIME_CHANGED'] : [])
    if (!changed) {
      await s.request(
        {
          action: 'enable',
          ...identity,
          expectedActivationDigest: checked.activation!.digest,
          trustResources: true,
        },
        grant,
      )
      expect((await settled()).phase).toBe('enabled')
    }
    await s.request({ action: 'uninstall', ...identity }, grant)
    expect((await settled()).state).toBe('cancelled')
    expect(existsSync(payload)).toBe(false)
    expect(s.servers.has('legacy')).toBe(false)
  },
)

it.each(['node', 'python', 'missing', 'launcher'] as const)(
  'uses declared MCP commands without preparing a runtime (%s)',
  async (format) => {
    const s = fixture(['generic'])
    const entry = format === 'python' ? 'server.py' : 'server.mjs'
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          generic: {
            command: format === 'launcher' ? 'npx' : format === 'python' ? 'python' : 'node',
            args: format === 'launcher' ? ['--yes', 'example-mcp@1.2.3'] : ['./' + entry],
          },
        },
      }),
    )
    const marker = join(s.root, 'must-not-run')
    if (format !== 'missing')
      writeFileSync(join(s.source, entry), 'throw Error("must not execute during review")')
    writeFileSync(
      join(s.source, 'package.json'),
      JSON.stringify({
        name: 'unpublished-example',
        version: '1.2.3',
        packageManager: 'pnpm@10.34.5',
        dependencies: { example: '1.0.0' },
        scripts: {
          build: `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'executed')"`,
        },
      }),
    )
    const prepared = await s.request({
      action: 'prepare',
      source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    })
    const identity = { proposalId: prepared.proposalId!, expectedDigest: prepared.digest! }
    const status = () => s.request({ action: 'status', proposalId: identity.proposalId })
    const settled = async () => {
      await expect.poll(async () => (await status()).state).not.toBe('running')
      return status()
    }
    await s.request({ action: 'commit', ...identity })
    await settled()
    const grant = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.activate',
        'packages.trust',
      ] as PackageAdminAuthority['permissions'],
    }
    await s.request({ action: 'activation-check', ...identity, enable: true }, grant)
    const reviewed = await settled()
    expect(reviewed.activation?.runtime).toBeUndefined()
    expect(reviewed.activation?.resources[0]?.issues).toEqual(
      format === 'missing' ? ['MCP_LOCAL_ENTRY_MISSING'] : [],
    )
    if (format === 'missing') {
      await s.request(
        {
          action: 'enable',
          ...identity,
          expectedActivationDigest: reviewed.activation!.digest,
          trustResources: true,
        },
        grant,
      )
      expect((await settled()).activation?.outcomes).toEqual([
        { resourceId: 'mcp/generic', status: 'skipped', code: 'MCP_LOCAL_ENTRY_MISSING' },
      ])
    }
    // Old clients cannot re-enable the deleted preparation path, even with all former consents.
    await expect(
      s.request(
        {
          action: 'runtime-prepare',
          ...identity,
          runtimeMode: 'source',
          runtimeRegistry: 'npmmirror',
          runtimeBuild: true,
          runtimeNetwork: true,
          runtimeUnconfined: true,
          expectedActivationDigest: reviewed.activation!.digest,
        },
        grant,
      ),
    ).rejects.toMatchObject({ code: 'MCP_RUNTIME_MANUAL_REQUIRED' })
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(s.root, 'operations/mcp/runtimes'))).toBe(false)
    expect(s.servers.get('generic')).toMatchObject({ desired: 'disabled', trust: 'untrusted' })
    await s.restart()
    expect(await s.list()).toHaveLength(1)
  },
)

it('keeps management imports on the session resource allowlist and gates enabling on trust and activation', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const prepared = await s.request({ action: 'prepare', source, subdirectory: 'first' })
  if (!prepared.proposalId || !prepared.revision || !prepared.digest) throw new Error('missing identity')
  s.revision(prepared.revision)
  const proposalId = prepared.proposalId
  // enable:false by an install-only caller records a disabled desired state and never trusts.
  await s.request({ action: 'commit', proposalId, expectedDigest: prepared.digest })
  await expect.poll(async () => (await s.request({ action: 'status', proposalId })).state).toBe('installed')
  expect(existsSync(join(s.home, 'skills/first'))).toBe(true)
  expect(s.calls.map((c) => c.method)).not.toContain('_agnes/v1/skills.trust.set')
  expect(s.calls.find((c) => c.method === '_agnes/v1/resources.desired.set')?.permissions).toEqual([
    'resources.skills.write',
  ])
  const resources = seen.authority?.resources
  if (!resources) throw new Error('missing installer authority')
  s.calls.length = 0
  await expect(resources('_agnes/v1/skills.remove', {})).rejects.toMatchObject(rpcError('CAPABILITY_DENIED'))
  await expect(resources('_agnes/v1/mcp.servers.list', {})).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  await expect(resources('_agnes/v1/skills.trust.set', { trust: 'trusted' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  await expect(resources('_agnes/v1/resources.desired.set', { state: 'enabled' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  expect(s.calls).toEqual([])
})

it('admits every resource method the MCP import lifecycle calls, including reconnect', async () => {
  const granted = {
    audience: 'admin',
    principalId: 'p',
    clientId: 'c',
    permissions: [
      'packages.install',
      'packages.activate',
      'packages.trust',
      'packages.remove',
      'credentials.read',
    ],
  } as PackageAdminAuthority
  const methods: ResourceControlMethodName[] = [
    '_agnes/v1/resources.get',
    '_agnes/v1/resources.operation.get',
    '_agnes/v1/resources.desired.set',
    '_agnes/v1/mcp.servers.get',
    '_agnes/v1/mcp.servers.create',
    '_agnes/v1/mcp.servers.trust.set',
    '_agnes/v1/mcp.servers.test',
    '_agnes/v1/mcp.servers.enable',
    '_agnes/v1/mcp.servers.disable',
    '_agnes/v1/mcp.servers.reconnect',
    '_agnes/v1/mcp.servers.remove',
    '_agnes/v1/skills.trust.set',
    '_agnes/v1/skills.remove',
  ]
  const denied: string[] = []
  const port = resourcePort(
    {
      call: async (method, _params, authority) => {
        if (!authority || !canAccessResourceControl(method, authority)) denied.push(method)
        return {}
      },
    },
    'default',
    granted,
  )
  for (const method of methods) await port(method, {})
  expect(denied).toEqual([])
})

it('probes python3 before python and reports missing only when both fail', async () => {
  const probe = (available: Record<string, string>) => async (command: string) => {
    if (!(command in available)) throw new Error('ENOENT')
    return { stdout: `Python ${available[command]}\n` } as never
  }
  const probed = (available: Record<string, string>) =>
    skillEnvironment('.', ['tool.py'], '.', new AbortController().signal, probe(available))
  expect(await probed({ python3: '3.12.1' })).toEqual([
    { name: 'python', state: 'satisfied', evidence: 'probed', actual: '3.12.1' },
  ])
  expect(await probed({ python: '3.9.0' })).toMatchObject([{ name: 'python', actual: '3.9.0' }])
  expect(await probed({ python3: '3.12.1', python: '2.7.18' })).toMatchObject([{ actual: '3.12.1' }])
  expect(await probed({})).toEqual([{ name: 'python', state: 'missing', evidence: 'probed' }])
})

it.each(['rollback', 'activation-check'] as const)(
  'keeps an admitted commit exclusive against concurrent %s',
  async (action) => {
    const s = fixture(['sample'])
    writeFileSync(
      join(s.source, '.mcp.json'),
      JSON.stringify({ mcpServers: { sample: { url: 'https://example.com/mcp' } } }),
    )
    const prepared = await s.request({
      action: 'prepare',
      source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    })
    if (!prepared.proposalId || !prepared.digest) throw new Error('Missing prepared identity')
    const identity = { proposalId: prepared.proposalId, expectedDigest: prepared.digest }
    const granted = {
      permissions: [
        'packages.read',
        'packages.install',
        'packages.remove',
        'packages.activate',
      ] as PackageAdminAuthority['permissions'],
    }
    await Promise.all([
      s.request({ action: 'commit', ...identity }),
      s.request({ action, ...identity, ...(action === 'activation-check' ? { enable: true } : {}) }, granted),
    ])
    await expect
      .poll(async () => (await s.request({ action: 'status', proposalId: identity.proposalId })).state)
      .toBe('installed')
    const result = await s.request({ action: 'status', proposalId: identity.proposalId })
    expect(result.phase).toBe('complete')
    expect(result.activation).toBeUndefined()
    expect(s.servers.get('sample')).toMatchObject({ desired: 'disabled', trust: 'untrusted' })
    expect(existsSync(join(s.root, 'operations/mcp/sources', identity.proposalId))).toBe(true)
  },
)
