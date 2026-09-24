import type { Context } from '@agnes/cordis'
import type { RuntimePluginSnapshot, RuntimeSnapshot } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  normalizePluginExport,
  RESOURCE_OWNED_ROW_IDS,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { assembleOrdinaryPluginTree } from '../src/assemble/seams-cordis.js'
import { RuntimePluginCatalogue } from '../src/runtime-plugin-catalogue.js'
import {
  assembleRuntimeTargetOrdinaryCandidate,
  stageRuntimeTargetOrdinaryCandidate,
} from '../src/runtime-target-assembler.js'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'

const revision = 'a'.repeat(64)

function row(id: string, plugin = `builtin:${id}`) {
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: plugin.startsWith('builtin:') ? plugin : `sha256-${'b'.repeat(64)}`,
    exportName: 'default',
    entryRevision: revision,
    extrasRevision: 'none',
    mountRevision: revision,
  })
}

function target(rows: readonly ReturnType<typeof row>[]) {
  return buildRuntimeTarget({
    rows,
    resourceRevision: revision,
    compositeRevision: revision,
    resources: { mcp: [], skills: {} },
  })
}

function source(packageId: string, snapshotId: string): RuntimePluginSnapshot {
  const snapshot: RuntimeSnapshot = Object.freeze({
    snapshotId,
    profile: 'default',
    packageId,
    version: '1.0.0',
    integrity: `sha256-${'c'.repeat(64)}`,
    treeIntegrity: `sha256-${'d'.repeat(64)}`,
    capabilityHash: revision,
    directory: `/not-imported/${snapshotId}`,
    contributions: Object.freeze([]),
  })
  return Object.freeze({ snapshot, generation: 1, trusted: true })
}

describe('runtime target ordinary candidate assembler', () => {
  it('builds a separate Cordis tree without mutating the live tree', async () => {
    const liveRow = row('ext:live')
    const candidateRow = row('ext:candidate')
    const liveRuns = vi.fn()
    const candidateRuns = vi.fn()
    const live = await assembleOrdinaryPluginTree(
      {},
      { bootRows: [liveRow], builtinClaims: [{ row: liveRow, entry: normalizePluginExport(liveRuns) }] },
    )
    try {
      const candidate = await assembleRuntimeTargetOrdinaryCandidate({
        target: target([candidateRow]),
        catalogue: new RuntimePluginCatalogue([]),
        privateInput: {
          builtinClaims: [{ row: candidateRow, entry: normalizePluginExport(candidateRuns) }],
        },
      })
      try {
        expect(liveRuns).toHaveBeenCalledOnce()
        expect(candidateRuns).toHaveBeenCalledOnce()
        expect(live.pluginTree.root).not.toBe(candidate.pluginTree.root)
        expect(live.pluginTree.currentRows()).toEqual([liveRow])
        expect(candidate.pluginTree.currentRows()).toEqual([candidateRow])
      } finally {
        await candidate.close()
      }
    } finally {
      await live.close()
    }
  })

  it.each([...RESOURCE_OWNED_ROW_IDS])(
    'does not mount resource-owned id %s on the ordinary candidate tree',
    async (id) => {
      const owned = row(id)
      const built = buildCompleteRuntimeTarget({
        rows: [owned],
        resources: { mcp: [], skills: {} },
      })
      const candidate = await assembleRuntimeTargetOrdinaryCandidate({
        target: built.target,
        catalogue: new RuntimePluginCatalogue([]),
      })
      try {
        expect(candidate.pluginTree.currentRows().map((item) => item.id)).not.toContain(id)
        expect(built.target.resource.rows[id]?.id).toBe(id)
      } finally {
        await candidate.close()
      }
    },
  )

  it('selects every referenced snapshot before constructing the ordinary tree', async () => {
    const ordinary = row('ext:ordinary', 'alpha@one/default')
    const resource = row('ext:agnes/skills', 'resources@two/default')
    const importer = vi.fn()
    await expect(
      assembleRuntimeTargetOrdinaryCandidate({
        target: target([ordinary, resource]),
        catalogue: new RuntimePluginCatalogue([source('alpha', 'one')]),
        createPluginImporter: () => {
          importer()
          return () => async () => undefined
        },
      }),
    ).rejects.toThrow('unavailable snapshot resources@two')
    expect(importer).not.toHaveBeenCalled()
  })

  it('closes an unpublished tree on candidate abort', async () => {
    const candidateRow = row('ext:abort')
    const disposed = vi.fn()
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.effect(() => disposed)
    })
    const candidate = await stageRuntimeTargetOrdinaryCandidate({
      target: target([candidateRow]),
      catalogue: new RuntimePluginCatalogue([]),
      privateInput: { builtinClaims: [{ row: candidateRow, entry }] },
    })
    await candidate.abort()
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('keeps Host-static boot rows when the desired ordinary tree is empty', async () => {
    const preset = row('preset:default')
    const extra = row('ext:hot')
    const presetRuns = vi.fn()
    const extraRuns = vi.fn()
    const empty = await assembleRuntimeTargetOrdinaryCandidate({
      target: target([]),
      catalogue: new RuntimePluginCatalogue([]),
      privateInput: {
        bootRows: [preset],
        builtinClaims: [{ row: preset, entry: normalizePluginExport(presetRuns) }],
      },
    })
    try {
      expect(empty.pluginTree.currentRows().map((item) => item.id)).toEqual(['preset:default'])
      expect(presetRuns).toHaveBeenCalledOnce()
    } finally {
      await empty.close()
    }
    const mixed = await assembleRuntimeTargetOrdinaryCandidate({
      target: target([extra]),
      catalogue: new RuntimePluginCatalogue([]),
      privateInput: {
        bootRows: [preset],
        builtinClaims: [
          { row: preset, entry: normalizePluginExport(presetRuns) },
          { row: extra, entry: normalizePluginExport(extraRuns) },
        ],
      },
    })
    try {
      expect(mixed.pluginTree.currentRows().map((item) => item.id)).toEqual(['preset:default', 'ext:hot'])
      expect(extraRuns).toHaveBeenCalledOnce()
    } finally {
      await mixed.close()
    }
  })

  it('leaves a committed tree for old-runtime retirement to close', async () => {
    const candidateRow = row('ext:retire')
    const disposed = vi.fn()
    const entry = normalizePluginExport((ctx: Context) => {
      ctx.effect(() => disposed)
    })
    const candidate = await stageRuntimeTargetOrdinaryCandidate({
      target: target([candidateRow]),
      catalogue: new RuntimePluginCatalogue([]),
      privateInput: { builtinClaims: [{ row: candidateRow, entry }] },
    })
    const assembly = candidate.commit()
    expect(disposed).not.toHaveBeenCalled()
    await assembly.close()
    expect(disposed).toHaveBeenCalledOnce()
  })
})
