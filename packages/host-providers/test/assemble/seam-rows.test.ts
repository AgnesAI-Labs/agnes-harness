import { Context } from '@agnes/cordis'
import type { SeamInit, SeamKind, VerifierProvider } from '@agnes/extension-api/seams'
import { verifierKind } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { describe, expect, it, vi } from 'vitest'
import { installSeamKinds } from '../../src/assemble/seam-kinds.js'
import {
  buildSeamBindingRows,
  REQUIRED_SEAM_ROW_IDS,
  type SeamBindingInput,
  seamBinding,
} from '../../src/assemble/seam-rows.js'

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
      ctx.providers.registerHost(verifierKind, source, provider)
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
      message: expect.stringContaining('providers.verifier.provider'),
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

  it('aborts the signal of a creation that times out and reports a failed close', async () => {
    let seen: AbortSignal | undefined
    const { root, input, register } = rig([], 20)
    register(
      '@agnes/base',
      verifier({
        create: ((_init: unknown, signal: AbortSignal) => {
          seen = signal
          return new Promise<object>(() => undefined)
        }) as never,
      }),
    )
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    await expect(seamBinding('verifier', { provider: 'alt' }, input)(root, preset)).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
      detail: { reason: 'timeout' },
    })
    expect(seen?.aborted).toBe(true)
    await root.fiber.dispose()

    const rejecting = rig([], 20)
    rejecting.register(
      '@agnes/base',
      verifier({
        create: ((_init: unknown, signal: AbortSignal) =>
          new Promise<object>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('stopped'))),
          )) as never,
      }),
    )
    await expect.poll(() => rejecting.root.providers.catalog().length).toBe(1)
    await expect(
      seamBinding('verifier', { provider: 'alt' }, rejecting.input)(rejecting.root, preset),
    ).rejects.toMatchObject({ detail: { reason: 'timeout' } })
    await rejecting.root.fiber.dispose()

    const hollow = rig([], 20)
    hollow.register(
      '@agnes/base',
      verifier({
        instance: {
          close: async () => {
            throw new Error('close failed')
          },
        },
      }),
    )
    await expect.poll(() => hollow.root.providers.catalog().length).toBe(1)
    await expect(
      seamBinding('verifier', { provider: 'alt' }, hollow.input)(hollow.root, preset),
    ).rejects.toMatchObject({ detail: { reason: 'shape', closeFailed: true } })
    await hollow.root.fiber.dispose()
  })

  it.each([
    [
      'a mis-shaped instance',
      'shape',
      () => Promise.resolve({ close: () => new Promise<void>(() => undefined) }),
    ],
    [
      'an instance that arrives once its creation is aborted',
      'timeout',
      (signal: AbortSignal) =>
        new Promise<object>((resolve) =>
          signal.addEventListener('abort', () =>
            resolve({ close: () => new Promise<void>(() => undefined) }),
          ),
        ),
    ],
  ] as const)(
    'refuses within the cleanup window when the close of %s never settles',
    async (_name, reason, create) => {
      const { root, input, register } = rig([], 20)
      register(
        '@agnes/base',
        verifier({ create: ((_init: unknown, signal: AbortSignal) => create(signal)) as never }),
      )
      await expect.poll(() => root.providers.catalog().length).toBe(1)
      await expect(seamBinding('verifier', { provider: 'alt' }, input)(root, preset)).rejects.toMatchObject({
        code: 'E_SEAM_INIT',
        message: expect.stringContaining('closing the instance did not finish'),
        detail: { reason, closePending: true },
      })
      await root.fiber.dispose()
    },
  )

  it.each([
    { id: '@acme/third', trust: 'trusted', packageId: '@acme/third', trustTier: 'third-party' },
    { id: '@agnes/base', trust: 'builtin', packageId: '@agnes/base', trustTier: 'third-party' },
    {
      id: '@agnes/base',
      trust: 'builtin',
      packageId: 'builtin',
      trustTier: 'builtin',
      ownerPackage: '@acme/other',
    },
    {
      id: '@agnes/base',
      trust: 'builtin',
      packageId: 'builtin',
      trustTier: 'builtin',
      ownerPackage: '@agnes/code',
    },
  ])('denies a mismatched registration $id the privileged init and closes on dispose', async (origin) => {
    const { id, trust } = origin
    const closed = vi.fn()
    const { root, input, inits, register } = rig([{ id, trust, integrity: 'sha-third' } as never])
    root.providers.verifyRows({
      lookup: () => origin,
    } as never)
    register(id, verifier({ instance: { verify: async () => ({}), close: closed } }))
    await expect.poll(() => root.providers.catalog().length).toBe(1)
    const dispose = await seamBinding('verifier', { provider: 'alt' }, input)(root, preset)
    expect(inits).toEqual([{ source: id, builtin: false }])
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

describe('seam binding rows', () => {
  const selections = {
    approval: { provider: 'local-prompt' },
    principals: { provider: 'local' },
    billing: { provider: 'budget' },
    checkpoint: { provider: 'fs' },
    artifacts: { provider: 'local' },
    verifier: { provider: 't0' },
    repair: { provider: 'default' },
  } as const
  const build = (
    deploymentMarker: string,
    generationBuiltinRows?: Parameters<typeof buildSeamBindingRows>[0]['generationBuiltinRows'],
  ) =>
    buildSeamBindingRows({
      profile: {
        packages: [],
        adapters: { secrets: {} },
        seams: selections,
        marker: deploymentMarker,
      } as unknown as ResolvedProfile,
      selections,
      ...(generationBuiltinRows ? { generationBuiltinRows } : {}),
      preset: { name: 'default' },
      timeoutMs: 10,
      initFor: () => ({}) as SeamInit,
      onBound: () => undefined,
    })

  it('makes one Host-owned row per kind, in kind order, each providing its own service', () => {
    const { rows, builtinClaims } = build('a')
    expect(rows.map((row) => row.id)).toEqual(REQUIRED_SEAM_ROW_IDS)
    expect(rows.every((row) => row.provides.length === 1 && row.provides[0] === row.id)).toBe(true)
    expect(rows.every((row) => row.plugin.startsWith('builtin:host/seam-binder/'))).toBe(true)
    expect(builtinClaims).toHaveLength(7)
  })

  it('changes a row’s identity with the selection, so a different provider remounts it', () => {
    const first = build('a').rows
    const changed = buildSeamBindingRows({
      profile: {
        packages: [],
        adapters: { secrets: {} },
        seams: selections,
        marker: 'a',
      } as unknown as ResolvedProfile,
      selections: { ...selections, approval: { provider: 'other', version: '2.0.0' } },
      preset: { name: 'default' },
      timeoutMs: 10,
      initFor: () => ({}) as SeamInit,
      onBound: () => undefined,
    }).rows
    expect(changed[0]?.mountIdentity).not.toBe(first[0]?.mountIdentity)
    expect(changed[1]?.mountIdentity).toBe(first[1]?.mountIdentity)
  })

  it('keeps the identity a stored generation gave a row, so a cold resume is not refused as a foreign claim', () => {
    const stored = build('model-config-at-first-boot').rows
    const resumed = build('model-config-changed-since', stored).rows
    expect(resumed.map((row) => row.mountIdentity)).toEqual(stored.map((row) => row.mountIdentity))
    // Without the stored rows a changed deployment hashes differently, which is what the claim check refuses.
    expect(build('model-config-changed-since').rows[0]?.mountIdentity).not.toBe(stored[0]?.mountIdentity)
  })
})
