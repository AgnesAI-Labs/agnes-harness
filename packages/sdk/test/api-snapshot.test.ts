// biome-ignore-all assist/source/organizeImports: separate negative imports make each missing browser type independently enforceable
import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Client as BrowserClientConstructor } from '@agnes/sdk/browser'
import { parseComposerMemory as parseComposerSelection } from '@agnes/sdk/composer-selection'
// @ts-expect-error Relay types are Node-only and must never enter the browser entry.
import type { RelayOptions as BrowserRelayOptions } from '../src/index.browser.js'
// @ts-expect-error Relay types are Node-only and must never enter the browser entry.
import type { RelayRoute as BrowserRelayRoute } from '../src/index.browser.js'
import type { RelayOptions, RelayRoute } from '../src/index.node.js'
import type { BrowserCreateClientOptions, Client as BrowserClient } from '@agnes/sdk/browser'
// @ts-expect-error The browser Client type must not expose Node-only identity signing helpers.
import type { PortalClaims as BrowserPortalClaims } from '@agnes/sdk/browser'
// @ts-expect-error Package Admin is Node-only and must never enter the browser entry.
import type { PackageAdminClient as BrowserPackageAdminClient } from '../src/index.browser.js'
// @ts-expect-error Extension Service calls are Node-only and must never enter the browser entry.
import type { ExtensionClient as BrowserExtensionClient } from '../src/index.browser.js'

const load = {
  browser: () => import('@agnes/sdk/browser'),
  node: () => import('@agnes/sdk'),
}

function expected(name: 'browser' | 'node'): string {
  return readFileSync(new URL(`./api-snapshot.${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

describe('export surface snapshot (规格 §20.5, SDK Task 23)', () => {
  it.each(['node', 'browser'] as const)('%s entry matches its exact reviewed snapshot', async (name) => {
    expect(
      `${Object.keys(await load[name]())
        .sort()
        .join('\n')}\n`,
    ).toBe(expected(name))
  })

  it('keeps relay values and types on Node while the browser cannot import them', async () => {
    const node = await load.node()
    const browser = await load.browser()
    expect(node.createRelay).toBeTypeOf('function')
    expect(node.stripIdentity).toBeTypeOf('function')
    expect(node.signSourceAuth).toBeTypeOf('function')
    expect(node.sourceAuthCanonical).toBeTypeOf('function')
    expect(node.sourceAuthProvider).toBeTypeOf('function')
    expectTypeOf<RelayRoute>().toMatchTypeOf<{ method: 'GET' | 'POST'; path: string }>()
    expectTypeOf<RelayOptions['principal']>().toBeFunction()
    expectTypeOf<BrowserRelayOptions>().toBeAny()
    expectTypeOf<BrowserRelayRoute>().toBeAny()
    expectTypeOf<BrowserPortalClaims>().toBeAny()
    expectTypeOf<BrowserPackageAdminClient>().toBeAny()
    expectTypeOf<BrowserExtensionClient>().toBeAny()
    expectTypeOf<BrowserClient>().not.toHaveProperty('identity')
    expectTypeOf<BrowserClient>().not.toHaveProperty('packages')
    expectTypeOf<BrowserClient>().not.toHaveProperty('extensions')
    expectTypeOf<
      ConstructorParameters<typeof BrowserClientConstructor>[0]
    >().toEqualTypeOf<BrowserCreateClientOptions>()
    expectTypeOf<
      Extract<NonNullable<BrowserCreateClientOptions['auth']>, { kind: 'source-auth' }>
    >().toBeNever()
    expect('createRelay' in browser).toBe(false)
    expect('stripIdentity' in browser).toBe(false)
  })

  it('keeps every Node-only implementation outside the browser runtime surface', async () => {
    const nodeOnly = [
      'createRelay',
      'fileJournal',
      'mintPortalIdentity',
      'stdioTransport',
      'stripIdentity',
      'unixTransport',
      'verifyPortalIdentity',
    ]
    const node = await load.node()
    const browser = await load.browser()
    for (const name of nodeOnly) {
      expect(name in node, `${name} must remain available from Node`).toBe(true)
      expect(name in browser, `${name} must remain unavailable from browser`).toBe(false)
    }
    expect('localStorageJournal' in node).toBe(false)
    expect('localStorageJournal' in browser).toBe(true)
  })

  it('does not honor an untyped browser caller injecting a secret-bearing auth provider', async () => {
    const browser = await load.browser()
    let invoked = false
    for (const make of [browser.createClient, (opts: never) => new browser.Client(opts)]) {
      expect(() =>
        make({
          transport: { kind: 'ws', url: 'ws://127.0.0.1/unused' },
          auth: { kind: 'source-auth', secret: 'must-not-be-used' },
          authProviders: {
            'source-auth': () => {
              invoked = true
              throw new Error('provider invoked')
            },
          },
        } as never),
      ).toThrow(/browser client auth kind unsupported/)
    }
    expect(invoked).toBe(false)
  })

  it('does not expose an Actor constructor or deferred Python SDK surface from either entry', async () => {
    for (const name of ['node', 'browser'] as const) {
      const exports = Object.keys(await load[name]())
      expect(exports.some((key) => /actor/i.test(key))).toBe(false)
      expect(exports.some((key) => /python|runtimePy/i.test(key))).toBe(false)
    }
  })

  it('routes the package browser condition and reviewed explicit subpaths', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
      string,
      unknown
    >
    expect(manifest.exports).toEqual({
      '.': { browser: './src/index.browser.ts', default: './src/index.node.ts' },
      './browser': './src/index.browser.ts',
      './composer-selection': './src/composer-selection.ts',
      './surface': { browser: './src/surface.browser.ts', default: './src/surface.node.ts' },
    })
    expect(parseComposerSelection({ permission: 'full' })).toEqual({ permission: 'full' })
  })
})
