import type { JsonValue } from '@agnes/protocol'
import { describe, expectTypeOf, it } from 'vitest'
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, PlatformFacts } from '../src/index.js'
import { defineExtension } from '../src/index.js'

type RootHookEvent = import('../src/index.js').HookEvent

describe('ExtensionAPI surface', () => {
  it('registerHook is constrained by the HookEvent on the root surface', () => {
    expectTypeOf<Parameters<ExtensionAPI['registerHook']>[0]>().toEqualTypeOf<RootHookEvent>()
  })
  it('has six register methods plus events, ctx and the legacy optional reader', () => {
    expectTypeOf<keyof ExtensionAPI>().toEqualTypeOf<
      | 'registerService'
      | 'registerProjection'
      | 'registerTool'
      | 'registerHook'
      | 'registerSlot'
      | 'registerResource'
      | 'events'
      | 'latestExtEvent'
      | 'ctx'
    >()
  })
  it('has no seam registration', () => {
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerSeam' as never)
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerProvider' as never)
    expectTypeOf<ExtensionAPI>().not.toHaveProperty('registerOperation' as never)
  })
  it('latestExtEvent reads back this extension’s own most recent event (type-only; host wiring is I5)', () => {
    // Optional: the two existing ExtensionAPI construction sites (host's old stub and the
    // not-yet-wired Task22 implementation) don't implement it yet, and this task doesn't touch host.
    expectTypeOf<ExtensionAPI>().toHaveProperty('latestExtEvent')
    expectTypeOf<NonNullable<ExtensionAPI['latestExtEvent']>>().toEqualTypeOf<
      (name: string) => JsonValue | undefined
    >()
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
    const nothing: ExtensionFactory = defineExtension(() => {})
    const disposer: ExtensionFactory = defineExtension(() => () => {})
    const asyncNothing: ExtensionFactory = defineExtension(async () => {})
    const asyncDisposer: ExtensionFactory = defineExtension(async () => () => {})
    void [nothing, disposer, asyncNothing, asyncDisposer]
  })
})
