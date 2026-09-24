import { Context } from '@agnes/cordis'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import {
  createPluginRow,
  createVerifiedRowHost,
  E_ROW_IMPORT,
  FiberLease,
  FiberLeases,
  normalizePluginExport,
  type PackageSnapshotCandidateRef,
  type PackageSnapshotVerifier,
  resolveRowImporter,
  type ThirdPartyRowDescriptor,
} from '../src/host/index.js'
import { typeBoxStandardSchema } from '../src/standard-schema.js'

const candidate: PackageSnapshotCandidateRef = Object.freeze({
  packageId: '@example/tools',
  snapshotId: 'snapshot-1',
  exportName: 'main',
  generation: 1,
})

function row(overrides: Partial<Parameters<typeof createPluginRow>[0]> = {}) {
  return createPluginRow({
    id: 'ext:@example/tools/main',
    plugin: '@example/tools@snapshot-1/main',
    snapshotDigest: 'sha256-example',
    exportName: 'main',
    entryRevision: 'entry-1',
    extrasRevision: 'none',
    mountRevision: 'mount-1',
    ...overrides,
  })
}

function snapshots(
  overrides: Partial<Awaited<ReturnType<PackageSnapshotVerifier['verify']>>> = {},
): PackageSnapshotVerifier {
  return {
    async verify() {
      return {
        packageId: candidate.packageId,
        snapshotId: candidate.snapshotId,
        generation: candidate.generation,
        digest: 'sha256-example',
        exports: ['main'],
        trusted: true,
        ...overrides,
      }
    },
  }
}

describe('verified row contract', () => {
  it('installs production gates before any row is imported', async () => {
    const observed = vi.fn()
    const rootObserved = vi.fn()
    const root = new Context()
    createVerifiedRowHost({ root })
    const removeRootListener = root.on('internal/service', rootObserved)
    const fiber = root.plugin((ctx) => {
      ctx.on('internal/service', observed)
    })
    await fiber
    const dispose = root.provide('pre-tree-service', true)
    expect(observed).not.toHaveBeenCalled()
    expect(rootObserved).toHaveBeenCalled()
    await dispose()
    removeRootListener()
    await fiber.dispose()
  })

  it('captures plugin metadata and runs a non-idempotent schema exactly once', async () => {
    let count = 0
    const applied: unknown[] = []
    const plugin = Object.assign(
      (_ctx: Context, config: unknown) => {
        applied.push(config)
      },
      {
        inject: ['beta', 'alpha', 'alpha'],
        provide: ['tools', 'tools'],
        Config: {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate(value: unknown) {
              count += 1
              return { value: { value, pass: count } }
            },
          },
        },
      },
    )
    const entry = normalizePluginExport(plugin)
    plugin.inject.push('late')
    plugin.provide.push('late')

    expect(entry.inject).toEqual({ alpha: null, beta: null })
    expect(entry.provides).toEqual(['tools'])
    expect(Object.isFrozen(entry.inject)).toBe(true)

    const verifiedRow = row({
      inject: ['alpha', 'beta'],
      provides: ['tools'],
      extrasRevision: 'extras-1',
    })
    const extras = { slot: 'dependencies', revision: 'extras-1', values: { alpha: {}, beta: {} } }
    const host = createVerifiedRowHost({
      snapshots: snapshots(),
      exactExtras: { verify: ({ values }) => values },
    })
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry,
      extras,
    })
    const installation = await host.adapter.mount(new Context(), verifiedRow, mount)

    expect(count).toBe(1)
    expect(applied).toEqual([{ value: undefined, pass: 1 }])
    await host.adapter.unmount(installation)
  })

  it('freezes caller data before snapshot verification yields', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const verifier: PackageSnapshotVerifier = {
      async verify(ref) {
        await waiting
        return {
          ...ref,
          digest: 'sha256-example',
          exports: ['main'],
          trusted: true,
        }
      },
    }
    const plugin = vi.fn()
    const entry = normalizePluginExport(plugin)
    const mutableCandidate = { ...candidate }
    const config = { nested: { value: 'before' } }
    const originalRow = row({ config })
    const mutableRow = { ...originalRow, inject: [] as string[], isolate: {}, provides: [] as string[] }
    const descriptor = {
      snapshot: mutableCandidate,
      row: mutableRow,
      entry,
    } satisfies ThirdPartyRowDescriptor
    const host = createVerifiedRowHost({ snapshots: verifier })
    const pending = host.thirdParty.verifyAndCreate(descriptor)

    mutableCandidate.generation = 99
    mutableCandidate.snapshotId = 'changed'
    mutableRow.id = 'changed'
    mutableRow.inject.push('changed')
    config.nested.value = 'after'
    release()

    const mount = await pending
    const installation = await host.adapter.mount(
      new Context(),
      row({ config: { nested: { value: 'before' } } }),
      mount,
    )
    expect(plugin).toHaveBeenCalledWith(expect.anything(), { nested: { value: 'before' } })
    expect(host.origins.lookup(host.adapter.fiber(installation))).toMatchObject({
      packageId: '@example/tools',
      snapshotId: 'snapshot-1',
      rowId: 'ext:@example/tools/main',
    })
    await host.adapter.unmount(installation)
  })

  it('rejects untrusted, changed, or mismatched snapshots and reserved claims', async () => {
    const entry = normalizePluginExport(() => {})
    const descriptor = { snapshot: candidate, row: row(), entry }
    await expect(
      createVerifiedRowHost({ snapshots: snapshots({ trusted: false }) }).thirdParty.verifyAndCreate(
        descriptor,
      ),
    ).rejects.toMatchObject({ code: 'E_SNAPSHOT_UNTRUSTED' })
    await expect(
      createVerifiedRowHost({ snapshots: snapshots({ generation: 2 }) }).thirdParty.verifyAndCreate(
        descriptor,
      ),
    ).rejects.toMatchObject({ code: 'E_SNAPSHOT_CHANGED' })
    await expect(
      createVerifiedRowHost({ snapshots: snapshots({ digest: 'wrong' }) }).thirdParty.verifyAndCreate(
        descriptor,
      ),
    ).rejects.toMatchObject({ code: 'E_MOUNT_IDENTITY' })
    await expect(
      createVerifiedRowHost({
        snapshots: snapshots(),
        thirdPartyReservedRowIds: [row().id],
      }).thirdParty.verifyAndCreate(descriptor),
    ).rejects.toMatchObject({ code: 'E_RESERVED_ROW' })
    const reservedProvide = 'seam:approval'
    const providedEntry = normalizePluginExport(Object.assign(() => {}, { provide: reservedProvide }))
    await expect(
      createVerifiedRowHost({
        snapshots: snapshots(),
        thirdPartyReservedProvides: [reservedProvide],
      }).thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row({ provides: [reservedProvide] }),
        entry: providedEntry,
      }),
    ).rejects.toMatchObject({ code: 'E_RESERVED_PROVIDE' })
  })

  it('revalidates plain extras and isolates its private frozen copy', async () => {
    const values = { token: 'one' }
    const exactExtras = {
      verify(input: { slot: string; values: Readonly<Record<string, unknown>> }) {
        if (input.slot !== 'credentials' || typeof input.values.token !== 'string')
          throw new Error('bad extras')
        return input.values
      },
    }
    const applied = vi.fn()
    const plugin = (ctx: Context) => {
      expect((ctx as unknown as { token: string }).token).toBe('one')
      applied()
    }
    const entry = normalizePluginExport(Object.assign(plugin, { inject: ['token'] }))
    const extrasRow = row({ inject: ['token'], extrasRevision: 'extras-1' })
    const host = createVerifiedRowHost({ snapshots: snapshots(), exactExtras })
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: extrasRow,
      entry,
      extras: { slot: 'credentials', revision: 'extras-1', values },
    })
    values.token = 'changed'
    const installation = await host.adapter.mount(new Context(), extrasRow, mount)
    expect(applied).toHaveBeenCalledOnce()
    await host.adapter.unmount(installation)

    await expect(
      host.thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: extrasRow,
        entry,
        extras: { slot: 'wrong', revision: 'extras-1', values: { token: 'one' } },
      }),
    ).rejects.toThrow(/bad extras/)
  })

  it('isolates same-named extras per wrapper and accepts schema-valid values at one revision', async () => {
    const seen: string[] = []
    const entry = normalizePluginExport(
      Object.assign(
        (ctx: Context) => {
          seen.push((ctx as unknown as { token: string }).token)
        },
        {
          inject: ['token'],
        },
      ),
    )
    const extrasRow = row({ inject: ['token'], extrasRevision: 'extras-1' })
    const host = createVerifiedRowHost({
      snapshots: snapshots(),
      exactExtras: {
        verify: ({ values }) => {
          if (typeof values.token !== 'string') throw new Error('bad token')
          return values
        },
      },
    })
    const makeMount = (token: string) =>
      host.thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: extrasRow,
        entry,
        extras: { slot: 'credentials', revision: 'extras-1', values: { token } },
      })
    const root = new Context()
    const first = await host.adapter.mount(root, extrasRow, await makeMount('one'))
    const second = await host.adapter.mount(root, extrasRow, await makeMount('two'))
    expect(seen).toEqual(['one', 'two'])
    await host.adapter.unmount(second)
    await host.adapter.unmount(first)
  })

  it('continuously rejects undeclared provides while leaving direct root provides compatible', async () => {
    const denied = normalizePluginExport((ctx: Context) => {
      ctx.provide('undeclared', {})
    })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const deniedMount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: row(),
      entry: denied,
    })
    await expect(host.adapter.mount(new Context(), row(), deniedMount)).rejects.toThrow(/E_PROVIDE_DENIED/)

    const providedRow = row({ provides: ['declared'] })
    const allowed = normalizePluginExport(
      Object.assign((ctx: Context) => ctx.provide('declared', { ok: true }), { provide: 'declared' }),
    )
    const root = new Context()
    const allowedMount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: providedRow,
      entry: allowed,
    })
    const installation = await host.adapter.mount(root, providedRow, allowedMount)
    const dispose = root.provide('ordinary', true)
    expect(root.get('ordinary')).toBe(true)
    await dispose()
    await host.adapter.unmount(installation)
  })

  it('treats an unattested public plugin as third-party for provides', async () => {
    const root = new Context()
    createVerifiedRowHost({ root })
    const fiber = root.plugin((ctx) => ctx.provide('forged-service', true))
    await expect(fiber).rejects.toThrow(/E_PROVIDE_DENIED/)
    expect(root.get('forged-service')).toBeUndefined()
    await fiber.dispose()
  })

  it('blocks public internal event dispatch from a managed third-party row', async () => {
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.emit(ctx, 'internal/service', 'forged', {})
    })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: row(), entry })
    await expect(host.adapter.mount(new Context(), row(), mount)).rejects.toThrow(/E_INTERNAL_DISPATCH/)
  })

  it('swallows internal listeners from third-party rows and descendants', async () => {
    const observed = vi.fn()
    const childObserved = vi.fn()
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.on('internal/service', observed, { global: true, prepend: true })
      void ctx.plugin((child) => {
        child.once('internal/service', childObserved)
      })
    })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const root = new Context()
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: row(), entry })
    const installation = await host.adapter.mount(root, row(), mount)
    const dispose = root.provide('listener-test', true)
    expect(observed).not.toHaveBeenCalled()
    expect(childObserved).not.toHaveBeenCalled()
    await dispose()
    await host.adapter.unmount(installation)
  })

  it('allows verified builtin rows to listen to framework events', async () => {
    const observed = vi.fn()
    const builtinRow = row({ id: 'builtin:listener', plugin: 'builtin-listener' })
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.on('internal/service', observed)
    })
    const host = createVerifiedRowHost({ builtinAllowedRowIds: [builtinRow.id] })
    const root = new Context()
    const mount = await host.builtin.create({ row: builtinRow, entry })
    const installation = await host.adapter.mount(root, builtinRow, mount)
    const dispose = root.provide('builtin-listener-test', true)
    expect(observed).toHaveBeenCalled()
    await dispose()
    await host.adapter.unmount(installation)
  })

  it('accepts the builtin desired identity without recomputing it and keeps cleanup idempotent', async () => {
    const base = row({ id: 'builtin:demo', plugin: 'builtin-demo' })
    const staleIdentity = { ...base, mountIdentity: 'deliberately-stale' as typeof base.mountIdentity }
    const entry = normalizePluginExport(() => {})
    const host = createVerifiedRowHost({ builtinAllowedRowIds: ['builtin:demo'] })
    const mount = await host.builtin.create({ row: staleIdentity, entry })
    const installation = await host.adapter.mount(new Context(), staleIdentity, mount)
    await host.adapter.unmount(installation)
    await host.adapter.unmount(installation)
  })

  it('does not reserve a replaceable builtin seam id or provide against trusted third parties', async () => {
    const seamId = 'seam:approval'
    const provide = 'seam:approval'
    const entry = normalizePluginExport(Object.assign(() => {}, { provide }))
    const builtinRow = row({ id: seamId, plugin: 'builtin-approval', provides: [provide] })
    const replacementRow = row({ id: seamId, provides: [provide] })
    const host = createVerifiedRowHost({
      snapshots: snapshots(),
      builtinAllowedRowIds: [seamId],
      builtinAllowedProvides: [provide],
    })

    await expect(host.builtin.create({ row: builtinRow, entry })).resolves.toBeDefined()
    await expect(
      host.thirdParty.verifyAndCreate({ snapshot: candidate, row: replacementRow, entry }),
    ).resolves.toBeDefined()
  })

  it('fails closed when a production builtin id is not reserved', async () => {
    const builtinRow = row({ id: 'builtin:unreserved', plugin: 'builtin-unreserved' })
    await expect(
      createVerifiedRowHost().builtin.create({
        row: builtinRow,
        entry: normalizePluginExport(() => {}),
      }),
    ).rejects.toThrow(/E_BUILTIN_ROW/)
  })

  it('runs descriptor cleanup once and reports cleanup failures after all owners are released', async () => {
    const cleanup = vi.fn(() => {
      throw new Error('descriptor cleanup failed')
    })
    const entry = normalizePluginExport(() => {})
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: row(),
      entry,
      cleanup,
    })
    const installation = await host.adapter.mount(new Context(), row(), mount)
    await expect(host.adapter.unmount(installation)).rejects.toThrow(AggregateError)
    await expect(host.adapter.unmount(installation)).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('fails closed for isolated rows in both trust tiers', async () => {
    const isolated = row({ runtime: 'isolated' })
    const entry = normalizePluginExport(() => {})
    await expect(
      createVerifiedRowHost({ snapshots: snapshots() }).thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: isolated,
        entry,
      }),
    ).rejects.toMatchObject({ code: 'E_RUNTIME_UNSUPPORTED' })
    await expect(
      createVerifiedRowHost({ builtinAllowedRowIds: [isolated.id] }).builtin.create({
        row: isolated,
        entry,
      }),
    ).rejects.toMatchObject({ code: 'E_RUNTIME_UNSUPPORTED' })
  })

  it('always reserves host and spine namespaces for third-party rows and provides', async () => {
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    await expect(
      host.thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row({ id: 'host:forged' }),
        entry: normalizePluginExport(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'E_RESERVED_ROW' })

    const entry = normalizePluginExport(Object.assign(() => {}, { provide: 'spine:forged' }))
    await expect(
      host.thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row({ provides: ['spine:forged'] }),
        entry,
      }),
    ).rejects.toMatchObject({ code: 'E_RESERVED_PROVIDE' })
  })

  it('consumes a verified mount exactly once on success and failure', async () => {
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const verifiedRow = row()
    const success = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry: normalizePluginExport(() => {}),
    })
    const installation = await host.adapter.mount(new Context(), verifiedRow, success)
    await expect(host.adapter.mount(new Context(), verifiedRow, success)).rejects.toMatchObject({
      code: 'E_VERIFIED_MOUNT',
    })
    await host.adapter.unmount(installation)

    const failed = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry: normalizePluginExport(() => {
        throw new Error('apply failed')
      }),
    })
    await expect(host.adapter.mount(new Context(), verifiedRow, failed)).rejects.toThrow('apply failed')
    await expect(host.adapter.mount(new Context(), verifiedRow, failed)).rejects.toMatchObject({
      code: 'E_VERIFIED_MOUNT',
    })
  })

  it('discards a prepared verified mount without publishing a fiber or leaking its lease', async () => {
    const root = new Context()
    const source = root.plugin(() => {})
    await source
    const leases = new FiberLeases<string>()
    const lease = leases.bind(source, 'tools')
    const host = createVerifiedRowHost({ snapshots: snapshots(), leases })
    const verifiedRow = row()
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry: normalizePluginExport(() => {}),
      preboundLease: lease,
    })

    await host.adapter.discard?.(mount)
    expect(lease.active).toBe(false)
    await expect(host.adapter.mount(root, verifiedRow, mount)).rejects.toMatchObject({
      code: 'E_VERIFIED_MOUNT',
    })
    await source.dispose()
  })

  it('binds a mount to the complete row and burns it after a mismatched attempt', async () => {
    const plugin = vi.fn()
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const verifiedRow = row({ config: { value: 1 } })
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry: normalizePluginExport(plugin),
    })
    await expect(
      host.adapter.mount(new Context(), row({ config: { value: 2 } }), mount),
    ).rejects.toMatchObject({ code: 'E_VERIFIED_MOUNT' })
    await expect(host.adapter.mount(new Context(), verifiedRow, mount)).rejects.toMatchObject({
      code: 'E_VERIFIED_MOUNT',
    })
    expect(plugin).not.toHaveBeenCalled()
  })

  it('validates a prebound lease and derives an exact child lease', async () => {
    const root = new Context()
    const source = root.plugin(() => {})
    await source
    const leases = new FiberLeases<string>()
    const original = leases.bind(source, 'tools')
    const host = createVerifiedRowHost({ snapshots: snapshots(), leases })
    const verifiedRow = row()
    const mount = await host.thirdParty.verifyAndCreate({
      snapshot: candidate,
      row: verifiedRow,
      entry: normalizePluginExport(() => {}),
      preboundLease: original,
    })
    const installation = await host.adapter.mount(root, verifiedRow, mount)
    const child = host.adapter.fiber(installation)
    expect(leases.require(child, 'tools').fiber).toBe(child)
    expect(original.active).toBe(true)
    await host.adapter.unmount(installation)
    expect(original.active).toBe(false)
    await source.dispose()
  })

  it('rejects foreign and inactive prebound leases without releasing another registry lease', async () => {
    const root = new Context()
    const source = root.plugin(() => {})
    await source
    const foreign = new FiberLeases<string>()
    const lease = foreign.bind(source, 'tools')
    const host = createVerifiedRowHost({ snapshots: snapshots(), leases: new FiberLeases<string>() })
    await expect(
      host.thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row(),
        entry: normalizePluginExport(() => {}),
        preboundLease: lease,
      }),
    ).rejects.toMatchObject({ code: 'E_PREBOUND_LEASE' })
    expect(lease.active).toBe(true)
    await lease.release()
    await expect(
      createVerifiedRowHost({ snapshots: snapshots(), leases: foreign }).thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row(),
        entry: normalizePluginExport(() => {}),
        preboundLease: lease,
      }),
    ).rejects.toMatchObject({ code: 'E_PREBOUND_LEASE' })

    const other = root.plugin(() => {})
    await other
    const forged = new FiberLease(other, 'tools')
    await expect(
      createVerifiedRowHost({ snapshots: snapshots(), leases: foreign }).thirdParty.verifyAndCreate({
        snapshot: candidate,
        row: row(),
        entry: normalizePluginExport(() => {}),
        preboundLease: forged,
      }),
    ).rejects.toMatchObject({ code: 'E_PREBOUND_LEASE' })
    expect(forged.active).toBe(true)
    await other.dispose()
    await source.dispose()
  })

  it.each(['emit', 'parallel', 'serial', 'bail', 'waterfall'] as const)(
    'blocks third-party internal %s dispatch',
    async (mode) => {
      const entry = normalizePluginExport(async (ctx: Context) => {
        if (mode === 'emit') ctx.emit(ctx, 'internal/service', 'forged', {})
        if (mode === 'parallel') await ctx.events.parallel('internal/service', 'forged', {})
        if (mode === 'serial') await ctx.serial('internal/service', 'forged', {})
        if (mode === 'bail') ctx.events.bail('internal/service', 'forged', {})
        if (mode === 'waterfall') ctx.events.waterfall(ctx, 'internal/service', 'forged', {}, () => undefined)
      })
      const host = createVerifiedRowHost({ snapshots: snapshots() })
      const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: row(), entry })
      await expect(host.adapter.mount(new Context(), row(), mount)).rejects.toThrow(/E_INTERNAL_DISPATCH/)
    },
  )

  it('allows all five internal dispatch modes for a verified builtin', async () => {
    const builtinRow = row({ id: 'builtin:dispatch', plugin: 'builtin-dispatch' })
    const entry = normalizePluginExport(async (ctx: Context) => {
      ctx.emit(ctx, 'internal/service', 'builtin', {})
      await ctx.parallel('internal/service', 'builtin', {})
      await ctx.serial('internal/service', 'builtin', {})
      ctx.bail('internal/service', 'builtin', {})
      ctx.events.waterfall(ctx, 'internal/service', 'builtin', {}, () => undefined)
    })
    const host = createVerifiedRowHost({ builtinAllowedRowIds: [builtinRow.id] })
    const mount = await host.builtin.create({ row: builtinRow, entry })
    const installation = await host.adapter.mount(new Context(), builtinRow, mount)
    await host.adapter.unmount(installation)
  })

  it('continuously rejects delayed provides from a row and its descendants', async () => {
    let mounted!: Context
    const entry = normalizePluginExport((ctx: Context) => {
      mounted = ctx
    })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const verifiedRow = row()
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: verifiedRow, entry })
    const installation = await host.adapter.mount(new Context(), verifiedRow, mount)
    expect(() => mounted.provide('late-undeclared', true)).toThrow(/E_PROVIDE_DENIED/)
    const descendant = mounted.plugin(async (ctx) => {
      await Promise.resolve()
      ctx.provide('descendant-undeclared', true)
    })
    await expect(descendant).rejects.toThrow(/E_PROVIDE_DENIED/)
    await descendant.dispose()
    await host.adapter.unmount(installation)
  })
})

describe('row importer resolution', () => {
  it('uses the first claimant and rejects zero and duplicate claimants', async () => {
    const mount = {} as never
    await expect(resolveRowImporter(async () => undefined)(row())).rejects.toMatchObject({
      code: E_ROW_IMPORT,
    })
    await expect(
      resolveRowImporter(
        async () => mount,
        async () => mount,
      )(row()),
    ).rejects.toMatchObject({ code: E_ROW_IMPORT })
    await expect(
      resolveRowImporter(
        async () => undefined,
        async () => mount,
      )(row()),
    ).resolves.toBe(mount)
  })
})

describe('config updates', () => {
  it('normalizes each submitted config once and restores the last-good normalized value', async () => {
    let schemaCalls = 0
    const seen: number[] = []
    const plugin = Object.assign(
      (_ctx: Context, config: { value: number }) => {
        seen.push(config.value)
        if (config.value === 2) throw new Error('reject update')
      },
      {
        Config: typeBoxStandardSchema(Type.Object({ value: Type.Integer() })),
      },
    )
    const originalValidate = plugin.Config['~standard'].validate
    plugin.Config = {
      '~standard': {
        ...plugin.Config['~standard'],
        validate(value: unknown) {
          schemaCalls += 1
          return originalValidate(value)
        },
      },
    }
    const entry = normalizePluginExport(plugin)
    const initial = row({ config: { value: 1 } })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: initial, entry })
    const installation = await host.adapter.mount(new Context(), initial, mount)

    expect(await host.adapter.update(installation, row({ config: { value: 2 } }))).toMatchObject({
      status: 'restored',
    })
    expect(schemaCalls).toBe(2)
    expect(seen).toEqual([1, 2, 1])
    await host.adapter.unmount(installation)
  })

  // Every delivery re-decodes the runtime target, so an unchanged row arrives with a new config
  // object. Treating that as a change restarted every configured row on each ordinary apply.
  async function mountRecording(config: unknown) {
    const activations: unknown[] = []
    const plugin = (_ctx: Context, received: unknown) => {
      activations.push(received)
    }
    const entry = normalizePluginExport(plugin)
    const initial = row({ config })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: initial, entry })
    const installation = await host.adapter.mount(new Context(), initial, mount)
    return { activations, host, installation }
  }

  it('does not restart a row whose object config is structurally unchanged', async () => {
    const { activations, host, installation } = await mountRecording({ retries: 3, nested: { a: [1, 2] } })
    expect(activations).toHaveLength(1)

    const result = await host.adapter.update(
      installation,
      row({ config: { retries: 3, nested: { a: [1, 2] } } }),
    )

    expect(result).toEqual({ status: 'updated' })
    expect(activations).toHaveLength(1)
    await host.adapter.unmount(installation)
  })

  it('does not restart a row whose primitive config is unchanged', async () => {
    const { activations, host, installation } = await mountRecording(42)

    expect(await host.adapter.update(installation, row({ config: 42 }))).toEqual({ status: 'updated' })
    expect(activations).toHaveLength(1)
    await host.adapter.unmount(installation)
  })

  it('does not restart a row that has no config on either side', async () => {
    const { activations, host, installation } = await mountRecording(undefined)

    expect(await host.adapter.update(installation, row())).toEqual({ status: 'updated' })
    expect(activations).toHaveLength(1)
    await host.adapter.unmount(installation)
  })

  it('still restarts a row whose config really changed', async () => {
    const { activations, host, installation } = await mountRecording({ retries: 3 })

    expect(await host.adapter.update(installation, row({ config: { retries: 4 } }))).toEqual({
      status: 'updated',
    })
    expect(activations).toEqual([{ retries: 3 }, { retries: 4 }])
    await host.adapter.unmount(installation)
  })

  it('restarts when a schema decodes a changed config into objects without own keys', async () => {
    const activations: unknown[] = []
    const at = Type.Transform(Type.String())
      .Decode((value) => new Date(value))
      .Encode((value) => value.toISOString())
    const plugin = Object.assign(
      (_ctx: Context, received: { at: Date }) => {
        activations.push(received.at.toISOString())
      },
      { Config: typeBoxStandardSchema(Type.Object({ at })) },
    )
    const initial = row({ config: { at: '2026-01-01T00:00:00.000Z' } })
    const host = createVerifiedRowHost({ snapshots: snapshots() })
    const entry = normalizePluginExport(plugin)
    const mount = await host.thirdParty.verifyAndCreate({ snapshot: candidate, row: initial, entry })
    const installation = await host.adapter.mount(new Context(), initial, mount)

    const next = row({ config: { at: '2027-01-01T00:00:00.000Z' } })
    expect(await host.adapter.update(installation, next)).toEqual({ status: 'updated' })
    expect(activations).toEqual(['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'])
    await host.adapter.unmount(installation)
  })

  it('treats an empty array and an object with the same own keys as different configs', async () => {
    const { activations, host, installation } = await mountRecording({ items: [] })

    const next = row({ config: { items: { length: 0 } } })
    expect(await host.adapter.update(installation, next)).toEqual({ status: 'updated' })
    expect(activations).toEqual([{ items: [] }, { items: { length: 0 } }])
    await host.adapter.unmount(installation)
  })

  it('treats an explicit null and an absent key as different configs', async () => {
    const { activations, host, installation } = await mountRecording({ proxy: null })

    expect(await host.adapter.update(installation, row({ config: {} }))).toEqual({ status: 'updated' })
    expect(activations).toHaveLength(2)
    await host.adapter.unmount(installation)
  })
})
