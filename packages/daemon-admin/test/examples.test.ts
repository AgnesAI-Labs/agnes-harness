import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentPlan,
  type ApplicationPreview,
  type ApplicationState,
  type ClientModuleRosterRow,
  jcs,
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  type PackagePreview,
  validateAgainst,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createAgentLaunches, createExamplePackages, type ExampleBackend } from '../src/packages/examples.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(parentVersion = '1.0.0') {
  let time = 1
  const directory = mkdtempSync(join(tmpdir(), 'agh-example-'))
  roots.push(directory)
  const row: ClientModuleRosterRow = {
    rowId: 'web:acme/parent',
    moduleName: 'parent',
    packageId: 'acme/parent',
    enabled: true,
    phase: 'ready',
    binding: {
      lifetime: 'profile',
      owner: 'web:acme/parent',
      packageId: 'acme/parent',
      integrity: 'p1',
      profileId: 'test',
      activationId: 'activation-1',
      availability: 'active',
    },
  }
  const launch = {
    id: 'work',
    kind: 'business-agent' as const,
    title: 'Work',
    bundle: 'demo',
    preset: 'safe',
    prompt: 'Inspect synthetic data.',
  }
  const entry = {
    id: '@agnes-example/demo',
    version: '1.0.0',
    integrity: 'hash-1',
    sourceId: 'official-examples',
    source: { type: 'file', ref: 'file:./bundled-examples/fde/knowledge-qa' },
    compatibility: 'supported',
    license: 'Apache-2.0',
    contributions: [],
    agents: [
      {
        ref: '@agnes-example/demo#work',
        launch: {
          title: { en: launch.title },
          description: { en: 'Work' },
          preset: launch.preset,
        },
      },
    ],
    metadata: {
      displayName: 'Demo',
      summary: 'Demo',
      description: 'Demo',
      exampleOf: 'acme/parent',
    },
  } as unknown as PackageCatalogDescriptor
  const preview = {
    ...entry,
    capabilityHash: 'cap-1',
    dependencies: { 'acme/parent': parentVersion },
    blockers: [],
    warnings: [],
  } as unknown as PackagePreview
  let installed: PackageInstalledDescriptor[] = []
  const sessions = new Map<string, string>(),
    inputs = new Set<string>()
  const backend: ExampleBackend = {
    runtime: async () => ({ state: 'running' }),
    stop: async () => {
      installed = installed.map((item) => ({ ...item, desired: 'installed-disabled', actual: 'not-running' }))
    },
    remove: async (_review, _operation, check) => {
      await check()
      installed = []
    },
    owner: async () => ({ version: parentVersion, principal: 'synthetic-user', profile: 'test', row }),
    catalog: async () => [entry],
    installed: async () => installed,
    inspect: async () => preview,
    enable: async (_review, _operation, check) => {
      await check()
      installed = [
        {
          ...preview,
          trusted: true,
          desired: 'enabled',
          actual: 'running',
        } as unknown as PackageInstalledDescriptor,
      ]
    },
    resolveAgent: async (ref) =>
      ({
        ref,
        launch: entry.agents![0]!.launch,
        digest: JSON.stringify(entry.agents),
        loop: { id: 'work', version: '1.0.0' },
        bundles: [ref],
        preset: 'safe',
        pages: [],
        compositionHash: 'tree',
        presetHash: 'preset',
        effectivePresetHash: 'effective',
        model: { route: 'demo', model: 'demo' },
        models: {},
        permission: { readOnly: false, tools: [], allow: [], deny: [] },
        sources: [],
      }) as AgentPlan,
    open: async (_launch, key) => {
      const session = sessions.get(key) ?? `session-${sessions.size + 1}`
      sessions.set(key, session)
      return session
    },
  }
  const create = () => createExamplePackages({ directory, backend, now: () => time })
  const call = (request: Record<string, unknown>) => create().call(row.rowId, request)
  return {
    row,
    entry,
    preview,
    backend,
    sessions,
    inputs,
    call,
    directory,
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}
it.each(['1.0.0', '0.1.0-alpha.0'])(
  'reviews an exact %s parent pin, enables it and creates one durable session per operation',
  async (version) => {
    const f = fixture(version)
    expect(await f.call({ action: 'list' })).toMatchObject([
      { id: f.entry.id, installation: 'not-installed' },
    ])
    const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
    await f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-1' })
    expect(await f.call({ action: 'list' })).toMatchObject([
      { installation: 'enabled', runtime: { state: 'running' } },
    ])
    const ticket = (await f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })) as {
      launchTicket: string
    }
    const request = { action: 'start', launchTicket: ticket.launchTicket, operationId: 'launch-1' }
    expect(await f.call(request)).toEqual({ sessionId: 'session-1' })
    expect(await f.call(request)).toEqual({ sessionId: 'session-1' })
    expect(f.sessions.size).toBe(1)
    expect(f.inputs.size).toBe(0)
    // An interrupted launch has an uncertain receipt and must not be dispatched again.
    const state = JSON.parse(readFileSync(join(f.directory, 'operations.json'), 'utf8'))
    for (const operation of Object.values(state.operations) as { state: string; sessionId?: string }[])
      if (operation.sessionId) operation.state = 'running'
    writeFileSync(join(f.directory, 'operations.json'), JSON.stringify(state))
    await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(f.sessions.size).toBe(1)
    expect(f.inputs.size).toBe(0)
    await expect(f.call({ ...request, launchTicket: 'different-ticket' })).rejects.toThrow('STALE')
    await f.call({ action: 'stop', exampleId: f.entry.id, operationId: 'stop-1' })
    expect(await f.call({ action: 'list' })).toMatchObject([
      { installation: 'disabled', runtime: { state: 'stopped' } },
    ])
    const removal = (await f.call({ action: 'inspect-remove', exampleId: f.entry.id })) as {
      reviewId: string
    }
    await expect(
      f.call({ action: 'remove', reviewId: review.reviewId, operationId: 'wrong-review' }),
    ).rejects.toThrow('DENIED')
    await f.call({ action: 'remove', reviewId: removal.reviewId, operationId: 'remove-1' })
    expect(await f.call({ action: 'list' })).toMatchObject([{ installation: 'not-installed' }])
    await expect(
      f.call({ action: 'stop', exampleId: 'foreign/example', operationId: 'stop-2' }),
    ).rejects.toThrow()
  },
)
it('refuses changed hashes, cross-parent examples, stale activation, undeclared launches and admin-shaped inputs', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  f.entry.integrity = 'changed'
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-1' }),
  ).rejects.toThrow('STALE')
  f.entry.integrity = 'hash-1'
  if (f.entry.metadata) f.entry.metadata.exampleOf = 'other/parent'
  expect(await f.call({ action: 'list' })).toEqual([])
  await expect(f.call({ action: 'inspect', exampleId: f.entry.id })).rejects.toThrow('DENIED')
  if (f.entry.metadata) f.entry.metadata.exampleOf = 'acme/parent'
  if (f.row.binding) f.row.binding.activationId = 'activation-2'
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-2' }),
  ).rejects.toThrow('STALE')
  await expect(f.call({ action: 'install', source: 'https://example.invalid' })).rejects.toThrow('INVALID')
  await expect(f.call({ action: 'list', approved: true })).rejects.toThrow('INVALID')
  f.row.enabled = false
  await expect(
    f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'parent-disabled' }),
  ).rejects.toThrow('DENIED')
  await expect(f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })).rejects.toThrow(
    'DENIED',
  )
  await expect(f.call({ action: 'list' })).rejects.toThrow('DENIED')
})
it('retains an unknown dispatch result and does not replay it', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  f.backend.enable = async () => {
    throw new Error('synthetic uncertain activation')
  }
  const request = { action: 'enable', reviewId: review.reviewId, operationId: 'enable-unknown' }
  await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
  expect(await f.call({ action: 'read', operationId: 'enable-unknown' })).toMatchObject({ state: 'unknown' })
  f.backend.enable = async () => {
    throw new Error('should never run')
  }
  await expect(f.call(request)).rejects.toThrow('OUTCOME_UNKNOWN')
  f.backend.enable = async () => {
    throw new Error('E_PACKAGE_STATE')
  }
  await expect(f.call({ ...request, operationId: 'known-failure' })).rejects.toThrow('E_PACKAGE_STATE')
  expect(await f.call({ action: 'read', operationId: 'known-failure' })).toMatchObject({
    state: 'failed',
    code: 'E_PACKAGE_STATE',
  })
})

it('returns the reviewed draft with the session and never submits it, including start retries', async () => {
  const f = fixture()
  const review = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  await f.call({ action: 'enable', reviewId: review.reviewId, operationId: 'enable-draft' })
  const agent = f.entry.agents?.[0]
  if (!agent) throw new Error('fixture agent is missing')
  Object.assign(agent.launch, { prompt: { text: { en: 'Keep editable' }, mode: 'draft' } })
  const ticket = (await f.call({ action: 'prepare', exampleId: f.entry.id, launchId: 'work' })) as {
    launchTicket: string
  }
  const request = { action: 'start', launchTicket: ticket.launchTicket, operationId: 'draft-start' }
  const expected = { sessionId: 'session-1', draft: agent.launch.prompt }
  expect(await f.call(request)).toEqual(expected)
  expect(await f.call(request)).toEqual(expected)
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(0)
})

it('ordinary agent review binds caller workspace and activation, refuses drift and expiry, and keeps draft retries idempotent', async () => {
  const f = fixture()
  let time = 1
  const caller = {
    principal: 'host-user',
    profile: 'test',
    workspace: '/synthetic/workspace',
    activation: 'host-1',
  }
  let plan = await f.backend.resolveAgent('acme/kit#work')
  plan = {
    ...plan,
    launch: { ...plan.launch, prompt: { mode: 'draft', text: { en: 'Review before sending' } } },
  }
  const backend = { caller: async () => caller, resolve: async () => plan, open: f.backend.open }
  const call = (request: Record<string, unknown>) =>
    createAgentLaunches({ directory: f.directory, backend, now: () => time }).call(request)
  const prepare = () => call({ action: 'prepare', agent: plan.ref }) as Promise<{ launchTicket: string }>
  const first = await prepare()
  const request = { action: 'start', launchTicket: first.launchTicket, operationId: 'host-start' }
  expect(await call(request)).toEqual({ sessionId: 'session-1', draft: plan.launch.prompt })
  expect(await call(request)).toEqual({ sessionId: 'session-1', draft: plan.launch.prompt })
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(0)
  await expect(call({ ...request, launchTicket: 'different' })).rejects.toThrow('STALE')
  const drift = await prepare()
  plan = { ...plan, digest: 'changed-permission-or-model-or-source' }
  await expect(
    call({ action: 'start', launchTicket: drift.launchTicket, operationId: 'drift' }),
  ).rejects.toThrow('STALE')
  const expired = await prepare()
  time += 300_001
  await expect(
    call({ action: 'start', launchTicket: expired.launchTicket, operationId: 'expired' }),
  ).rejects.toThrow('STALE')
  const activation = await prepare()
  caller.activation = 'host-2'
  await expect(
    call({ action: 'start', launchTicket: activation.launchTicket, operationId: 'activation' }),
  ).rejects.toThrow('STALE')
  await expect(
    call({ action: 'enable', reviewId: first.launchTicket, operationId: 'escalate' }),
  ).rejects.toThrow('INVALID')
  const rejected = await prepare()
  backend.open = async () => {
    throw { code: -32008, message: 'PRESET_SWITCH_REJECTED', data: { code: 'E_PRESET_UNRESOLVED' } }
  }
  const refusal = { action: 'start', launchTicket: rejected.launchTicket, operationId: 'model-refused' }
  await expect(call(refusal)).rejects.toThrow('E_PRESET_UNRESOLVED')
  expect(await call({ action: 'read', operationId: refusal.operationId })).toMatchObject({
    state: 'failed',
    code: 'E_PRESET_UNRESOLVED',
  })
  await expect(call(refusal)).rejects.toThrow('E_PRESET_UNRESOLVED')
  const unknown = await prepare()
  backend.open = async () => {
    throw new Error('uncertain')
  }
  const retry = { action: 'start', launchTicket: unknown.launchTicket, operationId: 'unknown' }
  await expect(call(retry)).rejects.toThrow('OUTCOME_UNKNOWN')
  backend.open = f.backend.open
  await expect(call(retry)).rejects.toThrow('OUTCOME_UNKNOWN')
  expect(f.sessions.size).toBe(1)
})

it('agent prepare binds an optional registered workspace into the ticket and opens the session there', async () => {
  const f = fixture()
  const launcher = '/synthetic/launcher'
  const registry = new Map([
    [launcher, { activation: 'host:launcher:1', available: true }],
    ['/synthetic/work', { activation: 'host:work:1', available: true }],
    ['/synthetic/offline', { activation: 'host:offline:1', available: false }],
  ])
  const opened: (string | undefined)[] = []
  let home = launcher
  const backend = {
    caller: async (workspace?: string) => {
      const path = workspace ?? home
      const row = registry.get(path)
      if (!row?.available) throw new Error('CAPABILITY_DENIED')
      return { principal: 'host-user', profile: 'test', workspace: path, activation: row.activation }
    },
    resolve: async (ref: string) => f.backend.resolveAgent(ref),
    open: async (plan: AgentPlan, key: string, workspace?: string) => {
      opened.push(workspace)
      return f.backend.open(plan, key)
    },
  }
  const call = (request: Record<string, unknown>) =>
    createAgentLaunches({ directory: f.directory, backend }).call(request)
  const prepare = (extra: Record<string, unknown>) =>
    call({ action: 'prepare', agent: 'acme/kit#work', ...extra }) as Promise<{ launchTicket: string }>
  const picked = await prepare({ workspace: '/synthetic/work' })
  await call({ action: 'start', launchTicket: picked.launchTicket, operationId: 'picked' })
  expect(opened).toEqual(['/synthetic/work'])
  // No workspace keeps the launcher's own.
  const plain = await prepare({})
  await call({ action: 'start', launchTicket: plain.launchTicket, operationId: 'plain' })
  expect(opened).toEqual(['/synthetic/work', undefined])
  // Unknown, unavailable and relative workspaces are refused, never replaced by the launcher's.
  await expect(prepare({ workspace: '/synthetic/unknown' })).rejects.toThrow('CAPABILITY_DENIED')
  await expect(prepare({ workspace: '/synthetic/offline' })).rejects.toThrow('CAPABILITY_DENIED')
  await expect(prepare({ workspace: 'work' })).rejects.toThrow('INVALID_REQUEST')
  await expect(
    call({ action: 'start', launchTicket: 'x', operationId: 'y', workspace: '/synthetic/work' }),
  ).rejects.toThrow('INVALID_REQUEST')
  // The ticket follows its workspace's activation, and another launcher workspace cannot redeem it.
  const drift = await prepare({ workspace: '/synthetic/work' })
  registry.get('/synthetic/work')!.activation = 'host:work:2'
  await expect(
    call({ action: 'start', launchTicket: drift.launchTicket, operationId: 'drift' }),
  ).rejects.toThrow('STALE')
  const moved = await prepare({ workspace: '/synthetic/work' })
  home = '/synthetic/other'
  registry.set(home, { activation: 'host:other:1', available: true })
  await expect(
    call({ action: 'start', launchTicket: moved.launchTicket, operationId: 'moved' }),
  ).rejects.toThrow('STALE')
  expect(opened).toHaveLength(2)
})

const receiptWindow = 7 * 24 * 60 * 60 * 1000
async function retentionFixture(kind: 'agent' | 'example') {
  const f = fixture()
  let call = f.call
  if (kind === 'agent') {
    const plan = await f.backend.resolveAgent('acme/kit#work')
    const backend = {
      caller: async () => ({ principal: 'user', profile: 'test', workspace: '/synthetic', activation: 'a1' }),
      resolve: async () => plan,
      open: (...args: Parameters<ExampleBackend['open']>) => f.backend.open(...args),
    }
    call = (request) => createAgentLaunches({ directory: f.directory, backend, now: f.now }).call(request)
  } else {
    const { reviewId } = (await call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
    await call({ action: 'enable', reviewId, operationId: 'enable' })
  }
  const prepare = () =>
    call(
      kind === 'agent'
        ? { action: 'prepare', agent: 'acme/kit#work' }
        : { action: 'prepare', exampleId: f.entry.id, launchId: 'work' },
    ) as Promise<{ launchTicket: string }>
  const { launchTicket } = await prepare()
  const request = { action: 'start', launchTicket, operationId: 'retained' }
  const file = join(f.directory, kind === 'agent' ? 'agent-operations.json' : 'operations.json')
  const load = () => JSON.parse(readFileSync(file, 'utf8'))
  const store = (state: ReturnType<typeof load>) => writeFileSync(file, JSON.stringify(state))
  return { ...f, call, prepare, request, load, store }
}

for (const kind of ['agent', 'example'] as const) {
  it.each(['prepare', 'start', 'read'])(
    `${kind}: %s prunes 10,000 old receipts but preserves live capacity`,
    async (sweepPath) => {
      const f = await retentionFixture(kind)
      await f.call(f.request)
      const history = f.load()
      const seed = Object.values(history.operations)[0]
      history.operations = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`old-${i}`, seed]))
      f.advance(receiptWindow + 1)
      if (sweepPath === 'prepare') f.store(history)
      if (sweepPath === 'read') {
        history.operations['one-more'] = seed
        f.store(history)
        await expect(f.call({ action: 'read', operationId: f.request.operationId })).rejects.toThrow('DENIED')
        // Even an oversized synthetic history takes at most the admission cap per sweep.
        expect(Object.keys(f.load().operations)).toHaveLength(1)
      }
      const { launchTicket } = await f.prepare()
      const fresh = { launchTicket }
      if (sweepPath === 'start') {
        const state = f.load()
        state.operations = history.operations
        f.store(state)
      }
      expect(await f.call({ ...f.request, ...fresh, operationId: 'fresh' })).toEqual({
        sessionId: 'session-2',
      })
      expect(Object.keys(f.load().operations)).toHaveLength(1)
      const live = f.load()
      const current = { ...(seed as object), terminalAt: f.now() }
      live.operations = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`live-${i}`, current]))
      f.store(live)
      await expect(f.call({ ...f.request, ...fresh, operationId: 'overloaded' })).rejects.toThrow(
        'OVERLOADED',
      )
      expect(Object.keys(f.load().operations)).toHaveLength(10_000)
      expect(f.sessions.size).toBe(2)
    },
  )

  it(`${kind}: retains dedupe and reads for seven days after completion, then refuses the pruned id's expired ticket`, async () => {
    const f = await retentionFixture(kind)
    const open = f.backend.open
    f.backend.open = async (...args) => {
      // The receipt window starts at completion, even when open outlives its ticket.
      f.advance(300_001)
      return open(...args)
    }
    const receipt = await f.call(f.request)
    f.backend.open = async () => {
      throw new Error('must not dispatch an expired or duplicate launch')
    }
    f.advance(receiptWindow - 1)
    expect(await f.call({ action: 'read', operationId: f.request.operationId })).toMatchObject({
      state: 'completed',
      ...(receipt as object),
    })
    expect(await f.call(f.request)).toEqual(receipt)
    await expect(f.call({ ...f.request, launchTicket: 'different' })).rejects.toThrow('STALE')
    f.advance(1)
    await expect(f.call(f.request)).rejects.toThrow('STALE')
    await expect(f.call({ action: 'read', operationId: f.request.operationId })).rejects.toThrow('DENIED')
    expect(Object.keys(f.load().operations)).toHaveLength(0)
    expect(f.sessions.size).toBe(1)
  })

  it(`${kind}: recovers expired running receipts as unknown and never replays failed or unknown operations`, async () => {
    const f = await retentionFixture(kind)
    await f.call(f.request)
    const state = f.load()
    for (const op of Object.values(state.operations) as {
      state: string
      sessionId?: string
      terminalAt?: number
    }[]) {
      if (op.sessionId) {
        op.state = 'running'
        delete op.terminalAt
      }
    }
    f.store(state)
    // A running receipt with a valid ticket is preserved by a read sweep.
    expect(await f.call({ action: 'read', operationId: f.request.operationId })).toMatchObject({
      state: 'running',
    })
    f.advance(300_000)
    expect(await f.call({ action: 'read', operationId: f.request.operationId })).toMatchObject({
      state: 'unknown',
      code: 'OUTCOME_UNKNOWN',
    })
    f.advance(receiptWindow - 1)
    await expect(f.call(f.request)).rejects.toThrow('OUTCOME_UNKNOWN')
    f.advance(1)
    await expect(f.call(f.request)).rejects.toThrow('STALE')
    expect(f.sessions.size).toBe(1)
    const { launchTicket } = await f.prepare()
    const ticket = { launchTicket }
    f.backend.open = async () => {
      throw new Error('E_PACKAGE_STATE')
    }
    const failed = { ...f.request, ...ticket, operationId: 'failed' }
    await expect(f.call(failed)).rejects.toThrow('E_PACKAGE_STATE')
    f.backend.open = async () => {
      throw new Error('must not replay')
    }
    f.advance(receiptWindow - 1)
    expect(await f.call({ action: 'read', operationId: 'failed' })).toMatchObject({
      state: 'failed',
      code: 'E_PACKAGE_STATE',
    })
    await expect(f.call(failed)).rejects.toThrow('E_PACKAGE_STATE')
    f.advance(1)
    await expect(f.call({ action: 'read', operationId: 'failed' })).rejects.toThrow('DENIED')
    expect(Object.keys(f.load().operations)).toHaveLength(0)
  })

  it.each(['ordinary', 'byte-cap'])(
    `${kind}: conservatively dates pre-existing terminal receipts on first observation (%s)`,
    async (size) => {
      const f = await retentionFixture(kind)
      await f.call(f.request)
      const state = f.load()
      let pendingKey: string | undefined
      for (const op of Object.values(state.operations) as { terminalAt?: number }[]) delete op.terminalAt
      if (size === 'byte-cap') {
        const hash = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
        const seed = (Object.values(state.operations) as Record<string, any>[]).find((op) => op.sessionId)!
        const plan = kind === 'agent' ? seed.review.plan : seed.review.launch
        plan.launch.description.en = 'Synthetic retained launch description. '.repeat(50)
        expect(validateAgainst(AgentPlan, plan).ok).toBe(true)
        const owner = kind === 'agent' ? seed.review.owner : seed.owner
        const pending = structuredClone(seed)
        pending.state = 'running'
        pending.review.expires = f.now() + receiptWindow * 5
        delete pending.sessionId
        const pendingRequest = { ...f.request, operationId: 'pending' }
        pending[kind === 'agent' ? 'payload' : 'digest'] = hash(pendingRequest)
        pendingKey = hash([owner, pendingRequest.operationId])
        state.operations[pendingKey] = pending
        const base = Buffer.byteLength(JSON.stringify(state))
        const count = Math.min(
          9998,
          Math.floor((16 * 1024 * 1024 - base) / (Buffer.byteLength(JSON.stringify(seed)) + 200)),
        )
        for (let i = 0; i < count; i++) {
          const request = { ...f.request, operationId: `historical-${i}` }
          const op = structuredClone(seed)
          op[kind === 'agent' ? 'payload' : 'digest'] = hash(request)
          state.operations[hash([owner, request.operationId])] = op
        }
        const remaining = 16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(state)) - 1
        // Fill only valid plan text fields; each remains below its schema string bound.
        const ops = Object.values(state.operations) as Record<string, any>[]
        for (let i = 0, left = remaining; left > 0; i++) {
          const record = ops.filter((op) => (kind === 'agent' ? op.review.plan : op.review.launch))[i]
          if (!record) throw new Error('not enough historical plans')
          const plan = kind === 'agent' ? record.review.plan : record.review.launch
          const extra = Math.min(left, 1000)
          plan.launch.description.en += 'x'.repeat(extra)
          left -= extra
        }
        expect(Buffer.byteLength(JSON.stringify(state))).toBe(16 * 1024 * 1024 - 1)
      }
      f.store(state)
      f.advance(receiptWindow * 2)
      if (size === 'byte-cap') {
        expect(await f.call({ action: 'read', operationId: f.request.operationId })).toMatchObject({
          state: 'completed',
        })
        const file = join(f.directory, kind === 'agent' ? 'agent-operations.json' : 'operations.json')
        expect(Buffer.byteLength(readFileSync(file))).toBeLessThanOrEqual(16 * 1024 * 1024)
        expect(Object.keys(JSON.parse(readFileSync(`${file}.dates`, 'utf8'))).length).toBeGreaterThan(0)
      }
      expect(await f.call(f.request)).toEqual({ sessionId: 'session-1' })
      f.advance(receiptWindow - 1)
      expect(await f.call(f.request)).toEqual({ sessionId: 'session-1' })
      f.advance(1)
      await expect(f.call(f.request)).rejects.toThrow('STALE')
      expect(f.sessions.size).toBe(1)
      if (size === 'byte-cap') {
        expect(pendingKey && f.load().operations[pendingKey].state).toBe('running')
        await f.prepare()
      }
    },
  )
}

it('example receipts remain readable while an activation owns the write lock', async () => {
  const f = fixture()
  const { reviewId } = (await f.call({ action: 'inspect', exampleId: f.entry.id })) as { reviewId: string }
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  let release = () => {}
  const finish = new Promise<void>((resolve) => {
    release = resolve
  })
  f.backend.enable = async () => {
    signalStarted()
    await finish
  }
  const enabling = f.call({ action: 'enable', reviewId, operationId: 'in-flight' })
  await started
  try {
    expect(await f.call({ action: 'read', operationId: 'in-flight' })).toEqual({ state: 'running' })
  } finally {
    release()
    await enabling
  }
})

it('ordinary agent receipts remain readable during slow starts without leaking owners or activation', async () => {
  const f = fixture()
  const caller = { principal: 'user', profile: 'test', workspace: '/synthetic', activation: 'a1' }
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = () => {}
  const finish = new Promise<void>((resolve) => {
    release = resolve
  })
  const plan = await f.backend.resolveAgent('acme/kit#work')
  const facade = createAgentLaunches({
    directory: f.directory,
    now: f.now,
    backend: {
      caller: async () => ({ ...caller }),
      resolve: async () => plan,
      open: async (...args) => {
        entered()
        await finish
        return f.backend.open(args[0], args[1])
      },
    },
  })
  const { launchTicket } = (await facade.call({ action: 'prepare', agent: plan.ref })) as {
    launchTicket: string
  }
  const request = { action: 'start', launchTicket, operationId: 'slow' }
  const pending = facade.call(request)
  await started
  try {
    // A deadline fails this regression promptly instead of waiting for the ten-second lock timeout.
    const snapshot = await Promise.race([
      facade.call({ action: 'read', operationId: 'slow' }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('read blocked')), 1000)
        timer.unref()
      }),
    ])
    expect(snapshot).toEqual({ state: 'running' })
    for (const field of ['principal', 'profile', 'workspace', 'activation'] as const) {
      const previous = caller[field]
      caller[field] = 'another'
      await expect(facade.call({ action: 'read', operationId: 'slow' })).rejects.toThrow('CAPABILITY_DENIED')
      caller[field] = previous
    }
  } finally {
    release()
    await pending
  }
  expect(await facade.call(request)).toEqual({ sessionId: 'session-1' })
  expect(f.sessions.size).toBe(1)
})

it.each([
  'same',
  'hash',
  'version',
  'permission',
  'capability',
  'configuration',
  'legacy',
  'legacy-generation',
  'tampered',
  'revoked',
  'unadopted',
] as const)('reuses only intact adoption consent for an unchanged admitted launch (%s)', async (change) => {
  const f = fixture()
  const original = await f.backend.resolveAgent('acme/kit#work')
  original.sources = [
    {
      id: 'acme/kit',
      version: '1.0.0',
      integrity: 'sha256-original',
      source: 'runtime-snapshot',
      capabilityHash: 'cap-original',
    },
  ]
  const declaration = { id: 'acme', brand: { name: { en: 'Acme' } }, agents: [original.ref] }
  const body = {
    packageId: 'acme/kit',
    version: '1.0.0',
    integrity: 'sha256-original',
    source: { type: 'file', ref: 'file:./synthetic' },
    signature: 'unverified',
    declaration,
    declarationDigest: createHash('sha256').update(jcs(declaration)).digest('hex'),
    dependencies: [],
    replacedRoles: [],
    dependencyDiff: {},
    scope: 'presentation-defaults-and-agent-catalogue',
    recovery: '/?admin',
    warning: 'trusted-code',
    assets: {},
    ...(change === 'legacy' ? {} : { agentLaunches: [original] }),
  }
  const snapshot = {
    ...body,
    consentDigest: createHash('sha256').update(jcs(body)).digest('hex'),
  } as ApplicationPreview
  let state: ApplicationState = {
    revision: 1,
    selection: {
      packageId: snapshot.packageId,
      applicationId: 'acme',
      integrity: snapshot.integrity,
      declarationDigest: snapshot.declarationDigest,
      consentDigest: snapshot.consentDigest,
      ...(change === 'legacy-generation' ? {} : { adoptionGeneration: 'synthetic-adoption-1' }),
      bindingDigest: 'b'.repeat(64),
      consentSnapshot: snapshot,
    },
    status: 'active',
    effective: snapshot.declaration,
    assets: {},
    candidates: [],
  }
  const plan = structuredClone(original)
  if (change === 'hash') plan.sources[0]!.integrity = 'changed'
  if (change === 'version') plan.sources[0]!.version = '2.0.0'
  if (change === 'permission') plan.permission.allow.push('new.permission')
  if (change === 'capability') plan.permission.tools.push('new.tool')
  if (change === 'configuration') plan.effectivePresetHash = 'changed'
  if (change === 'tampered') snapshot.version = 'forged'
  if (change === 'unadopted') state = { ...state, selection: null, status: 'host', effective: null }
  const backend = {
    caller: async () => ({ principal: 'user', profile: 'test', workspace: '/synthetic', activation: 'a1' }),
    resolve: async () => plan,
    open: f.backend.open,
    application: async () => state,
  }
  const facade = createAgentLaunches({ directory: f.directory, backend })
  const prepared = (await facade.call({ action: 'prepare', agent: plan.ref })) as {
    launchTicket: string
    consent: string
  }
  expect(prepared.consent).toBe(
    ['same', 'revoked'].includes(change)
      ? 'covered'
      : ['legacy', 'legacy-generation', 'tampered', 'unadopted'].includes(change)
        ? 'unavailable'
        : 'changed',
  )
  if (change === 'revoked') state = { ...state, selection: null, status: 'host', effective: null }
  const launch = facade.call({ action: 'start', launchTicket: prepared.launchTicket, operationId: 'work' })
  if (change === 'revoked') {
    await expect(launch).rejects.toThrow('STALE')
    expect(f.sessions.size).toBe(0)
  } else {
    await expect(launch).resolves.toMatchObject({ sessionId: 'session-1' })
    expect(f.inputs.size).toBe(0)
  }
})
