import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { buildRuntimeTargetConvergenceReport } from '../src/runtime-target-report.js'

const revision = 'a'.repeat(64)
const ordinary = createPluginRow({
  id: 'examples/ordinary',
  plugin: `examples@${revision}/ordinary`,
  snapshotDigest: revision,
  exportName: 'ordinary',
  entryRevision: revision,
  extrasRevision: 'none',
  mountRevision: 'test',
  inject: [],
  provides: [],
  runtime: 'in-process',
  disabled: false,
})
const resource = createPluginRow({
  id: 'ext:agnes/skills',
  plugin: `examples@${revision}/skills`,
  snapshotDigest: revision,
  exportName: 'skills',
  entryRevision: revision,
  extrasRevision: 'none',
  mountRevision: 'test',
  inject: [],
  provides: [],
  runtime: 'in-process',
  disabled: false,
})

describe('buildRuntimeTargetConvergenceReport', () => {
  it('says why a row that is not active is waiting, and only for such rows', () => {
    const target = buildRuntimeTarget({
      rows: [ordinary],
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    const pending = buildRuntimeTargetConvergenceReport(
      target,
      () => 'pending',
      () => 'waiting for service: db',
    )
    expect(pending.rows.find((row) => row.id === ordinary.id)).toEqual({
      id: ordinary.id,
      state: 'pending',
      reason: 'waiting for service: db',
    })
    // A row that is active carries no reason, whatever the callback would say.
    const active = buildRuntimeTargetConvergenceReport(
      target,
      () => 'active',
      () => 'waiting for service: db',
    )
    expect(active.rows.find((row) => row.id === ordinary.id)).toEqual({ id: ordinary.id, state: 'active' })
    // Nothing to say: no reason key at all, so the report keeps its shape.
    const silent = buildRuntimeTargetConvergenceReport(
      target,
      () => 'pending',
      () => undefined,
    )
    expect(silent.rows.find((row) => row.id === ordinary.id)).toEqual({ id: ordinary.id, state: 'pending' })
  })

  it('reports every ordinary and resource-owned id exactly once', () => {
    const target = buildRuntimeTarget({
      rows: [ordinary, resource],
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    const report = buildRuntimeTargetConvergenceReport(target)
    expect(report.hash).toBe(target.tree.hash)
    expect(report.ok).toBe(true)
    expect(report.rows.map((row) => row.id)).toEqual([
      'examples/ordinary',
      'ext:agnes/mcp-client',
      'ext:agnes/skills',
    ])
    expect(report.rows.find((row) => row.id === 'ext:agnes/skills')).toMatchObject({ state: 'active' })
    expect(report.rows.filter((row) => row.id === 'ext:agnes/skills')).toHaveLength(1)
  })

  it.each(['ext:agnes/skills', 'ext:agnes/mcp-client'])(
    'reports absent resource id %s once as disabled',
    (id) => {
      const target = buildRuntimeTarget({
        rows: [ordinary],
        resourceRevision: 'b'.repeat(64),
        compositeRevision: 'c'.repeat(64),
        resources: { mcp: [], skills: {} },
      })
      const report = buildRuntimeTargetConvergenceReport(target)
      expect(report.rows.filter((row) => row.id === id)).toHaveLength(1)
      expect(report.rows.find((row) => row.id === id)).toMatchObject({ state: 'disabled' })
    },
  )

  it('keeps a candidate ordinary row pending instead of claiming it active', () => {
    const target = buildRuntimeTarget({
      rows: [ordinary],
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    const report = buildRuntimeTargetConvergenceReport(target, () => 'pending')
    expect(report.ok).toBe(false)
    expect(report.rows.find((row) => row.id === ordinary.id)).toMatchObject({ state: 'pending' })
  })
})
