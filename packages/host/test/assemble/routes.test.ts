import { PiAdapter } from '@agnes/ai'
import { fakeModel, fakeRequest } from '@agnes/ai/testkit'
import { type PresetView, presetDefaults } from '@agnes/core'
import type { ModelRecord, RouteTable } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  BEDROCK_API,
  materializeRoutes,
  pinPresetRoutes,
  sweepAwsDestination,
  verifyRoutes,
} from '../../src/assemble/routes.js'
import type { ResolvedProfile, RouteDecl } from '../../src/profile/types.js'

const model = (id: string, route: string, slot?: ModelRecord['slot']): ModelRecord => ({
  id,
  name: id,
  api: 'openai',
  route,
  baseUrl: 'https://gw.example/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...(slot ? { slot } : {}),
})

// A ResolvedProfile with only the fields these functions read. Built by narrowing the real type
// rather than casting a literal to it, so a field one of them starts reading cannot go unnoticed.
type RoutingProfile = Pick<ResolvedProfile, 'name' | 'provider'>
const profile = (routes: RouteDecl[]): ResolvedProfile => {
  const p: RoutingProfile = {
    name: 'p',
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes },
  }
  return p as ResolvedProfile
}
const withRoute = (over: Partial<PresetView['model']>): PresetView => {
  const d = presetDefaults()
  return { ...d, model: { ...d.model, ...over } }
}
// A bedrock route as one can actually be declared: the api the wire layer registers, not the vendor
// name. Shared by the sweep tests so the api string is stated once.
const bedrockRoute = (route: string, region: string): RouteDecl => ({
  route,
  api: BEDROCK_API,
  baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
  compat: { region },
  models: [],
})
const refusal = (fn: () => unknown): { code: string; detail: Record<string, unknown> } => {
  try {
    fn()
  } catch (e) {
    return e as unknown as { code: string; detail: Record<string, unknown> }
  }
  throw new Error('expected a refusal')
}

describe('materializeRoutes', () => {
  it('substitutes the default sentinel with the first declared route and its slot model', () => {
    // m-main is first in the catalogue and carries no slot, so it is what an unslotted request gets;
    // m-fast declares slot 'fast', so the fast slot prefers it over catalogue order.
    const p = profile([
      {
        route: 'gw',
        api: 'openai',
        baseUrl: 'https://gw.example/v1',
        models: [model('m-main', 'gw'), model('m-fast', 'gw', 'fast')],
      },
    ])
    const preset = withRoute({ route: { primary: 'default', fast: 'default' } })
    expect(materializeRoutes(preset, p)).toEqual({
      primary: { route: 'gw', model: 'm-main' },
      fast: { route: 'gw', model: 'm-fast' },
    })
  })
  it('resolves a named route and keeps it', () => {
    const p = profile([
      { route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [model('m1', 'gw')] },
      { route: 'alt', api: 'openai', baseUrl: 'https://b/', models: [model('m2', 'alt')] },
    ])
    expect(materializeRoutes(withRoute({ route: { primary: 'alt' } }), p).primary).toEqual({
      route: 'alt',
      model: 'm2',
    })
  })
  it('the sentinel takes the first declared route, not the alphabetically first', () => {
    const p = profile([
      { route: 'zz', api: 'openai', baseUrl: 'https://a/', models: [model('mz', 'zz')] },
      { route: 'aa', api: 'openai', baseUrl: 'https://b/', models: [model('ma', 'aa')] },
    ])
    expect(materializeRoutes(withRoute({ route: { primary: 'default' } }), p).primary.route).toBe('zz')
  })

  // Ruling C-26: preset.model.id was validated by nothing, and core hands a pin straight to the
  // wire without ever asking whether the route offers it.
  it('honours a declared model pin and refuses one the route does not offer', () => {
    const p = profile([
      {
        route: 'gw',
        api: 'openai',
        baseUrl: 'https://a/',
        models: [model('m1', 'gw'), model('m2', 'gw')],
      },
    ])
    const pinned = withRoute({ route: { primary: 'default' }, id: { primary: 'm2' } })
    expect(materializeRoutes(pinned, p).primary).toEqual({ route: 'gw', model: 'm2' })
    const bogus = withRoute({ route: { primary: 'default' }, id: { primary: 'ghost' } })
    expect(refusal(() => materializeRoutes(bogus, p)).detail.reason).toBe('model-undeclared')
  })
  it('refuses a pin for a slot with no route beside it', () => {
    const p = profile([{ route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [model('m1', 'gw')] }])
    const stray = withRoute({ route: { primary: 'default' }, id: { fast: 'm1' } })
    expect(refusal(() => materializeRoutes(stray, p)).detail.reason).toBe('pin-without-route')
  })

  // Five ways the sentinel can fail to resolve. Every one of them refuses at assembly, loudly, and
  // the assertion is on which check fired, not merely that something did.
  it.each([
    ['no route is declared at all', [], presetDefaults(), 'no-routes'],
    [
      'a preset route name the profile does not declare',
      [{ route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [model('m1', 'gw')] }],
      withRoute({ route: { primary: 'nope' } }),
      'unknown-route',
    ],
    [
      'a declared route with an empty catalogue',
      [{ route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [] }],
      presetDefaults(),
      'no-models',
    ],
    [
      'a slot that is not a protocol SlotName',
      [{ route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [model('m1', 'gw')] }],
      withRoute({ route: { primary: 'default', sideways: 'default' } }),
      'unknown-slot',
    ],
    [
      'a preset with no primary slot',
      [{ route: 'gw', api: 'openai', baseUrl: 'https://a/', models: [model('m1', 'gw')] }],
      withRoute({ route: { fast: 'default' } }),
      'no-primary',
    ],
  ] as Array<[string, RouteDecl[], PresetView, string]>)('refuses %s', (_why, routes, preset, reason) => {
    const e = refusal(() => materializeRoutes(preset, profile(routes)))
    expect(e.code).toBe('E_PRESET_UNRESOLVED')
    expect(e.detail.reason).toBe(reason)
  })
})

describe('pinPresetRoutes', () => {
  it('replaces the sentinel in the view with the resolved route and model', () => {
    const routes: RouteTable = { primary: { route: 'gw', model: 'm1' }, fast: { route: 'alt', model: 'm2' } }
    const v = pinPresetRoutes(withRoute({ route: { primary: 'default', fast: 'default' } }), routes)
    expect(v.model.route).toEqual({ primary: 'gw', fast: 'alt' })
    expect(v.model.id).toEqual({ primary: 'm1', fast: 'm2' })
  })
  // core's resolveModel is `route[slot] ?? 'default'` and `model: pinned ?? catalogue ?? route`. The
  // pin is what keeps both halves off the sentinel, so it is asserted against that reading and not
  // against a description of it.
  it('leaves core no path back to the sentinel or to the route-name fallback', () => {
    const v = pinPresetRoutes(withRoute({ route: { primary: 'default' } }), {
      primary: { route: 'gw', model: 'm1' },
    })
    const route = v.model.route.primary ?? 'default'
    expect(route).toBe('gw')
    expect(v.model.id.primary ?? route).toBe('m1')
  })
})

describe('verifyRoutes', () => {
  const registry = {
    routes: () => [{ route: 'gw' }],
    models: () => [model('m1', 'gw')],
  }
  it('accepts a table the sealed registry serves', () => {
    expect(() => verifyRoutes({ primary: { route: 'gw', model: 'm1' } }, registry)).not.toThrow()
  })
  it('refuses a route the sealed registry does not serve', () => {
    const e = refusal(() => verifyRoutes({ primary: { route: 'ghost', model: 'm1' } }, registry))
    expect(e.detail.reason).toBe('route-unserved')
  })
  it('refuses a model the sealed registry does not offer on that route', () => {
    const e = refusal(() => verifyRoutes({ primary: { route: 'gw', model: 'ghost' } }, registry))
    expect(e.detail.reason).toBe('model-unserved')
  })
  // ai matches a record on its own `route` field, so a model filed under another route is present in
  // the catalogue and unreachable through this one. Pairing route with id is what catches that.
  it('refuses a model that exists only under a different route', () => {
    const two = { routes: () => [{ route: 'gw' }, { route: 'alt' }], models: () => [model('m2', 'alt')] }
    expect(refusal(() => verifyRoutes({ primary: { route: 'gw', model: 'm2' } }, two)).detail.reason).toBe(
      'model-unserved',
    )
  })
  it('checks every slot, not only primary', () => {
    const table: RouteTable = { primary: { route: 'gw', model: 'm1' }, fast: { route: 'ghost', model: 'm1' } }
    expect(refusal(() => verifyRoutes(table, registry)).detail.slot).toBe('fast')
  })
})

describe('sweepAwsDestination', () => {
  it('removes every environment variable that can move a bedrock request, and pins the ignore flag', () => {
    const env: NodeJS.ProcessEnv = {
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_PROFILE: 'dev',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://attacker.example',
      AWS_ENDPOINT_URL: 'https://attacker.example',
      AWS_CONFIG_FILE: '/tmp/cfg',
      AWS_SHARED_CREDENTIALS_FILE: '/tmp/creds',
      AWS_USE_FIPS_ENDPOINT: 'true',
      AWS_USE_DUALSTACK_ENDPOINT: 'true',
      PATH: '/bin',
    }
    const r = sweepAwsDestination(env, profile([]))
    expect(r.removed.sort()).toEqual([
      'AWS_CONFIG_FILE',
      'AWS_DEFAULT_REGION',
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_USE_DUALSTACK_ENDPOINT',
      'AWS_USE_FIPS_ENDPOINT',
    ])
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe('true')
    expect(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
  it('re-exports the region a declared bedrock route asks for, and nothing else', () => {
    const env: NodeJS.ProcessEnv = { AWS_REGION: 'eu-west-1' }
    expect(sweepAwsDestination(env, profile([bedrockRoute('bedrock', 'us-east-1')])).set).toEqual({
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      AWS_REGION: 'us-east-1',
    })
    expect(env.AWS_REGION).toBe('us-east-1')
  })
  it('does not re-export a region for a non-bedrock route that happens to declare one', () => {
    const p = profile([
      {
        route: 'gw',
        api: 'openai-completions',
        baseUrl: 'https://a/',
        compat: { region: 'us-east-1' },
        models: [],
      },
    ])
    expect(sweepAwsDestination({ AWS_REGION: 'eu-west-1' }, p).set.AWS_REGION).toBeUndefined()
  })
  it('refuses two bedrock routes that disagree on the region', () => {
    const p = profile([bedrockRoute('b1', 'us-east-1'), bedrockRoute('b2', 'eu-west-1')])
    const e = refusal(() => sweepAwsDestination({}, p))
    expect(e.code).toBe('E_PRESET_UNRESOLVED')
    expect(e.detail.reason).toBe('bedrock-region-conflict')
  })
  // The two assertions above are only worth anything if BEDROCK_API is a route that can exist. The
  // previous pair used `api: 'bedrock'`, which no deployment can declare - the sweep matched it, the
  // tests passed, and every real bedrock route lost its region. So the api name the sweep matches on
  // is driven through the adapter here, from both sides: the name the tests use is the one the
  // adapter recognises as AWS-authenticating, and the short name cannot reach a wire at all.
  it('the api name the sweep matches is one the adapter will stream, and the short name is not', async () => {
    const keyless = (api: string) => ({
      route: 'b',
      api,
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      keyless: true,
      models: [
        fakeModel({ id: 'm', route: 'b', api, baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' }),
      ],
    })
    const opts = {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'k',
      timeoutMs: { firstToken: 1000, total: 5000 },
    }
    const run = async (api: string): Promise<string[]> => {
      const a = new PiAdapter({ manualRoutes: [keyless(api)] })
      const out: string[] = []
      for await (const e of a.stream('b', fakeRequest({ route: 'b', model: 'm' }), opts))
        out.push(e.type === 'error' ? `${e.code}: ${e.message}` : e.type)
      return out
    }
    // BEDROCK_API is refused before the wire because the adapter knows it authenticates from the AWS
    // environment - which is the whole reason this sweep exists.
    expect((await run(BEDROCK_API)).join('')).toContain('authenticates from the host environment')
    // The short name is not refused that way, and dies at the wire instead: nothing streams under it.
    await expect(run('bedrock')).rejects.toThrow(/No API provider registered for api: bedrock$/)
  })
  it('is idempotent: a second sweep of the same environment removes nothing new', () => {
    const env: NodeJS.ProcessEnv = { AWS_REGION: 'us-east-1' }
    expect(sweepAwsDestination(env, profile([])).removed).toEqual(['AWS_REGION'])
    expect(sweepAwsDestination(env, profile([])).removed).toEqual([])
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe('true')
  })
})
