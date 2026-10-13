import type { ProviderCatalogEntry } from '@agnes/extension-api'
import { type SessionCapabilitySet, SessionRuntimeDescriptor, validateAgainst } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  describeColdSession,
  describeSessionRuntime,
  type SessionRuntimeInput,
} from '../../src/runtime/generation/runtime-descriptor.js'

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
      headId: 'gen-new',
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

  it('leaves everything unknown when no durable record exists', () => {
    const cold = describeColdSession({ sessionKey: 'bare', failed: false })
    expect(cold).toMatchObject({ loaded: false, generation: { current: true, state: 'active' } })
    expect(cold.preset).toBeUndefined()
    expect(cold.loop).toBeUndefined()
  })
})
