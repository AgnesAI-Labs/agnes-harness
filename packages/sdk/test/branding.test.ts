import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandingCache, DEFAULT_BRANDING } from '../src/branding.js'
import { createClient } from '../src/client.js'
import { TEXT } from '../src/text.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('branding cache', () => {
  it('serves one default contract, refreshes after success, and retries without losing the last value', async () => {
    vi.useFakeTimers()
    let fail = false
    let n = 0
    const cache = new BrandingCache(
      async () => {
        if (fail) throw new Error('down')
        n++
        return { accent: '#123456', mark: 'm', selfLabel: `Brand${n}` }
      },
      { refreshMs: 30_000, retryMs: 5_000, firstRenderWaitMs: 1_500 },
    )

    expect(cache.current()).toBe(DEFAULT_BRANDING)
    expect(await cache.forRender()).toEqual({ accent: '#123456', mark: 'm', selfLabel: 'Brand1' })
    fail = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cache.current().selfLabel).toBe('Brand1')
    fail = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cache.current().selfLabel).toBe('Brand2')
    expect((await cache.forRender()).selfLabel).toBe('Brand2')
    cache.stop()
  })

  it('bounds the first render wait and keeps the cache inert after stop', async () => {
    vi.useFakeTimers()
    let resolve!: (value: { accent: string; mark: string; selfLabel: string }) => void
    const cache = new BrandingCache(() => new Promise((r) => (resolve = r)), {
      refreshMs: 30_000,
      retryMs: 5_000,
      firstRenderWaitMs: 1_500,
    })

    const rendered = cache.forRender()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await rendered).toBe(DEFAULT_BRANDING)
    cache.stop()
    resolve({ accent: '#000000', mark: 'late', selfLabel: 'Late' })
    await Promise.resolve()
    expect(cache.current()).toBe(DEFAULT_BRANDING)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is memoized by Client, reads apis.list branding, and stops refreshing on close', async () => {
    vi.useFakeTimers()
    let n = 0
    const ep = fakeEndpoint({
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }),
      '_agnes/v1/apis.list': () => ({
        profile: {
          name: 'p',
          resolvedProfileHash: null,
          presets: { default: 'standard', allowed: ['standard'] },
          branding: { accent: '#654321', mark: 'remote', selfLabel: `Remote${++n}` },
        },
        families: [],
      }),
    })
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep.endpoint } })
    expect(client.branding()).toBe(client.branding())
    expect(await client.branding().forRender()).toMatchObject({ selfLabel: 'Remote1' })
    await client.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(n).toBe(1)
  })

  it('uses the shared default when the daemon omits its optional branding field', async () => {
    const ep = fakeEndpoint({
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }),
      '_agnes/v1/apis.list': () => ({
        profile: {
          name: 'p',
          resolvedProfileHash: null,
          presets: { default: 'standard', allowed: ['standard'] },
        },
        families: [],
      }),
    })
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep.endpoint } })
    expect(await client.branding().forRender()).toBe(DEFAULT_BRANDING)
    await client.close()
  })
})

describe('unified text', () => {
  it('uses the two reviewed locales and falls back to English', () => {
    const ep = fakeEndpoint({ initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }) })
    const zh = createClient({ transport: { kind: 'inproc', endpoint: ep.endpoint }, locale: 'zh-CN' })
    expect(zh.text.blocked()).toBe(TEXT['zh-CN'].blocked)
    expect(zh.text.unavailable()).toBe(TEXT['zh-CN'].unavailable)

    const other = createClient({ transport: { kind: 'inproc', endpoint: ep.endpoint }, locale: 'fr' })
    expect(other.text.blocked()).toBe(TEXT.en.blocked)
    expect(other.text.unavailable()).toBe(TEXT.en.unavailable)
  })
})
