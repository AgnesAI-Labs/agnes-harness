import { buildDecisionRegistry } from '@agnes/ai'
import { FakeDecisionAdapter, fakeModel } from '@agnes/ai/testkit'
import { type PresetView, presetDefaults } from '@agnes/core'
import type { DecisionModelRecord, ModelRecord, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { buildProvider } from '../../src/assemble/provider.js'
import { materializeRoutes, pinPresetRoutes, verifyRoutes } from '../../src/assemble/routes.js'
import type { PresetDoc } from '../../src/presets/types.js'
import { validatedPresetViewInput } from '../../src/presets/validate.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ResolvedProfile } from '../../src/profile/types.js'

const jevModel: DecisionModelRecord = {
  id: 'jev-1.13.0',
  name: 'Jev 1.13.0',
  api: 'typesafe-systemone',
  route: 'jev',
  baseUrl: 'https://api.typesafe.ai/v1',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const GW: RouteDecl = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  models: [fakeModel({ id: 'm', route: 'gw' })],
}
const JEV: RouteDecl = {
  route: 'jev',
  api: 'typesafe-systemone',
  baseUrl: 'https://api.typesafe.ai/v1',
  credentialRef: 'secret://typesafe/default',
  models: [jevModel],
}
const profile = (routes: RouteDecl[]): ResolvedProfile =>
  ({ name: 'p', provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes } }) as ResolvedProfile
const preset = (route: Record<string, string>, id: Record<string, string> = {}): PresetView => {
  const d = presetDefaults()
  return { ...d, model: { ...d.model, route, id } }
}
const refusal = (fn: () => unknown): { code: string; detail: Record<string, unknown> } => {
  try {
    fn()
  } catch (e) {
    return e as { code: string; detail: Record<string, unknown> }
  }
  throw new Error('expected a refusal')
}

describe('materializeRoutes with a decision key', () => {
  it('resolves the decision key to the decision route and its decision model', () => {
    expect(materializeRoutes(preset({ primary: 'gw', decision: 'jev' }), profile([GW, JEV]))).toEqual({
      primary: { route: 'gw', model: 'm' },
      decision: { route: 'jev', model: 'jev-1.13.0' },
    })
  })

  it.each([
    ['the decision key on a chat route', { primary: 'gw', decision: 'gw' }],
    ['a chat key on the decision route', { primary: 'jev' }],
    [
      'the default sentinel on the decision key when the first route is chat',
      { primary: 'gw', decision: 'default' },
    ],
  ])('refuses %s as slot-kind', (_name, route) => {
    const r = refusal(() => materializeRoutes(preset(route), profile([GW, JEV])))
    expect(r.code).toBe('E_PRESET_UNRESOLVED')
    expect(r.detail.reason).toBe('slot-kind')
  })

  it('refuses a decision pin the decision route does not declare', () => {
    const r = refusal(() =>
      materializeRoutes(preset({ primary: 'gw', decision: 'jev' }, { decision: 'm' }), profile([GW, JEV])),
    )
    expect(r.detail.reason).toBe('model-undeclared')
  })

  it('pins the decision target into the preset like any slot', () => {
    const p = preset({ primary: 'gw', decision: 'jev' })
    const pinned = pinPresetRoutes(p, materializeRoutes(p, profile([GW, JEV])))
    expect(pinned.model.route.decision).toBe('jev')
    expect(pinned.model.id.decision).toBe('jev-1.13.0')
  })
})

// Decision routing reads preset.model.route.decision / RouteTable.decision directly and never
// borrows the chat default-route fallback, so a deployment that configured no decision route
// anywhere gets no decision key at all - never a silent 'default' route - and a decide call against
// a route the sealed decision registry never served fails as unavailable, never resolving to a chat
// model instead.
describe('a decision key absent from every configuration never falls back to a default route', () => {
  it('materializeRoutes/pinPresetRoutes carry no decision key when neither profile nor preset name one', () => {
    const p = preset({ primary: 'gw' })
    const table = materializeRoutes(p, profile([GW]))
    expect(table.decision).toBeUndefined()
    const pinned = pinPresetRoutes(p, table)
    expect(pinned.model.route.decision).toBeUndefined()
    expect(pinned.model.id.decision).toBeUndefined()
  })
})

describe('verifyRoutes checks each key against the registry of its own kind', () => {
  const chat = {
    routes: () => [{ route: 'gw' }],
    models: (): ModelRecord[] => [fakeModel({ id: 'm', route: 'gw' })],
  }
  const fake = new FakeDecisionAdapter({ route: 'jev', model: 'jev-1.13.0', steps: [] })
  const decisions = buildDecisionRegistry(
    [fake],
    [{ ...JEV, api: 'fake-decision', models: fake.models('jev').slice() }],
  )
  const table = { primary: { route: 'gw', model: 'm' }, decision: { route: 'jev', model: 'jev-1.13.0' } }

  it('accepts a table both registries serve', () => {
    expect(() => verifyRoutes(table, chat, decisions)).not.toThrow()
  })
  it('refuses a decision key when no decision registry was sealed', () => {
    expect(refusal(() => verifyRoutes(table, chat)).detail.reason).toBe('route-unserved')
  })
  it('refuses a decision model the decision registry does not offer', () => {
    const r = refusal(() =>
      verifyRoutes({ ...table, decision: { route: 'jev', model: 'jev-9' } }, chat, decisions),
    )
    expect(r.detail.reason).toBe('model-unserved')
  })
  it('refuses a chat key pointed at the decision route', () => {
    const r = refusal(() => verifyRoutes({ primary: { route: 'jev', model: 'jev-1.13.0' } }, chat, decisions))
    expect(r.detail.reason).toBe('route-unserved')
  })
})

describe('presets may pin the decision slot', () => {
  it('accepts model.id.decision and still refuses an unknown slot', () => {
    const ok = {
      name: 'p',
      model: { route: { primary: 'gw', decision: 'jev' }, id: { decision: 'jev-1.13.0' } },
    }
    expect(() => validatedPresetViewInput(ok as unknown as PresetDoc)).not.toThrow()
    const bad = { name: 'p', model: { route: { primary: 'gw' }, id: { planner: 'x' } } }
    expect(() => validatedPresetViewInput(bad as unknown as PresetDoc)).toThrow(/E_PRESET_UNSUPPORTED/)
  })
})

describe('buildProvider splits the declared routes by kind', () => {
  async function resolved(routes: RouteDecl[]): Promise<ResolvedProfile> {
    return resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: Object.fromEntries(
            ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
              id,
              { version: '0.1.0', integrity: 'sha512-x', trust: 'builtin' as const, enabled: true },
            ]),
          ),
        },
        user: { name: 'local-dev', provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes } },
      },
      {
        platform: { os: 'linux', arch: 'x64', capabilities: {} },
        agnesVersion: '0.1.0',
        now: '2026-09-26T00:00:00Z',
      },
    )
  }
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  const secrets = (ref: string) => {
    if (ref === 'secret://typesafe/default') return 'ts-test-key'
    throw new Error(`no secret ${ref}`)
  }
  const routes = { primary: { route: 'gw', model: 'm' }, decision: { route: 'jev', model: 'jev-1.13.0' } }

  it('fits the Jev adapter behind a decision registry the chat side cannot see', async () => {
    const { provider } = await buildProvider(await resolved([GW, JEV]), routes, {
      secrets,
      clock: () => 0,
      log,
    })
    expect(typeof provider.decide).toBe('function')
    expect(provider.registry?.models().map((m) => m.route)).not.toContain('jev')
    expect(provider.models().map((m) => m.route)).not.toContain('jev')
    expect((provider as { decisionRegistry?: { models(): unknown[] } }).decisionRegistry?.models()).toEqual([
      jevModel,
    ])
    expect(provider.decisionModels?.()).toEqual([jevModel])
  })

  it.each([
    ['a decision api route with a chat record', { ...JEV, models: [fakeModel({ id: 'x', route: 'jev' })] }],
    ['a decision api route with no records', { ...JEV, models: [] }],
    ['a chat api route with a decision record', { ...GW, models: [{ ...jevModel, route: 'gw' }] }],
  ])('refuses %s', async (_name, bad) => {
    const others = bad.route === 'gw' ? [JEV] : [GW]
    await expect(
      buildProvider(await resolved([bad as RouteDecl, ...others]), routes, { secrets, clock: () => 0, log }),
    ).rejects.toMatchObject({ code: 'E_PRESET_UNRESOLVED', detail: { reason: 'route-kind-mismatch' } })
  })

  it('without a decision route fits no decide at all', async () => {
    const { provider } = await buildProvider(
      await resolved([GW]),
      { primary: routes.primary },
      { secrets, clock: () => 0, log },
    )
    expect(provider.decide).toBeUndefined()
  })

  it('a decide call against a route the sealed decision registry never served is unavailable, never a chat model', async () => {
    // The deployment declares Jev (so decide is wired), but this session's table names no decision
    // key at all - the same shape materializeRoutes produces when nothing configured one.
    const routesNoDecision = { primary: routes.primary }
    const { provider } = await buildProvider(await resolved([GW, JEV]), routesNoDecision, {
      secrets,
      clock: () => 0,
      log,
    })
    const failure = provider.decide?.(
      {
        slot: 'decision',
        route: 'not-a-configured-route',
        model: 'whatever',
        state: null,
        questions: { done: { type: 'noul', instructions: 'done?' } },
        timeoutMs: 500,
      },
      { signal: new AbortController().signal },
    )
    await expect(failure).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(failure).rejects.not.toMatchObject({ route: 'gw' })
  })
})
