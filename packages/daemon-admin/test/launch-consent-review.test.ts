import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { parsePackageBundles } from '@agnes/host'
import { createTestHost, type TestHostOptions } from '@agnes/host/testkit'
import {
  type AgentPlan,
  type ApplicationPreview,
  type ApplicationState,
  jcs,
  validatePackageAdminCall,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createAgentLaunches } from '../src/packages/agent-launches.js'
import { requirePackageAdmin } from '../src/packages/permissions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agh-launch-consent-review-'))
  roots.push(directory)
  let time = 100
  const caller = {
    principal: 'human-a',
    profile: 'profile-a',
    workspace: '/synthetic/a',
    activation: 'activation-a',
  }
  const original: AgentPlan = {
    ref: 'acme/kit#work',
    launch: { title: { en: 'Work' }, description: { en: 'Review' }, preset: 'safe' },
    loop: { id: 'work', version: '1.0.0' },
    bundles: ['acme/kit#work'],
    preset: 'safe',
    pages: [],
    digest: 'sha256-private-runtime',
    compositionHash: 'tree',
    presetHash: 'preset',
    effectivePresetHash: 'effective',
    model: { route: 'demo', model: 'demo' },
    models: { primary: { route: 'demo', model: 'demo' } },
    permission: { readOnly: true, tools: ['read'], allow: [], deny: [] },
    sources: [
      {
        id: 'acme/kit',
        version: '1.0.0',
        integrity: 'sha256-content',
        source: 'runtime-snapshot',
        capabilityHash: 'capability',
      },
    ],
  }
  const body = {
    packageId: 'acme/kit',
    version: '1.0.0',
    integrity: 'sha256-content',
    source: { type: 'file', ref: 'file:./synthetic' },
    signature: 'unverified',
    declaration: { id: 'kit', agents: [original.ref] },
    declarationDigest: hash({ id: 'kit', agents: [original.ref] }),
    agentLaunches: [structuredClone(original)],
    dependencies: [],
    replacedRoles: [],
    dependencyDiff: {},
    scope: 'presentation-defaults-and-agent-catalogue',
    recovery: '/?admin',
    warning: 'trusted-code',
    assets: {},
  }
  const snapshot = { ...body, consentDigest: hash(body) } as ApplicationPreview
  const state: ApplicationState = {
    revision: 1,
    status: 'active',
    effective: snapshot.declaration,
    assets: {},
    candidates: [],
    selection: {
      packageId: snapshot.packageId,
      applicationId: 'kit',
      integrity: snapshot.integrity,
      declarationDigest: snapshot.declarationDigest,
      consentDigest: snapshot.consentDigest,
      adoptionGeneration: 'synthetic-adoption-1',
      bindingDigest: 'b'.repeat(64),
      consentSnapshot: snapshot,
    },
  }
  let plan = structuredClone(original)
  let application = structuredClone(state)
  const opened: { plan: AgentPlan; key: string }[] = []
  let onResolve = () => {}
  let onOpen = () => {}
  const facade = createAgentLaunches({
    directory,
    now: () => time,
    backend: {
      caller: async () => ({ ...caller }),
      resolve: async () => {
        onResolve()
        return structuredClone(plan)
      },
      application: async () => structuredClone(application),
      open: async (value, key) => {
        onOpen()
        opened.push({ plan: value, key })
        return 'session-review'
      },
    },
  })
  const call = (request: Record<string, unknown>) => facade.call(request)
  const prepare = () =>
    call({ action: 'prepare', agent: plan.ref }) as Promise<{ launchTicket: string; consent: string }>
  return {
    original,
    plan,
    state,
    caller,
    opened,
    call,
    prepare,
    setPlan: (value: AgentPlan) => {
      plan = value
    },
    setState: (value: ApplicationState) => {
      application = value
    },
    advance: (ms: number) => {
      time += ms
    },
    onResolve: (value: () => void) => {
      onResolve = value
    },
    onOpen: (value: () => void) => {
      onOpen = value
    },
  }
}

it.each([
  'content',
  'same-version-bytes',
  'version',
  'capability',
  'permission',
  'new-tool',
  'model',
  'preset',
  'effective-preset',
  'composition',
  'bundles',
  'private-runtime',
  'os-isolation',
] as const)('launch-review: drift requires review (%s)', async (change) => {
  const f = fixture(),
    plan = structuredClone(f.original)
  if (change === 'content' || change === 'same-version-bytes') plan.sources[0]!.integrity = 'new-bytes'
  if (change === 'version') plan.sources[0]!.version = '2.0.0'
  if (change === 'capability') plan.sources[0]!.capabilityHash = 'new-capability'
  if (change === 'permission') plan.permission.readOnly = false
  if (change === 'new-tool') plan.permission.tools.push('write')
  if (change === 'model') plan.models.primary = plan.model = { route: 'other', model: 'other' }
  if (change === 'preset') plan.preset = 'other'
  if (change === 'effective-preset') plan.effectivePresetHash = 'other'
  if (change === 'composition') plan.compositionHash = 'other'
  if (change === 'bundles') plan.bundles.push('acme/kit#extra')
  if (change === 'private-runtime' || change === 'os-isolation') plan.digest = 'sha256-new-runtime'
  f.setPlan(plan)
  expect((await f.prepare()).consent).toBe('changed')
  expect(f.opened).toEqual([])
})

it.each([
  'snapshot',
  'snapshot-digest',
  'selection-digest',
  'package',
  'integrity',
  'declaration',
  'application-id',
  'declaration-body',
  'catalogue',
  'legacy',
  'other-app',
] as const)('launch-review: rejects altered snapshot/selection (%s)', async (change) => {
  const f = fixture(),
    state = structuredClone(f.state),
    snapshot = state.selection!.consentSnapshot!
  if (change === 'snapshot') snapshot.version = 'forged'
  if (change === 'snapshot-digest') snapshot.consentDigest = 'c'.repeat(64)
  if (change === 'selection-digest') state.selection!.consentDigest = 'c'.repeat(64)
  if (change === 'package') state.selection!.packageId = 'other'
  if (change === 'integrity') state.selection!.integrity = 'other'
  if (change === 'declaration') state.selection!.declarationDigest = 'c'.repeat(64)
  if (change === 'application-id') state.selection!.applicationId = 'other'
  if (change === 'declaration-body') {
    snapshot.declaration.brand = { name: { en: 'forged' } }
    const { consentDigest: _digest, ...body } = snapshot
    snapshot.consentDigest = state.selection!.consentDigest = hash(body)
  }
  if (change === 'catalogue') snapshot.declaration.agents = ['other/app#work']
  if (change === 'legacy') delete snapshot.agentLaunches
  if (change === 'other-app') f.setPlan({ ...f.original, ref: 'other/app#work' })
  f.setState(state)
  expect((await f.prepare()).consent).toBe('unavailable')
  expect(f.opened).toEqual([])
})

it.each([
  'principal',
  'profile',
  'workspace',
  'activation',
  'expiry',
  'clear',
  'generation',
  'drift',
] as const)('launch-review: refuses stale or transferred ticket (%s)', async (change) => {
  const f = fixture(),
    ticket = await f.prepare()
  expect(ticket.consent).toBe('covered')
  if (['principal', 'profile', 'workspace', 'activation'].includes(change))
    f.caller[change as 'principal'] = 'another'
  if (change === 'expiry') f.advance(300_000)
  if (change === 'clear')
    f.setState({ ...f.state, revision: 2, selection: null, status: 'host', effective: null })
  if (change === 'generation')
    f.setState({
      ...f.state,
      selection: { ...f.state.selection!, adoptionGeneration: 'synthetic-adoption-2' },
    })
  if (change === 'drift') f.setPlan({ ...f.original, digest: 'changed' })
  await expect(
    f.call({ action: 'start', launchTicket: ticket.launchTicket, operationId: change }),
  ).rejects.toThrow('STALE')
  expect(f.opened).toEqual([])
})

it.each(['snapshot', 'selection', 'profile', 'caller', 'permission', 'agentDigest', 'context'])(
  'launch-review: caller cannot inject authority through %s',
  async (field) => {
    const f = fixture()
    await expect(f.call({ action: 'prepare', agent: f.original.ref, [field]: f.state })).rejects.toThrow(
      'INVALID_REQUEST',
    )
    const ticket = await f.prepare()
    await expect(
      f.call({ action: 'start', launchTicket: ticket.launchTicket, operationId: 'inject', [field]: f.state }),
    ).rejects.toThrow('INVALID_REQUEST')
    expect(f.opened).toEqual([])
  },
)

it('launch-review: adoption RPC never accepts a client supplied snapshot or selection', () => {
  const f = fixture()
  const params = {
    profile: 'profile-a',
    packageId: 'acme/kit',
    clientId: 'client',
    commandId: 'adopt',
    expectedRevision: 0,
    consentDigest: f.state.selection!.consentDigest,
  }
  expect(validatePackageAdminCall('_agnes/v1/applications.adopt', 'params', params).ok).toBe(true)
  for (const field of ['selection', 'consentSnapshot', 'agentLaunches', 'adoptionGeneration']) {
    expect(
      validatePackageAdminCall('_agnes/v1/applications.adopt', 'params', {
        ...params,
        [field]: f.state.selection,
      }).ok,
    ).toBe(false)
  }
})

it('launch-review: covered and manual launches deliver the identical admitted plan, without sending a prompt', async () => {
  const direct = fixture(),
    manual = fixture()
  manual.setState({ ...manual.state, selection: null, status: 'host', effective: null })
  for (const [f, consent] of [
    [direct, 'covered'],
    [manual, 'unavailable'],
  ] as const) {
    const ticket = await f.prepare()
    expect(ticket.consent).toBe(consent)
    await expect(
      f.call({ action: 'start', launchTicket: ticket.launchTicket, operationId: 'work' }),
    ).resolves.toEqual({ sessionId: 'session-review' })
    expect(f.opened.map((value) => value.plan)).toEqual([f.original])
    f.advance(300_000)
    f.setState({ ...f.state, selection: null, status: 'host', effective: null })
    await expect(
      f.call({ action: 'start', launchTicket: ticket.launchTicket, operationId: 'work' }),
    ).resolves.toEqual({ sessionId: 'session-review' })
    await expect(f.call({ action: 'read', operationId: 'work' })).resolves.toMatchObject({
      state: 'completed',
      sessionId: 'session-review',
    })
    expect(f.opened).toHaveLength(1)
  }
  expect(direct.opened[0]!.plan).toEqual(manual.opened[0]!.plan)
})

it.each(['expiry', 'clear'] as const)(
  'launch-review: LD2 rechecks %s after asynchronous resolution before dispatch',
  async (change) => {
    const f = fixture(),
      ticket = await f.prepare()
    // The last pre-dispatch resolve is suspended while the consent/ticket becomes invalid.
    let resolves = 0
    f.onResolve(() => {
      if (++resolves !== 2) return
      if (change === 'expiry') f.advance(300_000)
      else f.setState({ ...f.state, selection: null, status: 'host', effective: null })
    })
    await expect(
      f.call({ action: 'start', launchTicket: ticket.launchTicket, operationId: change }),
    ).rejects.toThrow('STALE')
    expect(f.opened).toEqual([])
  },
)

function reviewedState(plan: AgentPlan): ApplicationState {
  const state = fixture().state,
    selection = state.selection!,
    snapshot = selection.consentSnapshot!
  snapshot.packageId = selection.packageId = '@agnes/code'
  snapshot.declaration.agents = [plan.ref]
  snapshot.agentLaunches = [structuredClone(plan)]
  snapshot.declarationDigest = selection.declarationDigest = hash(snapshot.declaration)
  const { consentDigest: _digest, ...body } = snapshot
  snapshot.consentDigest = selection.consentDigest = hash(body)
  return state
}
async function realHost(name = 'local-dev') {
  const directory = mkdtempSync(join(tmpdir(), 'agh-launch-real-host-'))
  roots.push(directory)
  const bundles = {
    work: {
      profile: { tools: ['read'] },
      presets: { safe: { name: 'safe', extends: 'standard' } },
      launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' },
    },
  }
  const options = {
    dataDir: directory,
    provider: (profile) =>
      new ScriptedProvider({
        scripts: [],
        models: (profile.provider.routes ?? []).flatMap((route) =>
          (route.models ?? []).map((model) => ({ ...model, input: ['text' as const] })),
        ),
      }),
    script: [],
    disableSessionTitle: true,
    profileInputs: { user: { name }, bundleCatalog: parsePackageBundles('@agnes/code', bundles) },
    packageDirs: Object.fromEntries(
      ['base', 'code', 'ai'].map((id) => [
        `@agnes/${id}`,
        fileURLToPath(new URL(`../../${id}`, import.meta.url)),
      ]),
    ),
  } satisfies TestHostOptions
  return { ...(await createTestHost(options)), directory }
}

it.each([
  [
    'a coded rejection that may follow registry.open',
    { data: { code: 'LOOP_MISSING' } },
    'unknown',
    'OUTCOME_UNKNOWN',
    'LOOP_MISSING',
  ],
  [
    'a tool filter refusal after open',
    { data: { code: 'INVALID_PARAMS' } },
    'unknown',
    'OUTCOME_UNKNOWN',
    'INVALID_PARAMS',
  ],
  [
    'a sandbox readiness refusal (loopback_serve off macOS) with the daemon diagnostic id',
    { data: { code: 'E_SANDBOX_WORKSPACE', diagnosticId: '0a1b2c3d-0000-4000-8000-0123456789ab' } },
    'unknown',
    'OUTCOME_UNKNOWN',
    'E_SANDBOX_WORKSPACE',
    '0a1b2c3d-0000-4000-8000-0123456789ab',
  ],
  ['a coded timeout', { data: { code: 'REQUEST_TIMEOUT' } }, 'unknown', 'OUTCOME_UNKNOWN', 'REQUEST_TIMEOUT'],
  ['a lost answer', {}, 'unknown', 'OUTCOME_UNKNOWN', undefined],
  ['a reviewed refusal code', { data: { code: 'E_PACKAGE_STATE' } }, 'failed', 'E_PACKAGE_STATE', undefined],
])(
  'launch-review: %s from session.new is reported as %s',
  async (_name, thrown, state, code, cause, diagnosticId?) => {
    const f = fixture()
    const { launchTicket } = await f.prepare()
    f.onOpen(() => {
      throw Object.assign(new Error('session.new failed'), thrown)
    })
    await expect(f.call({ action: 'start', launchTicket, operationId: 'refused' })).rejects.toThrow(code)
    await expect(f.call({ action: 'read', operationId: 'refused' })).resolves.toEqual({
      state,
      code,
      ...(cause ? { cause } : {}),
      ...(diagnosticId ? { diagnosticId } : {}),
    })
  },
)
it('launch-review: a refusal before session.new is dispatched is failed, not unknown', async () => {
  const f = fixture()
  const { launchTicket } = await f.prepare()
  // The first resolve is the start's admission check; the second is the re-check before dispatch.
  let resolves = 0
  f.onResolve(() => {
    if (++resolves === 2) throw new Error('resolve unavailable')
  })
  await expect(f.call({ action: 'start', launchTicket, operationId: 'early' })).rejects.toThrow()
  await expect(f.call({ action: 'read', operationId: 'early' })).resolves.toEqual({
    state: 'failed',
    code: 'E_LAUNCH_FAILED',
  })
  expect(f.opened).toHaveLength(0)
})

it('launch-review: a snapshot replayed from another real profile never becomes covered', async () => {
  const a = await realHost(),
    b = await realHost('profile-b')
  try {
    const original = await a.host.resolveAgent!('@agnes/code#work'),
      current = await b.host.resolveAgent!('@agnes/code#work')
    expect(current.digest).not.toBe(original.digest)
    const directory = mkdtempSync(join(tmpdir(), 'agh-launch-replay-'))
    roots.push(directory)
    const facade = createAgentLaunches({
      directory,
      backend: {
        caller: async () => ({
          principal: 'human',
          profile: 'profile-b',
          workspace: b.directory,
          activation: 'b',
        }),
        resolve: async () => current,
        application: async () => reviewedState(original),
        open: async () => {
          throw new Error('must not auto-start')
        },
      },
    })
    expect(await facade.call({ action: 'prepare', agent: current.ref })).toMatchObject({ consent: 'changed' })
  } finally {
    await a.host.close()
    await b.host.close()
  }
})

// Follow-up: session.new needs a backend adoption lease at its publish point across the RPC boundary.
// Keep the reviewer's zero-session assertion as an expected failure, not a successful cancellation.
it.fails('launch-review: LD3 un-adoption while session.new is pending blocks real Host session creation (known follow-up, expected failure)', async () => {
  const f = await realHost()
  let release = () => {},
    entered = () => {}
  const blocked = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  const sessions: Awaited<ReturnType<typeof f.host.createSession>>[] = []
  try {
    const plan = await f.host.resolveAgent!('@agnes/code#work')
    let state = reviewedState(plan)
    const facade = createAgentLaunches({
      directory: join(f.directory, 'launches'),
      backend: {
        caller: async () => ({
          principal: 'human',
          profile: 'local-dev',
          workspace: f.directory,
          activation: 'a',
        }),
        resolve: (ref) => f.host.resolveAgent!(ref),
        application: async () => structuredClone(state),
        open: async (admitted, key) => {
          entered()
          await blocked
          const session = await f.host.createSession({
            key,
            cwd: f.directory,
            agent: admitted.ref,
            agentDigest: admitted.digest,
          })
          sessions.push(session)
          expect(session.currentTools().resolve('read')).toBeDefined()
          expect(session.currentTools().resolve('write')).toBeUndefined()
          expect(session.permissionContext.policy).not.toBe('full-access')
          expect(await session.scan({ type: 'user/message', limit: 1 })).toEqual([])
          return session.key
        },
      },
    })
    const ticket = (await facade.call({ action: 'prepare', agent: plan.ref })) as {
      consent: string
      launchTicket: string
    }
    expect(ticket.consent).toBe('covered')
    const pending = facade.call({
      action: 'start',
      launchTicket: ticket.launchTicket,
      operationId: 'pending',
    })
    await started
    state = { ...state, revision: 2, selection: null, status: 'host', effective: null }
    release()
    const result = await pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    expect(sessions).toHaveLength(0)
    expect(result).toHaveProperty('error')
  } finally {
    release()
    for (const session of sessions) await session.close()
    await f.host.close()
  }
})

it('launch-review: read-only browser and ungranted callers cannot write an adoption record', () => {
  expect(() => requirePackageAdmin('_agnes/v1/applications.adopt', undefined)).toThrow()
  const readOnly = {
    audience: 'admin' as const,
    principalId: 'reader',
    clientId: 'reader',
    permissions: ['packages.read' as const],
    methods: ['_agnes/v1/applications.get' as const],
  }
  for (const method of ['_agnes/v1/applications.adopt', '_agnes/v1/applications.clear'] as const) {
    expect(() => requirePackageAdmin(method, readOnly)).toThrow()
  }
})

it('launch-review: canonical key order is reusable, but changing the same JCS body is not', async () => {
  const f = fixture(),
    state = structuredClone(f.state),
    snapshot = state.selection!.consentSnapshot!
  state.selection!.consentSnapshot = Object.fromEntries(
    Object.entries(snapshot).reverse(),
  ) as ApplicationPreview
  f.setState(state)
  expect((await f.prepare()).consent).toBe('covered')
  snapshot.agentLaunches![0] = {
    ...(snapshot.agentLaunches![0] as unknown as Record<string, unknown>),
    digest: 'changed',
  }
  f.setState({ ...state, selection: { ...state.selection!, consentSnapshot: snapshot } })
  expect((await f.prepare()).consent).toBe('unavailable')
})
