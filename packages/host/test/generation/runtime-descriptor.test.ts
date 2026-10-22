import type { ProviderCatalogEntry } from '@agnes/extension-api'
import {
  type SessionCapabilitySet,
  SessionRuntimeDescriptor,
  validateAgainst,
  validatePackageAdminData,
} from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  coldHeadId,
  describeColdSession,
  describeSessionRuntime,
  generationSessions,
  mergeGenerationStatus,
  projectGenerationStatus,
  readGenerationStatusAsync,
  type SessionRuntimeInput,
} from '../../src/runtime/generation/runtime-descriptor.js'
import { describeGenerationStatus } from '../../src/runtime/generation/status.js'
import { mergeCompositionStatuses } from '../../src/runtime/profile/composition-status.js'

const source = { layer: 'default', name: 'test' } as const
const items: SessionCapabilitySet['tools'] = []
const capabilities: SessionCapabilitySet = {
  compositionHash: 'comp-1',
  preset: 'default',
  bundles: ['office'],
  codePin: { generationId: 'gen-old', legacy: false, packages: [] },
  loop: { value: { id: 'default', version: '1.0.0' }, source },
  modelRoutes: { value: null, source },
  permissions: {
    preset: 'default',
    policy: 'default',
    toolRuntime: 'default',
    readOnly: false,
    approvalMode: 'auto-review',
    source,
  },
  sandbox: { provider: 'local', onUnavailable: 'deny', source },
  compaction: { engine: 'default', source },
  persistence: { provider: 'sqlite', source },
  tools: items,
  mcp: items,
  skills: items,
  modelAdapters: items,
  childEngines: items,
  childModels: items,
  uiModules: items,
  surfaces: items,
  packages: items,
  plugins: items,
  selectedModelAdapters: ['openai'],
}
const entry = (
  kind: string,
  id: string,
  version: string,
  scope: ProviderCatalogEntry['scope'] = 'generation',
  active = true,
): ProviderCatalogEntry => ({
  kind,
  id,
  version,
  sourcePackage: `pkg/${id}`,
  capabilities: [],
  restartRequired: scope === 'process',
  authority: 'open',
  required: false,
  pinned: false,
  scope,
  active,
  selectedFor: active ? ['default'] : [],
})

it('projects a draining composition without mutating its durable generation facts', () => {
  const active = {
    generations: [
      {
        id: 'g',
        state: 'active' as const,
        boundSessions: 2,
        openSessions: 1,
        live: true,
        packages: [{ id: 'p', version: '1' }],
      },
    ],
    plugins: [
      { id: 'p', state: 'active' as const, boundSessions: 2, drainingSessions: 0, historicalSessions: 0 },
    ],
  }
  expect(projectGenerationStatus(active, false)).toBe(active)
  expect(projectGenerationStatus(active, true)).toMatchObject({
    generations: [{ state: 'draining' }],
    plugins: [{ state: 'draining', drainingSessions: 2, historicalSessions: 1 }],
  })
  expect(active.generations[0]?.state).toBe('active')
})

it('reads cold generation descriptions and propagates damaged metadata', async () => {
  const store = {
    sessions: () => [{ sessionKey: 's', generationId: 'g' }],
    describe: () => ({ id: 'g', packages: [{ id: 'p', version: '1' }] }),
  }
  const describe = (
    _pins: unknown,
    read: (id: string) => { packages: { id: string; version: string }[] },
  ) => ({
    generations: [
      {
        id: 'g',
        state: 'historical' as const,
        boundSessions: 1,
        openSessions: 0,
        live: false,
        packages: read('g').packages,
      },
    ],
    plugins: [],
  })
  await expect(readGenerationStatusAsync(store as never, describe as never, [])).resolves.toMatchObject({
    generations: [{ packages: [{ id: 'p' }] }],
  })
  await expect(
    readGenerationStatusAsync(
      {
        ...store,
        describe: () => {
          throw new Error('snapshot damaged')
        },
      } as never,
      describe as never,
      [],
    ),
  ).rejects.toThrow('snapshot damaged')
})
const oldCatalog = [
  entry('loop', 'default', '1.0.0'),
  entry('compaction', 'default', '1.0.0'),
  entry('sandbox', 'local', '1.0.0', 'process'),
  entry('model-adapter', 'openai', '1.0.0'),
]
const input = (overrides: Partial<SessionRuntimeInput> = {}): SessionRuntimeInput => ({
  sessionKey: 's1',
  generation: { id: 'gen-old', state: 'active' },
  capabilities,
  running: { catalog: oldCatalog, seams: { approval: 'builtin', sandbox: 'builtin' } },
  configured: { catalog: oldCatalog, seams: { approval: 'builtin', sandbox: 'builtin' } },
  profileHash: 'profile-1',
  resourceRows: [],
  restartRequired: [],
  ...overrides,
})

describe('describeSessionRuntime', () => {
  it('describes the running selections and passes the wire schema', () => {
    const descriptor = describeSessionRuntime(
      input({
        modelRevision: 'fp-1',
        permission: { policy: 'full-access', principal: 'full-access-chooser' },
        resourceRows: [
          { id: 'ext:agnes/skills', liveResources: ['skills'], liveResourceRevision: 'rev-skills' },
          { id: 'ext:agnes/jobs' },
        ],
        sandbox: { policyDigest: 'digest-1', enforcement: { level: 'full', scope: ['fs'] } },
      }),
    )
    expect(validateAgainst(SessionRuntimeDescriptor, descriptor).ok).toBe(true)
    expect(descriptor).toMatchObject({
      generation: { id: 'gen-old', current: true, state: 'active' },
      composition: { hash: 'comp-1' },
      preset: { name: 'default', bundles: ['office'] },
      loop: { id: 'default', version: '1.0.0' },
      policy: {
        permission: { policy: 'full-access', principal: 'full-access-chooser' },
        approvalMode: 'auto-review',
        toolPolicy: 'default',
        sandbox: { provider: 'local', policyDigest: 'digest-1', enforcement: { level: 'full' } },
      },
      resources: {
        profileHash: 'profile-1',
        modelRevision: 'fp-1',
        items: [{ id: 'ext:agnes/skills', resources: ['skills'], revision: 'rev-skills' }],
      },
      restartRequired: [],
    })
    expect(descriptor.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'loop', id: 'default', version: '1.0.0', binding: 'generation' }),
        expect.objectContaining({ kind: 'model-adapter', id: 'openai', sourcePackage: 'pkg/openai' }),
        expect.objectContaining({ kind: 'sandbox', id: 'local', binding: 'process', scope: 'process' }),
      ]),
    )
    expect(descriptor.providers.some((item) => item.pending)).toBe(false)
    expect(descriptor.seams).toEqual([
      { kind: 'approval', provider: 'builtin', pinned: false },
      { kind: 'sandbox', provider: 'builtin', pinned: false },
    ])
  })

  it('reports a session pinned to an old generation while a new one is current', () => {
    const next = [
      entry('loop', 'default', '1.0.0'),
      entry('compaction', 'summary', '2.0.0'),
      entry('sandbox', 'local', '1.0.0', 'process'),
      entry('model-adapter', 'openai', '1.0.0'),
    ]
    const descriptor = describeSessionRuntime(
      input({
        generation: { id: 'gen-old', state: 'draining', newerId: 'gen-new' },
        configured: { catalog: next, seams: { approval: 'strict', sandbox: 'builtin' } },
        pinnedSeams: new Set(['approval']),
      }),
    )
    expect(descriptor.generation).toEqual({
      id: 'gen-old',
      current: false,
      state: 'draining',
      newer: { id: 'gen-new', effect: 'new-sessions' },
    })
    expect(descriptor.providers.find((item) => item.kind === 'compaction')).toMatchObject({
      id: 'default',
      pending: { id: 'summary', version: '2.0.0', effect: 'new-sessions' },
    })
    expect(descriptor.providers.filter((item) => item.pending).map((item) => item.kind)).toEqual([
      'compaction',
    ])
    expect(descriptor.seams.find((item) => item.kind === 'approval')).toEqual({
      kind: 'approval',
      provider: 'builtin',
      pinned: true,
      pending: { id: 'strict', effect: 'new-sessions' },
    })
    expect(descriptor.restartRequired).toEqual([])
  })

  it('shows the implementation a pinned seam was bound to, not today’s selection', () => {
    const descriptor = describeSessionRuntime(
      input({
        running: { catalog: oldCatalog, seams: { approval: 'strict', sandbox: 'builtin' } },
        configured: { catalog: oldCatalog, seams: { approval: 'newest', sandbox: 'builtin' } },
        pinnedSeams: new Set(['approval']),
        pinnedBindings: [{ kind: 'approval', provider: 'bound-at-open', version: '1.4.0' }],
      }),
    )
    expect(descriptor.seams.find((item) => item.kind === 'approval')).toEqual({
      kind: 'approval',
      provider: 'bound-at-open',
      version: '1.4.0',
      pinned: true,
      pending: { id: 'newest', effect: 'new-sessions' },
    })
  })

  it('flags a process-scoped selection change and refused inputs as restart-required', () => {
    const next = oldCatalog.map((item) =>
      item.kind === 'sandbox' ? entry('sandbox', 'remote', '1.0.0', 'process') : item,
    )
    const descriptor = describeSessionRuntime(
      input({ configured: { catalog: next, seams: {} }, restartRequired: ['seam:platform'] }),
    )
    expect(descriptor.providers.find((item) => item.kind === 'sandbox')).toMatchObject({
      id: 'local',
      pending: { id: 'remote', effect: 'restart-required' },
    })
    expect(descriptor.restartRequired).toEqual(['sandbox', 'seam:platform'])
  })

  it('does not call a session behind when it chose its own provider', () => {
    const next = oldCatalog.map((item) => (item.kind === 'loop' ? entry('loop', 'planner', '2.0.0') : item))
    const descriptor = describeSessionRuntime(
      input({
        capabilities: { ...capabilities, loop: { value: { id: 'custom', version: '9.0.0' }, source } },
        configured: { catalog: next, seams: { approval: 'builtin', sandbox: 'builtin' } },
      }),
    )
    expect(descriptor.providers.find((item) => item.kind === 'loop')?.pending).toBeUndefined()
  })
})

describe('cold session descriptor', () => {
  it('reports only the durable pin and composition record, and leaves live sections out', () => {
    const cold = describeColdSession({
      sessionKey: 'old',
      pin: {
        generationId: 'gen-old',
        loop: { id: 'acme.loop', version: '1.0.0' },
        seams: [{ kind: 'billing', provider: 'acme.bill', version: '2.0.0' }],
      },
      head: { scoped: false, ownKey: 'sha256-x', ownHeadId: 'gen-new', durableHeadId: () => undefined },
      failed: false,
      composition: { hash: 'sha256-x', preset: 'review', bundles: ['b1'] },
    })
    expect(cold).toEqual({
      sessionKey: 'old',
      loaded: false,
      generation: {
        id: 'gen-old',
        current: false,
        state: 'historical',
        newer: { id: 'gen-new', effect: 'new-sessions' },
      },
      composition: { hash: 'sha256-x' },
      preset: { name: 'review', bundles: ['b1'] },
      loop: { id: 'acme.loop', version: '1.0.0' },
      providers: [],
      seams: [{ kind: 'billing', provider: 'acme.bill', version: '2.0.0', pinned: true }],
      restartRequired: [],
    })
    expect(cold.policy).toBeUndefined()
    expect(cold.resources).toBeUndefined()
    expect(validateAgainst(SessionRuntimeDescriptor, cold).ok).toBe(true)
  })

  it('claims no newer generation when no durable record exists', () => {
    const cold = describeColdSession({
      sessionKey: 'bare',
      head: { scoped: false, ownKey: 'default', durableHeadId: () => undefined },
      failed: false,
    })
    expect(cold).toMatchObject({ loaded: false, generation: { current: true, state: 'active' } })
    expect(cold.preset).toBeUndefined()
    expect(cold.loop).toBeUndefined()
  })
})

describe('cold head of a session composition', () => {
  const durable = (hash: string) => ({ 'sha256-b': 'gen-b' })[hash]
  const head = (input: Partial<Parameters<typeof coldHeadId>[0]>) =>
    coldHeadId({ scoped: true, ownKey: 'sha256-a', ownHeadId: 'gen-a', durableHeadId: durable, ...input })

  it('answers with the host head only for its own composition or an unscoped deployment', () => {
    expect(head({ compositionHash: 'sha256-a' })).toBe('gen-a')
    expect(head({ scoped: false })).toBe('gen-a')
  })

  it('reads another composition head from the durable record, never the default composition head', () => {
    expect(head({ compositionHash: 'sha256-b' })).toBe('gen-b')
    // B was not upgraded: its session on gen-b is current, whatever composition A runs.
    const cold = describeColdSession({
      sessionKey: 's',
      pin: { generationId: 'gen-b' },
      composition: { hash: 'sha256-b', preset: 'standard', bundles: [] },
      head: { scoped: true, ownKey: 'sha256-a', ownHeadId: 'gen-a', durableHeadId: durable },
      failed: false,
    })
    expect(cold.generation).toMatchObject({ id: 'gen-b', current: true, state: 'active' })
    expect(cold.generation.newer).toBeUndefined()
  })

  it('claims no head when the composition is unknown or has none recorded', () => {
    expect(head({})).toBeUndefined()
    expect(head({ compositionHash: 'sha256-c' })).toBeUndefined()
  })
})

it('merges composition open facts while counting sessions beyond the bounded display', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const pins = Array.from({ length: 270 }, (_, index) => ({
    sessionKey: `session-${index}`,
    generationId: id,
  }))
  const base = {
    id,
    state: 'historical' as const,
    boundSessions: pins.length,
    openSessions: 0,
    live: false,
    packages: [],
  }
  const first = {
    ...base,
    openSessions: 1,
    live: true,
    sessions: generationSessions(pins, id, (key) => key === 'session-0'),
  }
  const second = {
    ...base,
    openSessions: 2,
    sessions: generationSessions(pins, id, (key) => key === 'session-1' || key === 'session-269'),
  }
  const opened = [0, 1, 269].map((index) => ({ key: `session-${index}`, pluginGenerationId: id }))
  const merged = mergeGenerationStatus(first, second, opened)
  expect(merged).toMatchObject({ boundSessions: 270, openSessions: 3, live: true, state: 'draining' })
  expect(merged.sessions).toHaveLength(256)
  expect(merged.sessions).toEqual(
    expect.arrayContaining([
      { key: 'session-0', open: true },
      { key: 'session-1', open: true },
    ]),
  )
  const closed = { ...base, sessions: generationSessions(pins, id, () => false) }
  expect(mergeGenerationStatus(closed, closed, [])).toMatchObject({
    boundSessions: 270,
    openSessions: 0,
    state: 'historical',
  })
})

it.each([false, true])(
  'keeps current plugin failures separate from retained generations (reverse: %s)',
  (reverse) => {
    const currentId = '11111111-1111-4111-8111-111111111111'
    const oldId = '22222222-2222-4222-8222-222222222222'
    const snapshot = (id: string, version: string) => ({ id, packages: [{ id: 'p', version }] })
    const host = { kernel: { sessions: new Map(), get: () => undefined }, extensions: () => [] }
    let retainedError: Error | undefined
    const current = { snapshot: snapshot(currentId, '2'), host }
    const historical = {
      snapshot: snapshot(oldId, '1'),
      host: { ...host, extensions: () => (retainedError ? [{ package: 'p', error: retainedError }] : []) },
    }
    const input = {
      pins: [
        { sessionKey: 'saved', generationId: oldId },
        { sessionKey: 'fresh', generationId: currentId },
      ],
      read: () => historical.snapshot,
      failures: new Map([[oldId, { code: 'E_SEAM_INIT', message: 'fixture retained failure' }]]),
      live: new Map(
        reverse
          ? [
              [oldId, historical],
              [currentId, current],
            ]
          : [
              [currentId, current],
              [oldId, historical],
            ],
      ),
      failedSnapshots: new Map(),
      basePackages: new Set(),
      current,
      initial: host,
      requiresRestart: () => false,
      store: { scanDamage: () => [] },
      profileDir: '/fixture',
    } as unknown as Parameters<typeof describeGenerationStatus>[0]
    const before = describeGenerationStatus(input)
    expect(validatePackageAdminData('PluginGenerationStatus', before).ok).toBe(true)
    expect(
      validatePackageAdminData('PluginGenerationStatus', {
        ...before,
        generations: before.generations.map(({ current: _current, ...generation }) => generation),
      }).ok,
    ).toBe(true)
    expect(
      validatePackageAdminData('PluginGenerationStatus', {
        ...before,
        generations: [{ ...before.generations[0], current: 'yes' }],
      }).ok,
    ).toBe(false)
    expect(before.plugins).toEqual([
      { id: 'p', state: 'active', boundSessions: 2, drainingSessions: 1, historicalSessions: 1 },
    ])
    expect(before.generations.find((generation) => generation.id === oldId)).toMatchObject({
      state: 'failed',
      error: 'E_SEAM_INIT',
    })
    const retired = {
      ...projectGenerationStatus(before, true),
      plugins: [{ ...before.plugins[0]!, state: 'failed' as const, error: 'E_PROVIDER_INCOMPATIBLE' }],
    }
    expect(retired.currentGenerationId).toBeUndefined()
    const merge = (statuses: (typeof before)[], failures = new Map<string, string>()) =>
      mergeCompositionStatuses(statuses, [], failures)
    for (const statuses of [
      [before, retired],
      [retired, before],
    ]) {
      expect(merge(statuses).plugins).toEqual(before.plugins)
      expect(merge(statuses).generations.find((generation) => generation.id === oldId)).toMatchObject({
        state: 'failed',
        error: 'E_SEAM_INIT',
      })
      expect(merge(statuses).currentGenerationId).toBe(currentId)
      expect(merge(statuses, new Map([[currentId, 'E_SEAM_INIT']])).plugins[0]).toMatchObject({
        state: 'failed',
        error: 'E_SEAM_INIT',
      })
    }
    input.failures = new Map([[currentId, { code: 'E_SEAM_INIT', message: 'fixture current failure' }]])
    const failed = describeGenerationStatus(input)
    expect(failed.plugins[0]).toMatchObject({ state: 'failed', error: 'E_SEAM_INIT' })
    expect(merge([failed, retired]).plugins[0]).toMatchObject({
      state: 'failed',
      error: 'E_SEAM_INIT',
      drainingSessions: 1,
      historicalSessions: 1,
    })
    const roleId = '33333333-3333-4333-8333-333333333333'
    const role = {
      ...failed,
      currentGenerationId: roleId,
      generations: failed.generations.map((generation) =>
        generation.id === currentId ? { ...generation, id: roleId } : generation,
      ),
    }
    for (const statuses of [
      [before, role],
      [role, before],
    ])
      expect(merge(statuses).plugins[0]).toMatchObject({ state: 'failed', error: 'E_SEAM_INIT' })
    input.failures = new Map()
    retainedError = Object.assign(new Error('Private diagnostic text must stay local'), {
      code: 'E_PROVIDER_INVALID',
    })
    const retainedFailure = describeGenerationStatus(input)
    expect(retainedFailure.plugins[0]).toMatchObject({ state: 'active' })
    expect(retainedFailure.generations.find((generation) => generation.id === oldId)).toMatchObject({
      current: false,
      state: 'failed',
      error: 'E_PROVIDER_INVALID',
    })
    expect(JSON.stringify(retainedFailure)).not.toContain('Private diagnostic')
    input.requiresRestart = () => true
    expect(merge([describeGenerationStatus(input), retired]).plugins[0]).toMatchObject({
      state: 'restart-required',
    })
  },
)
