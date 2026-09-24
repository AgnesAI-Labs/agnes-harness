import { PRESET_NAMES } from '@agnes/code'
import { describe, expect, it } from 'vitest'
import {
  assertNoReservedRouteName,
  BUILTIN_PACKAGES,
  checkTemplateShape,
  loadTemplate,
  RESERVED_ROUTE_NAMES,
  TEMPLATE_NAMES,
} from '../../src/profile/templates.js'

describe('templates', () => {
  it('loads the v0.1 templates and each passes the shape check', () => {
    expect(TEMPLATE_NAMES).toEqual(['local-dev', 'enterprise'])
    for (const n of TEMPLATE_NAMES) expect(loadTemplate(n).name).toBe(n)
  })
  it('local-dev names all ten seams, lists the provider package, and defaults to standard', () => {
    const t = loadTemplate('local-dev')
    expect(Object.keys(t.seams ?? {}).sort()).toEqual([
      'approval',
      'artifacts',
      'checkpoint',
      'harness',
      'ledger',
      'platform',
      'principals',
      'repair',
      'sandbox',
      'verifier',
    ])
    expect(t.packages?.map((p) => p.id)).toEqual(['@agnes/ai', '@agnes/base', '@agnes/code'])
    expect(t.presets).toEqual({ default: 'standard', allowed: ['standard'] })
    expect(t.computerUse).toMatchObject({ enabled: true, appAccess: 'all' })
  })
  it('enterprise routes principals at the governance package and demands a sandbox', () => {
    const t = loadTemplate('enterprise')
    expect(t.seams?.principals).toBe('@agnes/enterprise')
    expect(t.limits?.['sandbox.required']).toBe(1)
    expect(t.transports).toEqual([{ kind: 'unix' }])
    expect(t.computerUse).toMatchObject({ enabled: false, appAccess: 'allowlist' })
  })
  it('rejects unknown template with E_DEP_MISSING', () => {
    expect(() => loadTemplate('nope')).toThrow(/E_DEP_MISSING/)
  })
  it('builtin package list is stable', () => {
    expect(BUILTIN_PACKAGES).toContain('@agnes/base')
  })
})

// A template is a release artefact, so a malformed one is a build error. Each case names the one
// rule it breaks, so a rejection cannot be credited to the wrong check.
describe('checkTemplateShape says which rule fired', () => {
  const ok = () => ({
    name: 't',
    schemaVersion: 1,
    seams: {
      approval: '@a',
      checkpoint: '@a',
      ledger: '@a',
      sandbox: '@a',
      verifier: '@a',
      repair: '@a',
      artifacts: '@a',
      principals: '@a',
      platform: '@a',
      harness: '@a',
    },
    provider: { package: '@agnes/ai' },
    presets: { default: 'standard', allowed: ['standard'] },
    computerUse: {
      enabled: false,
      appAccess: 'allowlist',
      appAllowlist: [],
      capture: {},
      retention: {},
    },
  })
  it('accepts a well-formed document', () => {
    expect(() => {
      checkTemplateShape(ok(), 't')
    }).not.toThrow()
  })
  it.each([
    ['not an object', 42, /not an object/],
    ['an array', [], /not an object/],
    ['unknown top-level key', { ...ok(), runtime: 'x' }, /unknown top-level key runtime/],
    ['name disagreeing with the file', { ...ok(), name: 'other' }, /name must equal the file name/],
    ['a schemaVersion that is not 1', { ...ok(), schemaVersion: 2 }, /schemaVersion must be 1/],
    [
      'a missing seam',
      { ...ok(), seams: { ...ok().seams, harness: undefined } },
      /seams\.harness must name a package/,
    ],
    ['no provider package', { ...ok(), provider: {} }, /provider\.package is required/],
    ['no presets block', { ...ok(), presets: undefined }, /presets\.default and presets\.allowed/],
    [
      'a default outside allowed',
      { ...ok(), presets: { default: 'claw', allowed: ['standard'] } },
      /presets\.default must be in presets\.allowed/,
    ],
  ])('rejects %s', (_label, doc, why) => {
    expect(() => {
      checkTemplateShape(doc, 't')
    }).toThrow(why)
  })
})

// The derivation guard for presets.allowed. src/ may not import a Package, so the constraint lives
// here, where @agnes/code is a devDependency: every name a template admits must be a recipe some
// package actually ships. When code grows a recipe the template may list it; until then it may not.
describe('presets.allowed is derived from the recipes that exist', () => {
  it.each([...TEMPLATE_NAMES])('%s admits only names in PRESET_NAMES', (n) => {
    const allowed = loadTemplate(n).presets?.allowed ?? []
    expect(allowed.length).toBeGreaterThan(0)
    for (const name of allowed) expect(PRESET_NAMES as readonly string[]).toContain(name)
  })
  it('the default preset is itself admitted', () => {
    for (const n of TEMPLATE_NAMES) {
      const p = loadTemplate(n).presets
      expect(p?.allowed).toContain(p?.default)
    }
  })
})

describe('reserved route names', () => {
  it('refuses a declared route literally named default', () => {
    expect(RESERVED_ROUTE_NAMES).toEqual(['default'])
    expect(() =>
      assertNoReservedRouteName([{ route: 'default', api: 'openai', baseUrl: 'https://x/' }], 'user'),
    ).toThrow(/E_PRESET_UNRESOLVED/)
    expect(() =>
      assertNoReservedRouteName([{ route: 'gateway', api: 'openai', baseUrl: 'https://x/' }], 'user'),
    ).not.toThrow()
  })
  it('names the offending route and the layer it came from', () => {
    try {
      assertNoReservedRouteName([{ route: 'default', api: 'openai', baseUrl: 'https://x/' }], 'flags')
      expect.unreachable('should have refused')
    } catch (e) {
      const err = e as { code?: string; detail?: Record<string, unknown>; source?: { layer?: string } }
      expect(err.code).toBe('E_PRESET_UNRESOLVED')
      expect(err.detail).toEqual({ route: 'default', reason: 'reserved-route-name' })
      expect(err.source?.layer).toBe('flags')
    }
  })
  it('passes an empty or absent route list', () => {
    expect(() => {
      assertNoReservedRouteName(undefined, 'builtin')
    }).not.toThrow()
    expect(() => {
      assertNoReservedRouteName([], 'builtin')
    }).not.toThrow()
  })
})
