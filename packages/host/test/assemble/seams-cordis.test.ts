import { type Context, FiberState } from '@agnes/cordis'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  type EntryRow,
  encodeRuntimeTargetArtifact,
  type HostPluginImporterFactory,
  normalizePluginExport,
  type PackageSnapshotVerifier,
} from '@agnes/plugin-runtime/host'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
import { describe, expect, it, vi } from 'vitest'
import { assembleOrdinaryPluginTree } from '../../src/assemble/seams-cordis.js'

function builtinRow(config?: unknown) {
  return createPluginRow({
    id: 'host:test-seam',
    plugin: 'builtin:test-seam',
    snapshotDigest: 'builtin:test-seam',
    exportName: 'default',
    entryRevision: 'entry-1',
    extrasRevision: 'none',
    mountRevision: 'mount-1',
    ...(config === undefined ? {} : { config }),
  })
}

describe('ordinary Cordis tree base', () => {
  it('mounts Host-private builtin claims and returns immutable row snapshots', async () => {
    const applied = vi.fn()
    const disposed = vi.fn()
    const row = builtinRow()
    const entry = normalizePluginExport((ctx: Context) => {
      applied()
      ctx.effect(() => disposed)
    })
    const inputRows = [row]

    const assembled = await assembleOrdinaryPluginTree(
      {},
      { bootRows: inputRows, builtinClaims: [{ row, entry }] },
    )
    try {
      expect(applied).toHaveBeenCalledOnce()
      expect(assembled.pluginTree.bootRows).toEqual([row])
      expect(assembled.pluginTree.bootRows).not.toBe(inputRows)
      expect(Object.isFrozen(assembled.pluginTree.bootRows)).toBe(true)
      expect(Object.isFrozen(assembled.pluginTree.bootRows[0])).toBe(true)

      const first = assembled.pluginTree.currentRows()
      const second = assembled.pluginTree.currentRows()
      expect(first).toEqual([row])
      expect(first).not.toBe(second)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first[0])).toBe(true)
      await assembled.pluginTree.applyRows(first)
      expect(applied).toHaveBeenCalledOnce()
    } finally {
      await assembled.close()
    }
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('registers an optional builtin claim without booting it and mounts it when later enabled', async () => {
    const applied = vi.fn()
    const row = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        builtinClaims: [{ row, entry: normalizePluginExport(applied) }],
      },
    )
    try {
      expect(assembled.pluginTree.bootRows).toEqual([])
      expect(assembled.pluginTree.currentRows()).toEqual([])
      expect(applied).not.toHaveBeenCalled()

      await assembled.pluginTree.applyRows([row])
      expect(applied).toHaveBeenCalledOnce()
      expect(assembled.pluginTree.currentRows()).toEqual([row])
    } finally {
      await assembled.close()
    }
  })

  it('snapshots nested configuration before returning from a public reconciliation', async () => {
    const row = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      { builtinClaims: [{ row, entry: normalizePluginExport(() => {}) }] },
    )
    const mutableConfig = { nested: { value: 'before' } }
    const desired = Object.freeze({ ...row, config: mutableConfig })
    try {
      await assembled.pluginTree.applyRows([desired])
      mutableConfig.nested.value = 'after'
      const applied = assembled.pluginTree.currentRows()[0]
      if (!applied?.config || typeof applied.config !== 'object') {
        throw new Error('expected a snapshotted configuration row')
      }
      expect(applied?.config).toEqual({ nested: { value: 'before' } })
      expect(Object.isFrozen(applied?.config)).toBe(true)
      expect(Object.isFrozen((applied.config as { nested: object }).nested)).toBe(true)
    } finally {
      await assembled.close()
    }
  })

  it('keeps a configured row running when a re-decoded target only adds an unrelated row', async () => {
    const rowOf = (id: string, config?: unknown) =>
      createPluginRow({
        id,
        plugin: `builtin:${id}`,
        snapshotDigest: `builtin:${id}`,
        exportName: 'default',
        entryRevision: 'entry-1',
        extrasRevision: 'none',
        mountRevision: 'mount-1',
        ...(config === undefined ? {} : { config }),
      })
    const applied = vi.fn()
    const disposed = vi.fn()
    const configured = rowOf('host:configured', { endpoint: 'https://example.test', retry: { max: 3 } })
    const unrelated = rowOf('host:unrelated')
    const configuredEntry = normalizePluginExport((ctx: Context) => {
      applied()
      ctx.effect(() => disposed)
    })
    // Each delivery decodes the canonical artifact again, so every row and config is a new object.
    const delivered = (rows: readonly Readonly<EntryRow>[]) =>
      decodeRuntimeTargetArtifact(
        encodeRuntimeTargetArtifact(
          buildRuntimeTarget({
            rows,
            resourceRevision: 'a'.repeat(64),
            compositeRevision: 'b'.repeat(64),
            resources: { mcp: [], skills: {} },
          }),
        ),
      ).tree.rows
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: delivered([configured]),
        builtinClaims: [
          { row: configured, entry: configuredEntry },
          { row: unrelated, entry: normalizePluginExport(() => {}) },
        ],
      },
    )
    try {
      const before = assembled.pluginTree.tree.fiber('host:configured')
      const next = delivered([configured, unrelated])
      expect(next.find(({ id }) => id === 'host:configured')?.config).not.toBe(configured.config)

      await assembled.pluginTree.applyRows(next)

      expect(assembled.pluginTree.currentRows().map(({ id }) => id)).toEqual([
        'host:configured',
        'host:unrelated',
      ])
      expect(assembled.pluginTree.tree.fiber('host:configured')).toBe(before)
      expect(applied).toHaveBeenCalledOnce()
      expect(disposed).not.toHaveBeenCalled()
    } finally {
      await assembled.close()
    }
  })

  it('prepares Host row transactions without mounting and compensates a failed candidate', async () => {
    const applied = vi.fn()
    const disposed = vi.fn()
    const first = builtinRow()
    const failed = createPluginRow({
      id: 'host:failed-seam',
      plugin: 'builtin:failed-seam',
      snapshotDigest: 'builtin:failed-seam',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
    })
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [first],
        builtinClaims: [
          {
            row: first,
            entry: normalizePluginExport((ctx: Context) => {
              applied()
              ctx.effect(() => disposed)
            }),
          },
          {
            row: failed,
            entry: normalizePluginExport(() => {
              throw new Error('candidate failed')
            }),
          },
        ],
      },
    )
    try {
      if (!assembled.pluginTree.prepareRows || !assembled.pluginTree.applyPreparedRows) {
        throw new Error('expected Host transaction adapter')
      }
      const prepared = await assembled.pluginTree.prepareRows([first, failed])
      expect(assembled.pluginTree.currentRows()).toEqual([first])
      expect(applied).toHaveBeenCalledOnce()
      await expect(assembled.pluginTree.applyPreparedRows(prepared)).rejects.toMatchObject({
        code: 'E_ROW_TRANSACTION',
      })
      expect(assembled.pluginTree.currentRows()).toEqual([first])
      expect(applied).toHaveBeenCalledOnce()
      expect(disposed).not.toHaveBeenCalled()
    } finally {
      await assembled.close()
    }
  })

  it('retains a desired row while its required dependency is pending', async () => {
    const seen = vi.fn()
    const plugin = Object.assign(
      (ctx: Context) => seen((ctx as unknown as { dependency: string }).dependency),
      { inject: ['dependency'] },
    )
    const row = createPluginRow({
      id: 'host:pending-dependency',
      plugin: 'builtin:pending-dependency',
      snapshotDigest: 'builtin:pending-dependency',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
      inject: ['dependency'],
    })
    const assembled = await assembleOrdinaryPluginTree(
      {},
      { bootRows: [row], builtinClaims: [{ row, entry: normalizePluginExport(plugin) }] },
    )
    try {
      expect(assembled.pluginTree.currentRows()).toEqual([row])
      expect(assembled.pluginTree.tree.fiber(row.id)?.state).toBe(FiberState.PENDING)
      expect(seen).not.toHaveBeenCalled()
    } finally {
      await assembled.close()
    }
  })

  it('gives up on a plugin whose startup never finishes instead of waiting forever', async () => {
    const stuck = createPluginRow({
      id: 'host:stuck-start',
      plugin: 'builtin:stuck-start',
      snapshotDigest: 'builtin:stuck-start',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
    })
    const never = normalizePluginExport(() => new Promise<void>(() => {}))
    const started = Date.now()
    await expect(
      assembleOrdinaryPluginTree(
        { startTimeoutMs: 50 },
        { bootRows: [stuck], builtinClaims: [{ row: stuck, entry: never }] },
      ),
    ).rejects.toMatchObject({ code: 'E_EXT_LOAD', detail: { reason: 'row-start-timeout' } })
    // Bounded by the deadline plus scheduling slack, not by the plugin: the cleanup that would wait
    // on the stuck fiber is left running in the background.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('still assembles a healthy tree within the startup deadline', async () => {
    const row = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      { startTimeoutMs: 5000 },
      { bootRows: [row], builtinClaims: [{ row, entry: normalizePluginExport(() => {}) }] },
    )
    try {
      expect(assembled.pluginTree.tree.fiber(row.id)?.state).toBe(FiberState.ACTIVE)
    } finally {
      await assembled.close()
    }
  })

  it('keeps builtin factory, root, authority and exact extras outside the external importer', async () => {
    let exposed: object | undefined
    const pluginImporter: HostPluginImporterFactory = (thirdParty) => {
      exposed = thirdParty
      return async () => undefined
    }
    const assembled = await assembleOrdinaryPluginTree(
      { pluginImporter },
      { exactExtras: { verify: vi.fn() } },
    )
    try {
      expect(exposed).toEqual({
        bindExtras: expect.any(Function),
        verifyAndCreate: expect.any(Function),
      })
      expect(exposed).not.toHaveProperty('builtin')
      expect(exposed).not.toHaveProperty('root')
      expect(exposed).not.toHaveProperty('authority')
      expect(exposed).not.toHaveProperty('exactExtras')
    } finally {
      await assembled.close()
    }
  })

  it('verifies a third-party seam snapshot and attaches Host-private extras without exposing them', async () => {
    const seamInit = Object.freeze({ owner: '@enterprise/approval' })
    const observed = vi.fn()
    const exported = Object.assign(
      (ctx: Context) => {
        observed(ctx.get('host:seam-init' as never))
        return ctx.provide('seam:approval', Object.freeze({ ask: vi.fn() }))
      },
      { inject: ['host:seam-init'], provide: 'seam:approval' },
    )
    const entry = normalizePluginExport(exported)
    const row = createPluginRow({
      id: 'seam:approval',
      plugin: '@enterprise/approval@snapshot-1/default',
      snapshotDigest: 'sha256-enterprise-approval',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'host-extra-1',
      mountRevision: 'mount-1',
      inject: ['host:seam-init'],
      provides: ['seam:approval'],
    })
    const snapshots: PackageSnapshotVerifier = {
      verify: vi.fn(async () => ({
        packageId: '@enterprise/approval',
        snapshotId: 'snapshot-1',
        generation: 1,
        digest: 'sha256-enterprise-approval',
        exports: ['default'],
        trusted: true,
      })),
    }
    let importerMounts: Parameters<HostPluginImporterFactory>[0] | undefined
    const pluginImporter: HostPluginImporterFactory = (mounts) => {
      importerMounts = mounts
      return async (candidate) => {
        if (candidate.id !== row.id) return undefined
        return mounts.verifyAndCreate({
          row: candidate,
          entry,
          snapshot: {
            packageId: '@enterprise/approval',
            snapshotId: 'snapshot-1',
            exportName: 'default',
            generation: 1,
          },
        })
      }
    }
    const extras = Object.freeze({
      slot: row.id,
      revision: row.extrasRevision,
      values: Object.freeze({ 'host:seam-init': seamInit }),
    })
    const assembled = await assembleOrdinaryPluginTree(
      { pluginImporter, snapshots },
      {
        bootRows: [row],
        requiredRowIds: [row.id],
        thirdPartyExtras: { [row.id]: extras },
        exactExtras: {
          verify: ({ row: candidate, slot, revision }) => {
            expect(candidate).toEqual(row)
            expect(slot).toBe(row.id)
            expect(revision).toBe(row.extrasRevision)
            return extras.values
          },
        },
      },
    )
    try {
      expect(snapshots.verify).toHaveBeenCalledOnce()
      expect(observed).toHaveBeenCalledWith(seamInit)
      expect(importerMounts).not.toHaveProperty('snapshots')
      expect(importerMounts).not.toHaveProperty('exactExtras')
    } finally {
      await assembled.close()
    }
  })

  it('uses Host-private exact extras when mounting a builtin claim', async () => {
    const seam = Object.freeze({ name: 'test-seam' })
    const observed = vi.fn()
    const plugin = Object.assign(
      (ctx: Context) => {
        observed(ctx.get('host:seam-init' as never))
      },
      { inject: ['host:seam-init'] },
    )
    const row = createPluginRow({
      id: 'host:exact-extra',
      plugin: 'builtin:exact-extra',
      snapshotDigest: 'builtin:exact-extra',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'seam-init-1',
      mountRevision: 'mount-1',
      inject: ['host:seam-init'],
    })
    const verify = vi.fn(({ slot, values }) => {
      expect(slot).toBe('host:seam-init')
      return values
    })
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [row],
        builtinClaims: [
          {
            row,
            entry: normalizePluginExport(plugin),
            extras: {
              slot: 'host:seam-init',
              revision: 'seam-init-1',
              values: { 'host:seam-init': seam },
            },
          },
        ],
        exactExtras: { verify },
      },
    )
    try {
      expect(verify).toHaveBeenCalledOnce()
      expect(observed).toHaveBeenCalledWith(seam)
    } finally {
      await assembled.close()
    }
  })

  it('does not let a removed builtin claim capture a third-party replacement row', async () => {
    const provide = 'seam:approval'
    const builtinApplied = vi.fn()
    const builtinDisposed = vi.fn()
    const builtin = Object.assign(
      (ctx: Context) => {
        builtinApplied()
        ctx.effect(() => builtinDisposed)
      },
      { provide },
    )
    const builtinDesired = createPluginRow({
      id: 'seam:approval',
      plugin: 'builtin:approval',
      snapshotDigest: 'builtin:approval',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
      provides: [provide],
    })
    const imported = vi.fn(async () => undefined)
    const assembled = await assembleOrdinaryPluginTree(
      { pluginImporter: () => imported },
      {
        bootRows: [builtinDesired],
        builtinClaims: [{ row: builtinDesired, entry: normalizePluginExport(builtin) }],
      },
    )
    try {
      await assembled.pluginTree.applyRows([])
      expect(builtinDisposed).toHaveBeenCalledOnce()

      const replacement = createPluginRow({
        id: builtinDesired.id,
        plugin: '@enterprise/approval@snapshot-1/default',
        snapshotDigest: 'sha256-enterprise-approval',
        exportName: 'default',
        entryRevision: 'entry-1',
        extrasRevision: 'none',
        mountRevision: 'mount-1',
        provides: [provide],
      })
      await expect(assembled.pluginTree.applyRows([replacement])).rejects.toMatchObject({
        code: 'E_ROW_IMPORT',
      })
      expect(imported).toHaveBeenLastCalledWith(replacement)
      expect(builtinApplied).toHaveBeenCalledOnce()
      expect(assembled.pluginTree.currentRows()).toEqual([])
    } finally {
      await assembled.close()
    }
  })

  it('runs the private invalidation hook after every attempted public reconciliation', async () => {
    const afterApply = vi.fn()
    const assembled = await assembleOrdinaryPluginTree({}, { afterApply })
    try {
      expect(afterApply).not.toHaveBeenCalled()
      await assembled.pluginTree.applyRows([])
      expect(afterApply).toHaveBeenCalledOnce()

      await expect(assembled.pluginTree.applyRows([builtinRow()])).rejects.toMatchObject({
        code: 'E_ROW_IMPORT',
      })
      expect(afterApply).toHaveBeenCalledTimes(2)
    } finally {
      await assembled.close()
    }
  })

  it('rejects duplicate builtin claims before running a plugin', async () => {
    const applied = vi.fn()
    const row = builtinRow()
    const claim = { row, entry: normalizePluginExport(applied) }
    await expect(
      assembleOrdinaryPluginTree({}, { bootRows: [row], builtinClaims: [claim, claim] }),
    ).rejects.toThrow(/duplicate builtin claim.*host:test-seam/i)
    expect(applied).not.toHaveBeenCalled()
  })

  it('rejects a builtin claim whose complete row does not match its boot row', async () => {
    const applied = vi.fn()
    const claimed = builtinRow({ value: 1 })
    const desired = builtinRow({ value: 2 })
    await expect(
      assembleOrdinaryPluginTree(
        {},
        {
          bootRows: [desired],
          builtinClaims: [{ row: claimed, entry: normalizePluginExport(applied) }],
        },
      ),
    ).rejects.toThrow(/builtin claim.*host:test-seam.*boot row/i)
    expect(applied).not.toHaveBeenCalled()
  })

  it('accepts only frozen builder rows carrying their own mount identity', async () => {
    const assembled = await assembleOrdinaryPluginTree()
    try {
      const built = builtinRow()
      const unfrozen = { ...built } as Readonly<EntryRow>
      await expect(assembled.pluginTree.applyRows([unfrozen])).rejects.toThrow(/trusted row builder/i)

      const { mountIdentity, ...rest } = built
      const inherited = Object.freeze(
        Object.assign(Object.create({ mountIdentity }), rest),
      ) as Readonly<EntryRow>
      await expect(assembled.pluginTree.applyRows([inherited])).rejects.toThrow(/mountIdentity/i)

      for (const id of ['seam:platform', 'seam:sandbox']) {
        const staticRow = Object.freeze({ ...built, id }) as Readonly<EntryRow>
        await expect(assembled.pluginTree.applyRows([staticRow])).rejects.toMatchObject({
          code: 'E_STATIC_COMPONENT',
        })
      }
      for (const provided of ['seam:platform', 'seam:sandbox']) {
        const staticRow = Object.freeze({
          ...built,
          id: 'extension:static-escape',
          provides: Object.freeze([provided]),
        }) as Readonly<EntryRow>
        await expect(assembled.pluginTree.applyRows([staticRow])).rejects.toMatchObject({
          code: 'E_STATIC_COMPONENT',
        })
      }
      expect(assembled.pluginTree.currentRows()).toEqual([])
    } finally {
      await assembled.close()
    }
  })

  it('does not expose mutable config references through boot or current row snapshots', async () => {
    const source = { nested: { value: 1 } }
    const row = builtinRow(source)
    const applied = vi.fn()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      { bootRows: [row], builtinClaims: [{ row, entry: normalizePluginExport(applied) }] },
    )
    try {
      source.nested.value = 2
      const bootConfig = assembled.pluginTree.bootRows[0]?.config as {
        nested: { value: number }
      }
      const current = assembled.pluginTree.currentRows()
      const currentConfig = current[0]?.config as { nested: { value: number } }
      expect(bootConfig.nested.value).toBe(1)
      expect(currentConfig.nested.value).toBe(1)
      expect(Object.isFrozen(bootConfig.nested)).toBe(true)
      expect(Object.isFrozen(currentConfig.nested)).toBe(true)
      expect(() => {
        currentConfig.nested.value = 3
      }).toThrow()
      expect(assembled.pluginTree.currentRows()[0]?.config).toEqual({ nested: { value: 1 } })
      await assembled.pluginTree.applyRows(current)
      expect(applied).toHaveBeenCalledOnce()
    } finally {
      await assembled.close()
    }
  })

  it('accepts the same runtime skill from the next tree before the previous tree closes', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillContribution = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 'session' })
      return read.ok ? read.content : undefined
    }
    const mount = (body: string) => {
      const row = builtinRow()
      return assembleOrdinaryPluginTree(
        {},
        {
          bootRows: [row],
          builtinClaims: [
            {
              row,
              entry: normalizePluginExport((ctx: Context) => {
                ctx.skills.register({ name: 'handoff', description: 'Handoff', body })
              }),
            },
          ],
          skillContribution,
        },
      )
    }
    const previous = await mount('old')
    expect(readyBody()).toBe('old')
    const next = await mount('new')
    expect(readyBody()).toBeDefined()
    await previous.close()
    expect(readyBody()).toBe('new')
    await next.close()
    expect(readyBody()).toBeUndefined()
  })

  it('keeps the live runtime skill when the replacement tree is aborted', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillContribution = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 'session' })
      return read.ok ? read.content : undefined
    }
    const mount = (body: string) => {
      const row = builtinRow()
      return assembleOrdinaryPluginTree(
        {},
        {
          bootRows: [row],
          builtinClaims: [
            {
              row,
              entry: normalizePluginExport((ctx: Context) => {
                ctx.skills.register({ name: 'handoff', description: 'Handoff', body })
              }),
            },
          ],
          skillContribution,
        },
      )
    }
    const live = await mount('old')
    const aborted = await mount('new')
    await aborted.close()
    expect(readyBody()).toBe('old')
    await live.close()
    expect(readyBody()).toBeUndefined()
  })

  it('replaces a live row with the same runtime skill after the old fiber unmounts', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillContribution = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 'session' })
      return read.ok ? read.content : undefined
    }
    const previousEntry = normalizePluginExport((ctx: Context) => {
      ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'old' })
    })
    const previousRow = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [previousRow],
        builtinClaims: [{ row: previousRow, entry: previousEntry }],
        skillContribution,
      },
    )
    try {
      expect(readyBody()).toBe('old')
      const nextRow = createPluginRow({
        id: 'host:test-seam',
        plugin: 'builtin:test-seam',
        snapshotDigest: 'builtin:test-seam',
        exportName: 'default',
        entryRevision: 'entry-2',
        extrasRevision: 'none',
        mountRevision: 'mount-2',
      })
      let visibleWhileMounting = 0
      if (!assembled.pluginTree.prepareRows || !assembled.pluginTree.applyPreparedRows) {
        throw new Error('expected Host transaction adapter')
      }
      // The old generation is unmounted before the new one mounts (the old fiber would otherwise
      // strip the old row's registrations while the new one is still live) — the replacement's
      // claim is added on top of the boot claim through the additive per-delivery `builtinClaims`
      // option, not the destructive `replaceBuiltinClaims`, since compensation on a failed mount
      // must still be able to re-import the row it is restoring.
      const prepared = await assembled.pluginTree.prepareRows([nextRow], {
        builtinClaims: [
          {
            row: nextRow,
            entry: normalizePluginExport((ctx: Context) => {
              ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'new' })
              visibleWhileMounting = seen.list().filter((item) => item.name === 'handoff').length
            }),
          },
        ],
      })
      expect(readyBody()).toBe('old')
      await assembled.pluginTree.applyPreparedRows(prepared)
      expect(visibleWhileMounting).toBe(1)
      expect(assembled.pluginTree.currentRows().map((row) => row.mountRevision)).toEqual(['mount-2'])
      expect(readyBody()).toBe('new')
    } finally {
      await assembled.close()
    }
    expect(readyBody()).toBeUndefined()
  })

  it('keeps the previous row body when the replacement fiber aborts after registering', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillContribution = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 'session' })
      return read.ok ? read.content : undefined
    }
    const previousEntry = normalizePluginExport((ctx: Context) => {
      ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'old' })
    })
    const previousRow = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [previousRow],
        builtinClaims: [{ row: previousRow, entry: previousEntry }],
        skillContribution,
      },
    )
    try {
      const nextRow = createPluginRow({
        id: 'host:test-seam',
        plugin: 'builtin:test-seam',
        snapshotDigest: 'builtin:test-seam',
        exportName: 'default',
        entryRevision: 'entry-abort',
        extrasRevision: 'none',
        mountRevision: 'mount-abort',
      })
      let visibleWhileMounting = 0
      if (!assembled.pluginTree.prepareRows || !assembled.pluginTree.applyPreparedRows) {
        throw new Error('expected Host transaction adapter')
      }
      // The additive `builtinClaims` option keeps the boot claim for `previousRow` alongside the
      // new one, so compensation can still re-import the old row through the default importer once
      // the new fiber aborts — the destructive `replaceBuiltinClaims` would drop that claim before
      // compensation ever needs it, turning a compensated failure into an unrecoverable one.
      const prepared = await assembled.pluginTree.prepareRows([nextRow], {
        builtinClaims: [
          {
            row: nextRow,
            entry: normalizePluginExport((ctx: Context) => {
              ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'new' })
              visibleWhileMounting = seen.list().filter((item) => item.name === 'handoff').length
              throw new Error('replacement aborted')
            }),
          },
        ],
      })
      await expect(assembled.pluginTree.applyPreparedRows(prepared)).rejects.toMatchObject({
        code: 'E_ROW_TRANSACTION',
        cause: expect.objectContaining({ message: 'replacement aborted' }),
      })
      expect(visibleWhileMounting).toBe(1)
      expect(assembled.pluginTree.currentRows().map((row) => row.mountRevision)).toEqual(['mount-1'])
      expect(readyBody()).toBe('old')
    } finally {
      await assembled.close()
    }
  })

  it('fails a second row on the same tree that repeats a runtime skill', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillContribution = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 'session' })
      return read.ok ? read.content : undefined
    }
    const previousEntry = normalizePluginExport((ctx: Context) => {
      ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'old' })
    })
    const previousRow = builtinRow()
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [previousRow],
        builtinClaims: [{ row: previousRow, entry: previousEntry }],
        skillContribution,
      },
    )
    try {
      const otherRow = createPluginRow({
        id: 'host:other-seam',
        plugin: 'builtin:other-seam',
        snapshotDigest: 'builtin:other-seam',
        exportName: 'default',
        entryRevision: 'entry-other',
        extrasRevision: 'none',
        mountRevision: 'mount-other',
      })
      assembled.replaceBuiltinClaims([
        { row: previousRow, entry: previousEntry },
        {
          row: otherRow,
          entry: normalizePluginExport((ctx: Context) => {
            ctx.skills.register({ name: 'handoff', description: 'Handoff', body: 'other' })
          }),
        },
      ])
      await expect(assembled.pluginTree.applyRows([previousRow, otherRow])).rejects.toThrow(
        'runtime skill name already registered',
      )
      expect(assembled.pluginTree.currentRows().map((row) => row.id)).toEqual(['host:test-seam'])
      expect(readyBody()).toBe('old')
    } finally {
      await assembled.close()
    }
  })

  it('shows an apply-time ctx.skills registration on the consumer snapshot', async () => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const skillResources = registry.snapshot()
    const row = builtinRow()
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.skills.register({ name: 'from-tree', description: 'Visible to the session', body: 'tree body' })
    })
    const assembled = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [row],
        builtinClaims: [{ row, entry }],
        skillContribution: createSkillCordisService(registry),
      },
    )
    try {
      const listed = skillResources.list()
      expect(listed).toMatchObject([
        { name: 'from-tree', actual: 'ready', trust: 'trusted', desired: 'enabled', priority: 450 },
      ])
      const resourceId = listed[0]?.resourceId
      expect(resourceId).toBeTruthy()
      expect(skillResources.read(resourceId ?? '', { sessionKey: 'session' })).toEqual(
        expect.objectContaining({
          ok: true,
          content: 'tree body',
        }),
      )
    } finally {
      await assembled.close()
    }
    expect(skillResources.list()).toEqual([])
  })
})

describe('ordinary tree transactions across deliveries', () => {
  function lateRow(revision = 'mount-1') {
    return createPluginRow({
      id: 'ext:agnes/late',
      plugin: 'builtin:late',
      snapshotDigest: 'builtin:late',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: revision,
    })
  }

  it('a builtin row added after the tree was built mounts through the transaction', async () => {
    const assembled = await assembleOrdinaryPluginTree({}, { bootRows: [], builtinClaims: [] })
    try {
      const row = lateRow()
      const claim = { row, entry: normalizePluginExport(() => {}) }
      const tree = assembled.pluginTree
      const prepared = await tree.prepareRows?.([row], { builtinClaims: [claim] })
      if (!prepared) throw new Error('transactions are not supported')
      await tree.applyPreparedRows?.(prepared)
      expect(tree.currentRows().map((r) => r.id)).toEqual(['ext:agnes/late'])
    } finally {
      await assembled.close()
    }
  })

  it('a failed replace of a builtin row remounts the old identity from the earlier claim', async () => {
    const old = lateRow('mount-1')
    const assembled = await assembleOrdinaryPluginTree(
      {},
      { bootRows: [old], builtinClaims: [{ row: old, entry: normalizePluginExport(() => {}) }] },
    )
    try {
      const next = lateRow('mount-2')
      const failing = normalizePluginExport(() => {
        throw new Error('new builtin does not start')
      })
      const tree = assembled.pluginTree
      const prepared = await tree.prepareRows?.([next], { builtinClaims: [{ row: next, entry: failing }] })
      if (!prepared) throw new Error('transactions are not supported')
      await expect(tree.applyPreparedRows?.(prepared)).rejects.toMatchObject({ code: 'E_ROW_TRANSACTION' })
      tree.rollbackPeriod?.()
      expect(tree.currentRows().map((r) => r.mountRevision)).toEqual(['mount-1'])
    } finally {
      await assembled.close()
    }
  })

  it('commitPeriod keeps only the claims of the last delivery', async () => {
    const old = lateRow('mount-1')
    const assembled = await assembleOrdinaryPluginTree(
      {},
      { bootRows: [old], builtinClaims: [{ row: old, entry: normalizePluginExport(() => {}) }] },
    )
    try {
      const next = lateRow('mount-2')
      const tree = assembled.pluginTree
      const prepared = await tree.prepareRows?.([next], {
        builtinClaims: [{ row: next, entry: normalizePluginExport(() => {}) }],
      })
      if (!prepared) throw new Error('transactions are not supported')
      await tree.applyPreparedRows?.(prepared)
      tree.commitPeriod?.()
      await expect(tree.prepareRows?.([old])).rejects.toMatchObject({ code: 'E_ROW_IMPORT' })
    } finally {
      await assembled.close()
    }
  })
})
