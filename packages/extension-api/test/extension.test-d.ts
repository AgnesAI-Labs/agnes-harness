import type { JsonValue } from '@agnes/protocol'
import { describe, expectTypeOf, it } from 'vitest'
import type { ExtensionAPI, ExtensionFactory } from '../src/host.js'
import type { ExtensionContext, PlatformFacts } from '../src/index.js'

type RootHookEvent = import('../src/index.js').HookEvent

describe('ExtensionAPI backend surface', () => {
  it('is exported from the host subpath only, never from the author root', () => {
    // @ts-expect-error The author root exports the ctx facets, not the backend port behind them.
    type LeakedPort = import('../src/index.js').ExtensionAPI
    // @ts-expect-error The mount factory over that port is Host-internal too.
    type LeakedFactory = import('../src/index.js').ExtensionFactory
    expectTypeOf<[LeakedPort, LeakedFactory]>().toBeArray()
  })
  it('registerHook is constrained by the HookEvent on the root surface', () => {
    expectTypeOf<Parameters<ExtensionAPI['registerHook']>[0]>().toEqualTypeOf<RootHookEvent>()
  })
  it('has six register methods plus providers, events, ctx and the legacy optional reader', () => {
    expectTypeOf<keyof ExtensionAPI>().toEqualTypeOf<
      | 'registerService'
      | 'registerProjection'
      | 'registerTool'
      | 'registerHook'
      | 'registerSlot'
      | 'registerResource'
      | 'providers'
      | 'events'
      | 'ctx'
    >()
  })
  it('has no seam registration', () => {
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerSeam' as never)
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerProvider' as never)
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerOperation' as never)
  })
  it('ctx exposes only id / version / trust / lease / log / signal / info / platform', () => {
    expectTypeOf<keyof ExtensionContext>().toEqualTypeOf<
      'extId' | 'version' | 'trust' | 'lease' | 'log' | 'signal' | 'info' | 'platform'
    >()
    expectTypeOf<ExtensionContext['trust']>().toEqualTypeOf<'builtin' | 'trusted'>()
    // Factory time is load time: facts only, no capability probe (spec P2).
    expectTypeOf<ExtensionContext['platform']>().toEqualTypeOf<PlatformFacts>()
  })
  it('info adds preset and cwd as strings alongside the existing version fields', () => {
    expectTypeOf<keyof ExtensionContext['info']>().toEqualTypeOf<
      'agnesVersion' | 'apiVersion' | 'profileName' | 'preset' | 'cwd'
    >()
    expectTypeOf<ExtensionContext['info']['preset']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ExtensionContext['info']['cwd']>().toEqualTypeOf<string | undefined>()
    // Optional today (see src/extension.ts comment): three host/test construction sites don't
    // populate them yet, and this task doesn't touch host. Both forms type-check.
    const withBoth: ExtensionContext['info'] = {
      agnesVersion: 'fixture',
      apiVersion: 'fixture',
      profileName: 'fixture',
      preset: 'fixture',
      cwd: '/fixture',
    }
    const withoutEither: ExtensionContext['info'] = {
      agnesVersion: 'fixture',
      apiVersion: 'fixture',
      profileName: 'fixture',
    }
    void [withBoth, withoutEither]
  })
  it('a factory returning nothing, a Disposer, or a promise of either all type-check', () => {
    const nothing: ExtensionFactory = () => {}
    const disposer: ExtensionFactory = () => () => {}
    const asyncNothing: ExtensionFactory = async () => {}
    const asyncDisposer: ExtensionFactory = async () => () => {}
    void [nothing, disposer, asyncNothing, asyncDisposer]
  })
})

describe('plugin context facets', () => {
  it('lists every facet a plugin can inject', () => {
    expectTypeOf<keyof import('../src/index.js').PluginContextFacets>().toEqualTypeOf<
      | 'tools'
      | 'hooks'
      | 'projections'
      | 'services'
      | 'slots'
      | 'resources'
      | 'eventLog'
      | 'providers'
      | 'self'
      | 'profileRuntime'
    >()
  })
})
