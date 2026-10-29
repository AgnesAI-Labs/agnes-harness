import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { authoringSandbox } from '@agnes/daemon-admin/packages/index'
import {
  type AutomaticPermissionEvidence,
  PrompterRouter,
  withPermissionContext,
} from '@agnes/daemon-rpc/local/prompter'
import { resolveToolCallPolicy, type ToolDef } from '@agnes/extension-api'
import type { HostSession, PluginManageInvocation } from '@agnes/host'
import {
  createPackageManager,
  emptyLock,
  readDevelopmentPlugin,
  withLock,
  writeLock,
} from '@agnes/package-manager'
import type { AuthoringCandidate, AuthoringTests, InferenceEvent } from '@agnes/protocol'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { toolPolicy } from '../../base/extensions/approval-policy/src/tool-policy.js'
import { pluginCreatorTools } from '../../base/extensions/plugin-creator/src/index.js'
import { createTestHost } from '../../host/testkit/index.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { createPackageAdminService, FilePackageOperationStore } from '../src/packages/index.js'
import { pluginProposalSourceAdapter } from '../src/packages/plugin-source.js'
import { packageManageReplyError } from '../src/supervisor/package-manage-error.js'
import { checkedPluginFiles } from '../src/supervisor/plugin-files.js'
import { createPluginManageRequests } from '../src/supervisor/plugin-manage-requests.js'

vi.mock('@agnes/daemon-admin/packages/index', async (original) => ({
  ...(await original<typeof import('@agnes/daemon-admin/packages/index')>()),
  authoringSandbox: vi.fn(async () => ({ isolated: true })),
}))
const roots: string[] = []
const endpoints: LocalEndpoint[] = []
afterEach(async () => {
  vi.mocked(authoringSandbox).mockResolvedValue({ isolated: true } as never)
  for (const ep of endpoints.splice(0)) await ep.close()
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const source = `export const main = { inject: ['tools'], apply(ctx) {} }`
const files = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'test-plugin',
      version: '0.1.0',
      type: 'module',
      exports: './index.mjs',
      license: 'Apache-2.0',
      agnes: {
        plugins: [
          {
            apiRange: '^5.0.0',
            id: 'ext:test-plugin/main',
            export: 'main',
            inject: ['tools'],
          },
        ],
      },
    }),
  },
  { path: 'index.mjs', content: source },
] as const

it('review: full-access publication cannot publish a different session candidate', async () => {
  const s = await setup('allow')
  const candidate = await s.request({ action: 'prepare', files })
  await s.request({ action: 'test', proposalId: candidate.candidateId })
  const invocation = {
    sessionKey: 'different-session',
    turn: 1,
    toolUseId: 'other-call',
    leaseId: 'lease',
    packageId: '@agnes/plugin-helper',
    snapshotId: 'snap',
    rowId: 'ext:plugin-helper/main',
    input: {
      action: 'candidate.submit',
      candidateId: candidate.candidateId,
      expectedHash: candidate.candidateHash,
    },
  }
  await expect(
    withPermissionContext(
      {
        sessionKey: 'different-session',
        sessionId: 'other-backend',
        epoch: 0,
        policy: 'full-access',
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      },
      () => undefined,
      () => s.dispatch(invocation as PluginManageInvocation, new AbortController().signal, undefined),

      async () => ({
        sessionKey: 'different-session',
        sessionId: 'other-backend',
        epoch: 0,
        policy: 'full-access',
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      }),
      () => ({
        sessionKey: 'different-session',
        sessionId: 'other-backend',
        epoch: 0,
        policy: 'full-access',
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      }),
    ),
  ).rejects.toBeDefined()
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
})

it('review: failed automatic publication is never reported as published', async () => {
  const s = await setup('allow')
  const candidate = await s.request({ action: 'prepare', files })
  await s.request({ action: 'test', proposalId: candidate.candidateId })
  vi.spyOn(s.manager, 'trust').mockRejectedValueOnce(new Error('synthetic trust failure'))
  await expect(s.request({ action: 'commit', proposalId: candidate.candidateId })).rejects.toBeDefined()
  expect((await s.request({ action: 'status', proposalId: candidate.candidateId })).state).toBe('failed')
  expect((await s.manager.inventory(s.profileDir)).packages[0]).toMatchObject({
    trusted: false,
    enabled: false,
  })
})

it('review: an expired automatic publication decision cannot produce a published receipt', async () => {
  const s = await setup('allow')
  const candidate = await s.request({ action: 'prepare', files })
  await s.request({ action: 'test', proposalId: candidate.candidateId })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const push = s.automaticEvidence.push.bind(s.automaticEvidence)
  const record = vi.spyOn(s.automaticEvidence, 'push').mockImplementation((...rows) => {
    if (rows.some((row) => row.scope === 'plugin.publish')) clock.mockReturnValue(now + 110_001)
    return push(...rows)
  })
  try {
    await expect(s.request({ action: 'commit', proposalId: candidate.candidateId })).rejects.toBeDefined()
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  } finally {
    record.mockRestore()
    clock.mockRestore()
  }
})

async function setup(candidateTestPolicy?: 'allow' | 'ask') {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'agh-plugin-helper-'))
  roots.push(fixtureRoot)
  const root = join(fixtureRoot, 'home')
  createPrivateDirectorySync(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((s) => [
        s,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['tools', 'ui'], workspacePackages: 'require-project-trust' },
  })
  const exec = vi.fn(async () => {
    throw new Error('No network')
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    sourceAdapters: [pluginProposalSourceAdapter(root)],
    exec,
    references: async () => [],
  })
  const installedIntegrity = async () => {
    const pkg = (await manager.inventory(profileDir)).packages[0]
    if (!pkg) throw new Error('Missing fixture package')
    return pkg.entry.integrity
  }
  let running = false
  const testRunner = vi.fn(
    async (): Promise<Omit<AuthoringTests, 'hash' | 'completedAt'>> => ({
      state: 'passed' as const,
      count: 1,
      runner: 'node-test' as const,
      output: 'synthetic unit runner',
    }),
  )
  const admin = createPackageAdminService({
    manager,
    profileDirectory: async () => profileDir,
    operations: new FilePackageOperationStore(join(root, 'ops')),
    clock: () => new Date().toISOString(),
    authoringTestRunner: testRunner,
    activation: {
      actual: async () =>
        running
          ? {
              actual: 'running',
              actualIntegrity: await installedIntegrity(),
            }
          : { actual: 'not-running' },
      reconcile: async () => {
        running = true
        return {
          actual: 'running',
          actualIntegrity: await installedIntegrity(),
        }
      },
    },
  })
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoints.push(ep)
  Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'client' })
  ep.conn.capabilities.permission = true
  ep.conn.attached.set('session', {} as never)
  let currentEp = ep
  const liveEndpoints = [ep]
  const refresh = async () => {
    const next = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    Object.assign(next.conn, { authKind: 'local', credentialKind: 'local', clientId: 'refreshed' })
    next.conn.capabilities.permission = true
    next.conn.attached.set('session', {} as never)
    vi.spyOn(next, 'request').mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    endpoints.push(next)
    liveEndpoints.push(next)
    currentEp = next
    await ep.close()
    return next
  }
  const ask = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  let ownerId = 'local'
  const options = {
    directory: root,
    home: join(root, 'private-home'),
    profile: 'local-dev',
    service: () => admin,
    current: () => currentEp.conn,
    connections: () => liveEndpoints.map((e) => e.conn),
    endpoint: (conn: typeof ep.conn) => liveEndpoints.find((e) => e.conn === conn),
    owner: () => ({ principalId: ownerId, active: true }),
  }
  let handler = createPluginManageRequests(options)
  const automaticEvidence: AutomaticPermissionEvidence[] = []
  const request = (input: unknown, overrides = {}, requestId: string = randomUUID()) => {
    const run = () =>
      handler('session', requestId, 'plugin-manage', {
        input,
        candidateTestSandbox: {
          policy: { workspaceRoot: root, rules: [], networkAllow: [], digest: 'a'.repeat(64) },
          network: 'deny',
          local: true,
        },
        turn: 2,
        packageId: '@agnes/plugin-helper',
        snapshotId: 'snap',
        rowId: 'ext:plugin-helper/main',
        sessionKey: 'session',
        toolUseId: 'tool',
        leaseId: 'lease',
        ...overrides,
      }) as Promise<AuthoringCandidate & { proposalId: string }>
    return candidateTestPolicy === 'allow'
      ? withPermissionContext(
          {
            sessionKey: 'session',
            sessionId: 'fixture-backend',
            epoch: 0,
            policy: 'full-access',
            actor: { id: ownerId, org: 'local', role: 'owner', deptPath: [], attrs: {} },
          },
          (value) => (value.consumption === 'authorized' ? automaticEvidence.push(value) : undefined),
          run,

          async () => ({
            sessionKey: 'session',
            sessionId: 'fixture-backend',
            epoch: 0,
            policy: 'full-access',
            actor: { id: ownerId, org: 'local', role: 'owner', deptPath: [], attrs: {} },
          }),
          () => ({
            sessionKey: 'session',
            sessionId: 'fixture-backend',
            epoch: 0,
            policy: 'full-access',
            actor: { id: ownerId, org: 'local', role: 'owner', deptPath: [], attrs: {} },
          }),
        )
      : run()
  }
  return {
    automaticEvidence,
    root,
    setOwner: (id: string) => {
      ownerId = id
    },
    dispatch: (invocation: PluginManageInvocation, signal: AbortSignal, sandbox: unknown) =>
      handler(
        invocation.sessionKey,
        randomUUID(),
        'plugin-manage',
        {
          ...invocation,
          candidateTestSandbox: sandbox,
        },
        signal,
      ).catch((error) => {
        throw Object.assign(new Error('Authoring refused'), packageManageReplyError(error))
      }),
    testRunner,
    refresh,
    profileDir,
    manager,
    admin,
    ep,
    ask,
    exec,
    request,
    restart: () => {
      handler = createPluginManageRequests(options)
    },
    abort: (id: string) => handler('session', 'abort', 'plugin-manage-abort', { requestId: id }),
  }
}
it('drafts and submits a tested review without installing, trusting or enabling; only a human admin can publish', async () => {
  const s = await setup(),
    p = await s.request({ action: 'prepare', files })
  expect(p.state).toBe('draft')
  expect(p.origin).toMatchObject({ sessionKey: 'session', turn: 2, toolUseId: 'tool' })
  await expect(s.request({ action: 'commit', proposalId: p.proposalId })).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_STATE' },
  })
  s.ask.mockRestore()
  const pending = s.request({
    action: 'candidate.test',
    candidateId: p.candidateId,
    expectedHash: p.candidateHash,
  })
  expect((await s.ep.notifications[Symbol.asyncIterator]().next()).value).toMatchObject({
    method: 'session/request_permission',
  })
  const refreshed = await s.refresh()
  await pending
  const r = await s.request({ action: 'commit', proposalId: p.proposalId })
  expect(r.state).toBe('review')
  expect(r.tests).toMatchObject({ state: 'passed', hash: r.candidateHash })
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  expect(refreshed.request).toHaveBeenCalledOnce()
  expect(JSON.stringify(vi.mocked(refreshed.request).mock.calls)).toContain(r.candidateHash)
  s.restart()
  expect((await s.request({ action: 'status', proposalId: p.proposalId })).state).toBe('review')
  await expect(
    s.request({
      action: 'candidate.approve',
      candidateId: p.candidateId,
      expectedHash: p.candidateHash,
      reviewHash: r.reviewHash,
    }),
  ).rejects.toMatchObject({ code: -32602 })
  expect(s.exec).not.toHaveBeenCalled()
})
it.each(['@agnes/plugin-helper', '@agnes/skill-helper'])(
  'full-access tests %s candidates without prompting and audits the exact hash',
  async (packageId) => {
    const s = await setup('allow')
    const p = await s.request({ action: 'prepare', files }, { packageId })
    s.testRunner.mockImplementationOnce(async () => {
      const beforeRun = JSON.parse(readFileSync(join(s.root, 'candidate-test-audit.jsonl'), 'utf8').trim())
      expect(beforeRun.detail).toMatchObject({ bindingHash: p.candidateHash, verdict: 'allowed-once' })
      return { state: 'passed', count: 1, runner: 'node-test', output: 'synthetic unit runner' }
    })
    const tested = await s.request(
      { action: 'candidate.test', candidateId: p.candidateId, expectedHash: p.candidateHash },
      { packageId },
    )
    expect(tested.tests).toMatchObject({ state: 'passed', hash: p.candidateHash })
    expect(s.ask).not.toHaveBeenCalled()
    expect(vi.mocked(authoringSandbox).mock.calls.at(-1)?.[0].home).toBe(join(s.root, 'private-home'))
    const audit = JSON.parse(readFileSync(join(s.root, 'candidate-test-audit.jsonl'), 'utf8').trim())
    expect(audit.detail).toMatchObject({
      action: 'candidate.test',
      bindingHash: p.candidateHash,
      verdict: 'allowed-once',
      via: 'full-access',
      reason: 'full-access',
    })
    await expect(
      s.request({ action: 'test', proposalId: p.candidateId, candidateTestPolicy: 'allow' }),
    ).rejects.toMatchObject({ code: -32602 })
    for (const action of ['candidate.approve', 'install', 'trust', 'enable'])
      await expect(
        s.request({ action, candidateId: p.candidateId, expectedHash: p.candidateHash }),
      ).rejects.toMatchObject({ code: -32602 })
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
    const next = await s.request({ action: 'prepare', files })
    rmSync(join(s.root, 'candidate-test-audit.jsonl'))
    mkdirSync(join(s.root, 'candidate-test-audit.jsonl'))
    await expect(s.request({ action: 'test', proposalId: next.candidateId })).rejects.toThrow()
    expect((await s.request({ action: 'status', proposalId: next.candidateId })).tests).toBeNull()
    expect(s.testRunner).toHaveBeenCalledOnce()
  },
)
it.each([undefined, 'ask'] as const)('keeps the exact-hash prompt with policy %s', async (policy) => {
  const s = await setup(policy)
  const p = await s.request({ action: 'prepare', files })
  await s.request({ action: 'test', proposalId: p.candidateId })
  expect(s.ask).toHaveBeenCalledOnce()
  expect(s.ask.mock.calls[0]?.[1]).toMatchObject({
    toolCall: {
      rawInput: { packageId: p.packageId, candidateHash: p.candidateHash },
      _meta: { 'ai.agnes.harness': { tool: 'plugin_candidate_test' } },
    },
  })
})
it('denied test execution and cancelled native prompts leave the candidate inactive, with no passing result', async () => {
  const s = await setup(),
    p = await s.request({ action: 'prepare', files })
  s.ask.mockResolvedValueOnce({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
  await expect(
    s.request({ action: 'candidate.test', candidateId: p.candidateId, expectedHash: p.candidateHash }),
  ).rejects.toMatchObject({ data: { code: 'PLUGIN_TEST_REJECTED' } })
  expect((await s.request({ action: 'status', proposalId: p.proposalId })).tests).toBeNull()
  s.ask.mockImplementationOnce(
    (_m, _p, opts) =>
      new Promise((_resolve, reject) =>
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  )
  const job = s
    .request(
      { action: 'candidate.test', candidateId: p.candidateId, expectedHash: p.candidateHash },
      {},
      'cancel-me',
    )
    .catch((e) => e)
  await vi.waitFor(() => expect(s.ask).toHaveBeenCalledTimes(2))
  await s.abort('cancel-me')
  await job
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  expect((await s.request({ action: 'status', proposalId: p.proposalId })).tests).toBeNull()
  vi.useFakeTimers()
  try {
    s.ask.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(110_001)
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    })
    await expect(s.request({ action: 'test', proposalId: p.proposalId })).rejects.toMatchObject({
      data: { code: 'PLUGIN_TEST_UNANSWERED', reason: 'deadline' },
    })
  } finally {
    vi.useRealTimers()
  }
  expect((await s.request({ action: 'status', proposalId: p.proposalId })).tests).toBeNull()
  const fresh = await s.request({ action: 'prepare', files })
  s.testRunner.mockClear()
  s.ask.mockImplementationOnce(async () => {
    const record = JSON.parse(
      readFileSync(join(s.profileDir, '.authoring-candidates', fresh.candidateId, 'record.json'), 'utf8'),
    )
    writeFileSync(join(record.tree, 'index.mjs'), 'changed while confirmation was open')
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
  })
  await expect(
    s.request({
      action: 'candidate.test',
      candidateId: fresh.candidateId,
      expectedHash: fresh.candidateHash,
    }),
  ).rejects.toThrow()
  expect(s.testRunner).not.toHaveBeenCalled()
})
it('binds authority to the local owner, session and live connection', async () => {
  const s = await setup()
  await expect(s.request({ action: 'prepare', files }, { sessionKey: 'other' })).rejects.toMatchObject({
    code: -32602,
  })
  s.ep.conn.capabilities.permission = false
  await expect(s.request({ action: 'prepare', files })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PERMISSION_REQUIRED' },
  })
  expect(s.ask).not.toHaveBeenCalled()
})
it.each([undefined, 'allow'] as const)(
  'rejects changed bytes before tests or approval under policy %s; no request can publish',
  async (policy) => {
    const s = await setup(policy),
      p = await s.request({ action: 'prepare', files })
    const record = JSON.parse(
      readFileSync(join(s.profileDir, '.authoring-candidates', p.candidateId, 'record.json'), 'utf8'),
    )
    writeFileSync(join(record.tree, 'index.mjs'), source + '// changed')
    await expect(
      s.request({ action: 'candidate.test', candidateId: p.candidateId, expectedHash: p.candidateHash }),
    ).rejects.toMatchObject({ data: { code: 'PLUGIN_CANDIDATE_STALE' } })
    await expect(s.request({ action: 'commit', proposalId: randomUUID() })).rejects.toMatchObject({
      data: { code: 'PLUGIN_LEGACY_PROPOSAL_REVIEW_REQUIRED' },
    })
    await expect(s.request({ action: 'cancel', proposalId: p.proposalId })).rejects.toMatchObject({
      data: { code: 'PLUGIN_REJECT_IN_REVIEW_UI' },
    })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.testRunner).not.toHaveBeenCalled()
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  },
)
it.each([
  '../escape.mjs',
  '/tmp/escape.mjs',
  'src/../escape.mjs',
  'node_modules/x.mjs',
  'CON.mjs',
  'a\\b.mjs',
])('rejects unsafe file path %s before staging', (path) => {
  expect(() => checkedPluginFiles([...files, { path, content: '' }])).toThrow('PLUGIN_FILES_INVALID')
})
it('rejects aliases, file-directory conflicts, bounds and lifecycle/dependency declarations', () => {
  for (const extra of [
    [{ path: 'INDEX.mjs', content: '' }],
    [{ path: 'index.mjs/a.mjs', content: '' }],
    [{ path: 'large.mjs', content: 'a'.repeat(256 * 1024 + 1) }],
  ])
    expect(() => checkedPluginFiles([...files, ...extra])).toThrow()
  for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'bin']) {
    const pkg = JSON.parse(files[0].content)
    pkg[key] = {}
    expect(() =>
      checkedPluginFiles([{ path: 'package.json', content: JSON.stringify(pkg) }, files[1]]),
    ).toThrow()
  }
  for (const apiRange of [undefined, '', '^99.0.0']) {
    const pkg = JSON.parse(files[0].content)
    pkg.agnes.plugins[0].apiRange = apiRange
    expect(() =>
      checkedPluginFiles([{ path: 'package.json', content: JSON.stringify(pkg) }, files[1]]),
    ).toThrow('PLUGIN_FILES_INVALID')
  }
  for (const service of ['providers', 'fs', 'net', 'shell']) {
    const pkg = JSON.parse(files[0].content)
    pkg.agnes.plugins[0].inject = ['tools', service]
    expect(() =>
      checkedPluginFiles([{ path: 'package.json', content: JSON.stringify(pkg) }, files[1]]),
    ).toThrow('PLUGIN_FILES_INVALID')
  }
  expect(() =>
    checkedPluginFiles([
      ...files,
      ...Array.from({ length: 31 }, (_, i) => ({ path: `f${i}.md`, content: '' })),
    ]),
  ).toThrow()
})

it.each(['tool', 'tool-with-panel', 'skill', 'skin'])(
  'the shipped %s template passes real package inspection',
  async (kind) => {
    const module = await import(
      new URL('../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
    )
    const tools: ToolDef[] = []
    module.pluginHelper.apply({
      tools: { register: (tool: (typeof tools)[number]) => tools.push(tool) },
    })
    const guide = tools.find((t) => t.name === 'plugin_helper_guide')
    if (!guide) throw new Error('guide missing')
    const s = await setup()
    const context = {
      signal: new AbortController().signal,
      session: { depth: 0 },
      pluginManage: { request: s.request },
    } as unknown as Parameters<ToolDef['execute']>[1]
    const result = await guide.execute({ kind }, context)
    expect(result).toMatchObject({
      structured: { authoringCapability: 'supplied-authorization-checked-per-call' },
    })
    const text = result.content.find((part) => part.type === 'text')
    if (text?.type !== 'text') throw new Error('guide returned no text')
    const generated = result.structured as { files: unknown[] }
    const create = tools.find((t) => t.name === 'plugin_helper_create')
    if (!create) throw new Error('create missing')
    const created = await create.execute({ files: generated.files }, context)
    expect(created).toMatchObject({ structured: { state: 'draft' } })
    const candidate = created.structured as AuthoringCandidate & { proposalId: string }
    expect(candidate.proposalId).toBe(candidate.candidateId)
  },
)

it('accepts the bundled pure skin candidate template, rejecting arbitrary client contributions', async () => {
  const templatePath = '../../package-manager/bundled-plugins/plugin-helper/src/skin.mjs'
  const { skinFiles } = await import(templatePath)
  const skin: { path: string; content: string }[] = skinFiles()
  expect(checkedPluginFiles(skin)).toEqual(skin)
  const s = await setup()
  const p = await s.request({ action: 'prepare', files: skin }).catch((e) => {
    throw new Error(JSON.stringify(e))
  })
  expect(p.state).toBe('draft')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  for (const content of [JSON.stringify({ skins: [], panels: [] }), JSON.stringify({ panels: [{}] })]) {
    const bad = skin.map((f) => (f.path === 'extensions/main/agnes.client.json' ? { ...f, content } : f))
    expect(() => checkedPluginFiles(bad)).toThrow('PLUGIN_FILES_INVALID')
  }
  const badPath = skin.map((f) =>
    f.path === 'package.json'
      ? { ...f, content: f.content.replace('./extensions/main/agnes.client.json', '../agnes.client.json') }
      : f,
  )
  expect(() => checkedPluginFiles(badPath)).toThrow('PLUGIN_FILES_INVALID')
})

it.each(['workspace-write', 'standard'])(
  '%s candidate tests have one exact-hash card from every shipped authoring tool',
  async () => {
    const s = await setup('ask')
    const p = await s.request({ action: 'prepare', files })
    const definitions: ToolDef[] = [...pluginCreatorTools]
    const { pluginHelper } = await import(
      new URL('../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
    )
    const { skillHelper } = await import(
      new URL('../../package-manager/bundled-plugins/skill-helper/index.mjs', import.meta.url).href
    )
    for (const plugin of [pluginHelper, skillHelper])
      plugin.apply({ tools: { register: (tool: (typeof definitions)[number]) => definitions.push(tool) } })
    for (const tainted of [false, true])
      for (const name of ['plugin_test', 'plugin_helper_install', 'skill_helper_install']) {
        const tool = definitions.find((t) => t.name === name)
        if (!tool) throw new Error(`Missing shipped tool ${name}`)
        const args =
          name === 'plugin_test'
            ? { candidateId: p.candidateId, expectedHash: p.candidateHash }
            : { action: 'test', proposalId: p.candidateId }
        const decision = await toolPolicy.decide(
          {
            sessionKey: 'session',
            cwd: s.root,
            workspaceRoot: s.root,
            actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
            call: { id: 'tool', name, args },
            policy: resolveToolCallPolicy(tool, args),
            tainted,
            fullAccess: false,
            approvalMode: 'manual',
          },
          new AbortController().signal,
        )
        expect(decision.effect).toBe('allow')
        s.ask.mockClear()
        await s.request({
          action: 'candidate.test',
          candidateId: p.candidateId,
          expectedHash: p.candidateHash,
        })
        expect(s.ask).toHaveBeenCalledOnce()
        expect(s.ask.mock.calls[0]?.[1]).toMatchObject({
          toolCall: {
            rawInput: {
              candidateHash: p.candidateHash,
              packageId: p.packageId,
              execution: 'sandbox',
              runs: 'Node author tests',
              scope: 'candidate-directory',
            },
          },
        })
      }
    s.ask.mockClear()
    s.testRunner.mockClear()
    await expect(
      s.request({
        action: 'candidate.test',
        candidateId: p.candidateId,
        expectedHash: `sha256-${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ data: { code: 'PLUGIN_CANDIDATE_STALE' } })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.testRunner).not.toHaveBeenCalled()
  },
)
it('automatically allows unisolated Windows candidate tests under full-access and records the exact hash', async () => {
  vi.mocked(authoringSandbox).mockResolvedValue({ isolated: false } as never)
  const s = await setup('allow')
  const p = await s.request({ action: 'prepare', files })
  const tested = await s.request({ action: 'test', proposalId: p.candidateId })
  expect(tested.tests).toMatchObject({ state: 'passed', hash: p.candidateHash })
  expect(s.ask).not.toHaveBeenCalled()
  expect(s.automaticEvidence).toContainEqual(
    expect.objectContaining({
      reason: 'full-access',
      verdict: 'allowed-once',
      bindingHash: p.candidateHash,
      answeredBy: expect.objectContaining({ role: 'system' }),
    }),
  )
  const audit = JSON.parse(readFileSync(join(s.root, 'candidate-test-audit.jsonl'), 'utf8').trim())
  expect(audit.detail).toMatchObject({ reason: 'full-access', isolation: 'unisolated' })
})
it.each(['allow', 'ask'] as const)(
  'submits a tested candidate with %s policy and retains publication authority',
  async (policy) => {
    const s = await setup(policy)
    const p = await s.request({ action: 'prepare', files })
    await s.request({ action: 'test', proposalId: p.candidateId })
    const submitted = await s.request({ action: 'commit', proposalId: p.candidateId })
    expect(submitted.state).toBe(policy === 'allow' ? 'published' : 'review')
    const packages = (await s.manager.inventory(s.profileDir)).packages
    if (policy === 'allow') {
      expect(packages).toHaveLength(1)
      expect(packages[0]).toMatchObject({ enabled: true, trusted: true })
      expect(s.ask).not.toHaveBeenCalled()
      expect(s.automaticEvidence).toContainEqual(
        expect.objectContaining({ scope: 'plugin.publish', reason: 'full-access' }),
      )
    } else {
      expect(packages).toHaveLength(0)
      expect(s.ask).toHaveBeenCalledOnce()
      expect(s.automaticEvidence).toEqual([])
    }
  },
)
it('fails closed when the sandbox probe fails under full-access', async () => {
  vi.mocked(authoringSandbox).mockRejectedValue(new Error('SANDBOX_UNAVAILABLE'))
  const s = await setup('allow')
  const p = await s.request({ action: 'prepare', files })
  await expect(s.request({ action: 'test', proposalId: p.candidateId })).rejects.toThrow(
    'SANDBOX_UNAVAILABLE',
  )
  expect(s.testRunner).not.toHaveBeenCalled()
  expect(s.ask).not.toHaveBeenCalled()
})

it('continues a helper draft through real builtin registration and dispatch into the same candidate service', async () => {
  const s = await setup()
  const helper = await readDevelopmentPlugin(
    fileURLToPath(new URL('../../package-manager/bundled-plugins/plugin-helper', import.meta.url)),
    'local-dev',
  )
  let trusted = true
  const scripts: ConstructorParameters<typeof ScriptedProvider>[0]['scripts'] = []
  const invocations: PluginManageInvocation[] = []
  let activeSession: HostSession | undefined
  const { host } = await createTestHost({
    dataDir: join(s.root, 'host'),
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    runtimePluginSnapshots: [helper],
    runtimePluginSources: async () => [{ ...helper, trusted }],
    extensionLoader: { import: (file) => import(pathToFileURL(file).href) },
    provider: new ScriptedProvider({ scripts }),
    disableSessionTitle: true,
    approval: async () => ({
      verdict: 'allowed-once',
      answeredBy: { id: 'reviewer', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }),
    pluginManage: async (invocation, signal) => {
      invocations.push(invocation)
      return s.dispatch(invocation, signal, activeSession?.commandSandboxPolicy?.())
    },
  })
  try {
    const session = await host.createSession({ cwd: join(s.root, 'host'), key: 'session' })
    activeSession = session
    const call = async (name: string, args: Record<string, unknown>) => {
      scripts.push(
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: { name: 'tool_describe', args: { name }, toolUseId: '', ordinal: 0 },
          },
          { type: 'done', reason: 'toolUse' },
        ] as InferenceEvent[],
        [
          { type: 'toolcall_end', via: 'native', call: { name, args, toolUseId: '', ordinal: 0 } },
          { type: 'done', reason: 'toolUse' },
        ] as InferenceEvent[],
        [
          { type: 'text_delta', delta: 'receipt received' },
          { type: 'done', reason: 'stop' },
        ],
      )
      await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: name }] })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const [event] = await session.scan({ type: 'tool/result', order: 'desc', limit: 1 })
      if (!event) throw new Error('Missing tool result')
      return event.data as { isError?: boolean; structured: AuthoringCandidate; details?: unknown }
    }
    const created = await call('plugin_helper_create', { files })
    const p = created.structured
    expect(p).toMatchObject({
      state: 'draft',
      origin: { packageId: '@agnes/plugin-helper', snapshotId: helper.snapshot.snapshotId },
    })
    const args = { candidateId: p.candidateId, expectedHash: p.candidateHash }
    const read = await call('plugin_candidate_read', { candidateId: p.candidateId })
    expect(read.structured).toMatchObject({
      candidateId: p.candidateId,
      candidateHash: p.candidateHash,
      sourceFiles: expect.arrayContaining([...files]),
    })
    const bad = await call('plugin_candidate_write', {
      ...args,
      expectedHash: `sha256-${'0'.repeat(64)}`,
      files,
    })
    expect(bad, JSON.stringify(bad)).toMatchObject({
      isError: true,
      structured: { kind: 'stale-hash', operation: 'candidate.write', candidateId: p.candidateId },
    })
    for (const name of ['plugin_candidate_write', 'plugin_helper_write']) {
      for (const [delta, remove, code, path] of [
        [[files[1]], [files[1]!.path], 'conflicting-write-path', files[1]!.path],
        [[], ['absent.md'], 'missing-remove-path', 'absent.md'],
      ] as const) {
        const rejected = await call(name, { ...args, mode: 'merge', files: delta, remove })
        expect(rejected, name).toMatchObject({
          isError: true,
          structured: { diagnostics: [{ code, path }] },
        })
      }
      expect(
        await call(name, { ...args, expectedHash: `sha256-${'0'.repeat(64)}`, mode: 'merge', files: [] }),
      ).toMatchObject({
        isError: true,
        structured: { code: 'PLUGIN_CANDIDATE_STALE' },
      })
    }
    const changed = [...files, { path: 'notes.md', content: 'same candidate, builtin edit' }]
    const written = await call('plugin_candidate_write', {
      ...args,
      mode: 'merge',
      files: [changed[changed.length - 1]],
    })
    let hash = written.structured.candidateHash
    expect(
      (await call('plugin_candidate_read', { candidateId: p.candidateId })).structured.sourceFiles,
    ).toEqual(expect.arrayContaining([...files]))
    const alias = await call('plugin_helper_write', {
      ...args,
      expectedHash: hash,
      mode: 'merge',
      files: [],
      remove: ['notes.md'],
    })
    hash = alias.structured.candidateHash
    expect(hash).toBe(p.candidateHash)
    expect(written.structured.candidateHash).not.toBe(p.candidateHash)
    expect(written.structured.candidateId).toBe(p.candidateId)
    s.testRunner.mockResolvedValueOnce({
      state: 'failed',
      count: 1,
      runner: 'node-test',
      output: 'synthetic failing case',
    })
    expect((await call('plugin_test', { ...args, expectedHash: hash })).isError).toBe(true)
    expect(await call('plugin_install_local', { ...args, expectedHash: hash })).toMatchObject({
      isError: true,
      structured: { kind: 'validation-failure' },
    })
    expect((await call('plugin_test', { ...args, expectedHash: hash })).structured.tests).toMatchObject({
      state: 'passed',
      hash,
    })
    expect((await call('plugin_install_local', { ...args, expectedHash: hash })).structured).toMatchObject({
      state: 'review',
      candidateId: p.candidateId,
    })
    expect(invocations[0]).toMatchObject({
      packageId: '@agnes/plugin-helper',
      rowId: 'ext:plugin-helper/main',
    })
    for (const invocation of invocations.slice(1).filter((entry) => entry.packageId === '@agnes/base'))
      expect(invocation).toMatchObject({
        packageId: '@agnes/base',
        rowId: 'ext:agnes/plugin-creator',
        snapshotId: host.sessionGeneration?.(session.key),
      })
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
    expect(s.exec).not.toHaveBeenCalled()
    // Old ids and hashes remain readable through both compatibility tool sets after restart.
    s.restart()
    expect((await s.request({ action: 'status', proposalId: p.candidateId })).candidateHash).toBe(hash)
    s.setOwner('not-the-owner')
    expect(
      await call('plugin_candidate_write', { ...args, expectedHash: hash, files: changed }),
    ).toMatchObject({ isError: true, structured: { kind: 'permission-denied' } })
    s.setOwner('local')
    trusted = false
    const before = invocations.length
    expect(
      await call('plugin_candidate_write', { ...args, expectedHash: hash, files: changed }),
    ).toMatchObject({ isError: true, structured: { kind: 'permission-denied' } })
    expect(invocations).toHaveLength(before)
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  } finally {
    await host.close()
  }
})

it('carries safe diagnostics from real candidate inspection through RPC and supervisor projection into creator text', async () => {
  const s = await setup('allow')
  const descriptor = {
    path: 'client/agnes.client.json',
    content: JSON.stringify({
      skins: [
        {
          id: 'test-skin',
          name: 'Test skin',
          css: './skin.css',
          tokens: {
            '--agnes-text-primary': { light: 'red', dark: 'red' },
            '--agnes-text-secondary': { light: 'blue', dark: 'blue' },
          },
        },
      ],
    }),
  }
  const pkg = JSON.parse(files[0].content)
  pkg.agnes.clientDescriptors = [{ rowId: 'ext:test-plugin/main', path: './client/agnes.client.json' }]
  const skinFiles = [
    { path: 'package.json', content: JSON.stringify(pkg) },
    files[1],
    descriptor,
    { path: 'client/skin.css', content: '/* synthetic */' },
  ]
  let candidate = await s.request({ action: 'candidate.create', files: skinFiles })
  const ctx = {
    signal: new AbortController().signal,
    pluginManage: {
      request: (input: unknown) =>
        s.request(input).catch((error) => {
          throw packageManageReplyError(error)
        }),
    },
  } as unknown as import('@agnes/extension-api').ToolContext
  const data = JSON.parse(descriptor.content)
  data.skins[0].tokens['--agnes-text-muted'] = { light: 'grey', dark: 'grey' }
  const invalid = skinFiles.map((f) =>
    f.path === descriptor.path ? { ...f, content: JSON.stringify(data) } : f,
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await pluginCreatorTools[4].execute(
      { candidateId: candidate.candidateId, expectedHash: candidate.candidateHash, files: invalid },
      ctx,
    )
    const text = JSON.stringify(rejected.content)
    expect(rejected.isError).toBe(true)
    expect(text).toContain('unsupported token --agnes-text-muted')
    expect(text).not.toMatch(/text-primary|text-secondary|\/Users|\/private\/var/)
    if (attempt) expect(text).toContain('read the same candidate')
  }
  expect(
    (await s.request({ action: 'candidate.show', candidateId: candidate.candidateId })).candidateHash,
  ).toBe(candidate.candidateHash)
  s.testRunner.mockResolvedValueOnce({
    state: 'failed',
    count: 1,
    runner: 'node-test',
    output:
      'not ok 1 - remembers trips\n  name: AssertionError\n  error: expected two trips\n  location: ./test/trips.test.mjs:4:1\n  private: /' +
      'Users' +
      '/synthetic/private/trips.json\n' +
      'x'.repeat(20000),
  })
  const tested = await pluginCreatorTools[2].execute(
    { candidateId: candidate.candidateId, expectedHash: candidate.candidateHash },
    ctx,
  )
  expect(tested.isError).toBe(true)
  const failureText = JSON.stringify(tested.content)
  for (const detail of [
    'remembers trips',
    'AssertionError',
    'expected two trips',
    'test/trips.test.mjs:4:1',
    '[truncated]',
    'tests.output',
  ])
    expect(failureText).toContain(detail)
  expect(JSON.stringify(tested)).not.toContain('/' + 'Users' + '/synthetic')
  candidate = await s.request({ action: 'candidate.show', candidateId: candidate.candidateId })
  const incomplete = await pluginCreatorTools[4].execute(
    {
      candidateId: candidate.candidateId,
      expectedHash: candidate.candidateHash,
      files: skinFiles.filter((f) => f.path !== 'index.mjs'),
    },
    ctx,
  )
  expect(incomplete.isError).not.toBe(true)
  expect(JSON.stringify(incomplete.content)).toContain('complete file tree is missing index.mjs')
  candidate = await s.request({ action: 'candidate.show', candidateId: candidate.candidateId })
  for (const tool of [pluginCreatorTools[2], pluginCreatorTools[3]]) {
    const refused = await tool.execute(
      { candidateId: candidate.candidateId, expectedHash: candidate.candidateHash },
      ctx,
    )
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('complete file tree is missing index.mjs')
  }
  const missingManifest = await pluginCreatorTools[4].execute(
    {
      candidateId: candidate.candidateId,
      expectedHash: candidate.candidateHash,
      files: skinFiles.filter((f) => f.path !== 'package.json'),
    },
    ctx,
  )
  expect(missingManifest.isError).not.toBe(true)
  expect(JSON.stringify(missingManifest.content)).toContain('complete file tree is missing package.json')
})

it.each(['cancelled', 'unavailable', 'rejected'] as const)(
  'review: %s publication permission never admits a package effect',
  async (verdict) => {
    const s = await setup('allow')
    const candidate = await s.request({ action: 'prepare', files })
    await s.request({ action: 'test', proposalId: candidate.candidateId })
    const ask = vi.spyOn(PrompterRouter.prototype, 'ask').mockResolvedValueOnce({ verdict })
    try {
      await expect(s.request({ action: 'commit', proposalId: candidate.candidateId })).rejects.toBeDefined()
      expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
    } finally {
      ask.mockRestore()
    }
  },
)

it('round4: plugin trust waiting for its profile lock cannot commit after publication approval expires', async () => {
  const s = await setup('allow')
  const candidate = await s.request({ action: 'prepare', files })
  await s.request({ action: 'test', proposalId: candidate.candidateId })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const trust = s.manager.trust.bind(s.manager)
  let queued = false
  const spy = vi.spyOn(s.manager, 'trust').mockImplementation(async (...args) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = withLock(s.profileDir, () => held)
    try {
      const pending = trust(...args)
      void pending.catch(() => undefined)
      queued = true
      clock.mockReturnValue(now + 110_001)
      release()
      await blocker
      await vi.advanceTimersByTimeAsync(25)
      return await pending
    } finally {
      release()
      await blocker
      vi.useRealTimers()
    }
  })
  try {
    await s.request({ action: 'commit', proposalId: candidate.candidateId }).catch(() => undefined)
    expect(queued).toBe(true)
    expect((await s.manager.inventory(s.profileDir)).packages[0]).toMatchObject({
      trusted: false,
      enabled: false,
    })
  } finally {
    spy.mockRestore()
    clock.mockRestore()
    vi.useRealTimers()
  }
})
