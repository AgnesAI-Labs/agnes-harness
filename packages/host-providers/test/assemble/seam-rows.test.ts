import { Context } from '@agnes/cordis'
import type { SeamInit, SeamKind, VerifierProvider } from '@agnes/extension-api/seams'
import { verifierKind } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { describe, expect, it, vi } from 'vitest'
import { installSeamKinds } from '../../src/assemble/seam-kinds.js'
import { type SeamBindingInput, seamBinding } from '../../src/assemble/seam-rows.js'

const preset = { name: 'default' }
const verifier = (over: Partial<VerifierProvider> & { instance?: object | (() => Promise<object>) } = {}) => {
  const { instance, ...rest } = over
  return {
    id: 'alt',
    version: '1.0.0',
    create: async () =>
      typeof instance === 'function'
        ? instance()
        : (instance ?? { verify: async () => ({ verdict: 'pass', reasons: [] }) }),
    ...rest,
  } as VerifierProvider
}

function rig(packages: ResolvedProfile['packages'] = [], timeoutMs = 50) {
  const root = new Context()
  installSeamKinds(root)
  const inits: Array<{ source: string; builtin: boolean }> = []
  const bound: unknown[] = []
  const input: SeamBindingInput = {
    profile: { packages } as unknown as ResolvedProfile,
    timeoutMs,
    initFor: (source, _kind: SeamKind, builtin) => {
      inits.push({ source, builtin })
      return { adapters: {} } as unknown as SeamInit
    },
    onBound: (binding) => bound.push(binding),
  }
  const register = (source: string, provider: VerifierProvider) =>
    root.plugin((ctx) => {
      ctx.providers.register(verifierKind, source, provider)
    })
  return { root, input, inits, bound, register }
}

describe('seam binding', () => {
  it('provides the instance of the selected provider and records which package supplied it', async () => {
    const { root, input, bound, register } = rig([
      { id: '@agnes/base', trust: 'builtin', integrity: 'sha-base' } as never,
    ])
    register('@agnes/base', verifier())
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    const dispose = await seamBinding('verifier', { provider: 'alt' }, input)(root, preset)
    expect(root.get('seam:verifier')).toMatchObject({ verify: expect.any(Function) })
    expect(bound).toEqual([
      {
        kind: 'verifier',
        provider: 'alt',
        version: '1.0.0',
        sourcePackage: '@agnes/base',
        integrity: 'sha-base',
      },
    ])
    await dispose()
    await root.fiber.dispose()
  })

  it('fails closed with E_SEAM_MISSING naming the unregistered provider', async () => {
    const { root, input } = rig()
    await expect(seamBinding('verifier', { provider: 'ghost' }, input)(root, preset)).rejects.toMatchObject({
      code: 'E_SEAM_MISSING',
      message: expect.stringContaining('seams.verifier.provider'),
    })
    await root.fiber.dispose()
  })

  it('maps a throwing factory to E_SEAM_INIT and refuses a non-object or an instance missing methods', async () => {
    const { root, input, register } = rig()
    const failing = verifier({
      create: async () => {
        throw new Error('db down')
      },
    })
    register('@agnes/base', failing)
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    await expect(seamBinding('verifier', { provider: 'alt' }, input)(root, preset)).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
      message: expect.stringContaining('db down'),
    })
    const nonObject = rig()
    nonObject.register('@agnes/base', verifier({ create: async () => 'nope' as never }))
    await expect.poll(() => nonObject.root.providers.catalog().length).toBe(1)
    await expect(
      seamBinding('verifier', { provider: 'alt' }, nonObject.input)(nonObject.root, preset),
    ).rejects.toThrow(/non-object/)
    const hollow = rig()
    hollow.register('@agnes/base', verifier({ instance: {} }))
    await expect.poll(() => hollow.root.providers.catalog().length).toBe(1)
    await expect(
      seamBinding('verifier', { provider: 'alt' }, hollow.input)(hollow.root, preset),
    ).rejects.toThrow(/lacks verify/)
    await Promise.all([root, nonObject.root, hollow.root].map((r) => r.fiber.dispose()))
  })

  it('times out a hung factory and closes an instance that arrives late', async () => {
    const closed = vi.fn()
    let release: (value: object) => void = () => undefined
    const { root, input, register } = rig([], 20)
    register(
      '@agnes/base',
      verifier({ create: () => new Promise<object>((resolve) => (release = resolve)) as never }),
    )
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    await expect(seamBinding('verifier', { provider: 'alt' }, input)(root, preset)).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
      message: expect.stringContaining('timed out'),
    })
    release({ verify: async () => ({ verdict: 'pass', reasons: [] }), close: closed })
    await expect.poll(() => closed.mock.calls.length).toBe(1)
    await root.fiber.dispose()
  })

  it('gives only builtin packages the privileged init and closes the instance on dispose', async () => {
    const closed = vi.fn()
    const { root, input, inits, register } = rig([
      { id: '@acme/third', trust: 'trusted', integrity: 'sha-third' } as never,
    ])
    register('@acme/third', verifier({ instance: { verify: async () => ({}), close: closed } }))
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    const dispose = await seamBinding('verifier', { provider: 'alt' }, input)(root, preset)
    expect(inits).toEqual([{ source: '@acme/third', builtin: false }])
    await dispose()
    expect(closed).toHaveBeenCalledOnce()
    await root.fiber.dispose()
  })

  it('selects by version when two versions of one provider are registered', async () => {
    const { root, input, bound, register } = rig()
    register('@agnes/base', verifier({ version: '1.0.0' }))
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    await expect(
      seamBinding('verifier', { provider: 'alt', version: '2.0.0' }, input)(root, preset),
    ).rejects.toBeInstanceOf(HostError)
    expect(bound).toEqual([])
    await root.fiber.dispose()
  })
})
