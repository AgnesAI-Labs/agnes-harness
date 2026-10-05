import { fakeModel } from '@agnes/ai/testkit'
import type { SlotName } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  checkModelSwitch,
  LOOP_MODEL_SLOT,
  resolveSessionModelSelection,
  resolveThinkingOnSwitch,
  sessionParameterGuard,
  supportsThinking,
  thinkingForRequest,
} from '../../src/runtime/model/model-selection.js'
import {
  catalogOf,
  frameOf,
  MODEL_A,
  MODEL_B,
  NEEDS,
  PAIR_A,
  PAIR_B,
  referenceOf,
  revision,
  routesFor,
} from './model-selection-fixture.js'

const both = () => catalogOf(MODEL_A, MODEL_B)
function resolve(
  rev = revision(1, { primary: PAIR_A }),
  over: Partial<Parameters<typeof resolveSessionModelSelection>[0]> = {},
) {
  return resolveSessionModelSelection({
    revision: rev,
    slot: 'primary',
    catalog: both(),
    routes: routesFor(),
    needs: NEEDS,
    ...over,
  })
}
const failure = (out: ReturnType<typeof resolve>) =>
  out.ok ? null : `${out.error.code}/${out.error.detailCode}`

describe('resolveSessionModelSelection', () => {
  it('uses the loop slot and names it primary', () => {
    expect(LOOP_MODEL_SLOT).toBe('primary')
  })

  it('takes the slot pair from the revision and builds the snapshot from the same capture', () => {
    const out = resolve()
    if (!out.ok) throw new Error(out.error.detailCode)
    expect(out.value).toMatchObject({ slot: 'primary', route: 'route-1', model: 'model-a', thinking: null })
    expect(out.value.snapshot).toMatchObject({ routeId: 'route-1', model: 'model-a', catalogRevision: 7 })
    expect(out.value.catalogDigest).toBe(both().digest)
  })

  it('follows the revision: a later revision selects the other model', () => {
    const out = resolve(revision(2, { primary: PAIR_B }))
    expect(out.ok && out.value.model).toBe('model-b')
  })

  it('reads the asked slot, not the first one', () => {
    const rev = revision(1, { primary: PAIR_A, fast: PAIR_B })
    const out = resolve(rev, { slot: 'fast' as SlotName })
    expect(out.ok && out.value.model).toBe('model-b')
  })

  it('refuses a slot the revision has no route for', () => {
    expect(failure(resolve(revision(1, { primary: PAIR_A }), { slot: 'fast' as SlotName }))).toBe(
      'incompatible/model_selection_slot',
    )
  })

  it('refuses parameters that are not the default session parameters', () => {
    const rev = revision(1, { primary: PAIR_A })
    const broken = { ...rev, parameters: { ...rev.parameters, value: { model: { route: {} } } } }
    expect(failure(resolve(broken))).toBe('incompatible/model_selection_parameters')
  })

  it('refuses a route the deployment no longer declares', () => {
    expect(failure(resolve(undefined, { routes: routesFor([]) }))).toBe('denied/model_selection_route')
  })

  it('refuses a model the catalog no longer has, and never falls back to a fallback or another route', () => {
    const rev = revision(1, {
      primary: { route: 'route-1', model: 'gone', fallbacks: [PAIR_A] },
    })
    expect(failure(resolve(rev))).toBe('denied/model_selection_route')
  })

  it('refuses when the route snapshot cannot be built or names something else', () => {
    const none = { declared: () => true, snapshot: () => undefined }
    expect(failure(resolve(undefined, { routes: none }))).toBe('internal/model_selection_not_ready')
    const other = {
      declared: () => true,
      snapshot: (pick: Parameters<ReturnType<typeof routesFor>['snapshot']>[0]) => ({
        ...routesFor().snapshot(pick),
        routeId: 'elsewhere',
      }),
    }
    expect(failure(resolve(undefined, { routes: other as unknown as ReturnType<typeof routesFor> }))).toBe(
      'internal/model_selection_not_ready',
    )
  })

  it('refuses a target whose features fall short of what the loop needs', () => {
    expect(failure(resolve(undefined, { routes: routesFor(['route-1'], { tools: false }) }))).toBe(
      'incompatible/model_selection_features',
    )
  })

  it('resolves the revision thinking level against the target at prepare time', () => {
    expect(resolve(revision(1, { primary: PAIR_A }, { primary: 'high' }))).toMatchObject({
      ok: true,
      value: { thinking: 'high' },
    })
    expect(failure(resolve(revision(1, { primary: PAIR_A }, { primary: 'max' })))).toBe(
      'incompatible/model_selection_thinking',
    )
    expect(failure(resolve(revision(1, { primary: PAIR_B }, { primary: 'high' })))).toBe(
      'incompatible/model_selection_thinking',
    )
  })
})

describe('thinking rules', () => {
  const reasoning = fakeModel({
    id: 'r',
    route: 'route-1',
    reasoning: true,
    thinkingLevelMap: { high: 'high', low: 'low' },
    defaultSettings: { thinking: 'low' },
  })
  const plain = fakeModel({ id: 'p', route: 'route-1' })

  it('supports a level only on a reasoning model that lists it', () => {
    expect(supportsThinking(reasoning, 'high')).toBe(true)
    expect(supportsThinking(reasoning, 'max')).toBe(false)
    expect(supportsThinking(plain, 'high')).toBe(false)
    expect(supportsThinking(fakeModel({ id: 'u', route: 'route-1', reasoning: true }), 'max')).toBe(true)
  })

  it('at prepare time an absent level means unspecified and an unsupported one is refused', () => {
    expect(thinkingForRequest(undefined, plain)).toEqual({ ok: true, value: null })
    expect(thinkingForRequest('high', reasoning)).toEqual({ ok: true, value: 'high' })
    const refused = thinkingForRequest('high', plain)
    expect(refused.ok ? null : refused.error.detailCode).toBe('model_selection_thinking')
  })

  // Each row follows the earlier in-process switch rule: an explicit level must be supported; an
  // unspecified one carries the old level when the target supports it, else is empty for the same
  // model and the target's default for another.
  const rows = [
    {
      name: 'explicit supported level',
      prior: undefined,
      same: false,
      req: 'high',
      rec: reasoning,
      want: 'high',
    },
    {
      name: 'explicit level missing from the map',
      prior: undefined,
      same: false,
      req: 'max',
      rec: reasoning,
      want: 'refuse',
    },
    {
      name: 'explicit level on a non-reasoning model',
      prior: undefined,
      same: false,
      req: 'high',
      rec: plain,
      want: 'refuse',
    },
    {
      name: 'unspecified carries a supported prior level',
      prior: 'high',
      same: false,
      req: null,
      rec: reasoning,
      want: 'high',
    },
    {
      name: 'unspecified, prior unsupported, another model without default',
      prior: 'high',
      same: false,
      req: null,
      rec: plain,
      want: undefined,
    },
    {
      name: 'unspecified, prior unsupported, same model',
      prior: 'high',
      same: true,
      req: null,
      rec: plain,
      want: undefined,
    },
    {
      name: 'unspecified, no prior, another model takes its default',
      prior: undefined,
      same: false,
      req: null,
      rec: reasoning,
      want: 'low',
    },
    {
      name: 'unspecified, prior not in the map, another model takes its default',
      prior: 'medium',
      same: false,
      req: null,
      rec: reasoning,
      want: 'low',
    },
    {
      name: 'unspecified, no prior, same model stays empty',
      prior: undefined,
      same: true,
      req: null,
      rec: reasoning,
      want: undefined,
    },
  ] as const
  for (const row of rows)
    it(`on switch: ${row.name}`, () => {
      const out = resolveThinkingOnSwitch({
        prior: row.prior,
        sameModel: row.same,
        requested: row.req,
        record: row.rec,
      })
      if (row.want === 'refuse') expect(out.ok ? null : out.error.detailCode).toBe('model_selection_thinking')
      else expect(out).toEqual({ ok: true, value: row.want })
    })
})

describe('checkModelSwitch', () => {
  const credentials = { bound: () => true }
  const request = { slot: 'primary' as SlotName, route: 'route-1', model: 'model-a', thinking: null }
  const base = { request, prior: undefined, catalog: both(), routes: routesFor(), needs: NEEDS, credentials }

  it('accepts a declared pair and returns the thinking value to store with its snapshot', () => {
    const out = checkModelSwitch(base)
    if (!out.ok) throw new Error(out.error.detailCode)
    expect(out.value.snapshot.model).toBe('model-a')
    expect(out.value.thinking).toBe('low')
  })

  it('refuses a route outside the deployment table and a pair outside the catalog', () => {
    expect(checkModelSwitch({ ...base, routes: routesFor([]) })).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'model_selection_route' },
    })
    expect(checkModelSwitch({ ...base, request: { ...request, model: 'gone' } })).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'model_selection_route' },
    })
  })

  it('refuses an unsupported thinking level and a target without the needed features', () => {
    expect(
      checkModelSwitch({ ...base, request: { ...request, model: 'model-b', thinking: 'high' } }),
    ).toMatchObject({
      ok: false,
      error: { detailCode: 'model_selection_thinking' },
    })
    expect(checkModelSwitch({ ...base, routes: routesFor(['route-1'], { tools: false }) })).toMatchObject({
      ok: false,
      error: { detailCode: 'model_selection_features' },
    })
  })

  it('refuses a route whose credential binding does not exist', () => {
    const binding = {
      consumer: 'model' as const,
      secretId: 'secret',
      accountRef: null,
      serverRef: 'endpoint',
      audience: 'endpoint',
      purpose: 'model-inference',
    }
    const routes = routesFor(['route-1'], {}, binding)
    expect(checkModelSwitch({ ...base, routes, credentials: { bound: () => false } })).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'model_selection_credential' },
    })
    expect(checkModelSwitch({ ...base, routes, credentials: { bound: () => true } }).ok).toBe(true)
  })

  it('treats the same route and model as the same model when inheriting thinking', () => {
    const out = checkModelSwitch({
      ...base,
      prior: { route: 'route-1', model: 'model-b', thinking: 'high' },
      request: { ...request, model: 'model-b' },
    })
    expect(out).toEqual(expect.objectContaining({ ok: true }))
    expect(out.ok && out.value.thinking).toBeUndefined()
  })
})

describe('sessionParameterGuard', () => {
  it('guards exactly the record revision the frame was built from and reads that reference', () => {
    const rev = revision(3, { primary: PAIR_A })
    const { readGuard, domainRead } = sessionParameterGuard(frameOf(rev))
    expect(readGuard).toEqual({ recordId: 'session-parameters', expectedRecordRevision: 4 })
    expect(domainRead).toEqual(referenceOf(rev))
  })
})
