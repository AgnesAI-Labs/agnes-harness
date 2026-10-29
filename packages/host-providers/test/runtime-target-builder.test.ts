import {
  createPluginRow,
  decodeRuntimeTargetArtifact,
  RESOURCE_OWNED_ROW_IDS,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'

const revision = 'a'.repeat(64)

function row(id: string, plugin = `builtin:host/${id}`) {
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: 'builtin:host:v1',
    exportName: id,
    entryRevision: 'host-row:v1',
    extrasRevision: 'none',
    mountRevision: 'host-row:v1',
  })
}

describe('complete runtime target builder', () => {
  it('builds one canonical artifact from ordinary, static and resource-owned rows', () => {
    const built = buildCompleteRuntimeTarget({
      rows: [
        row('preset:default'),
        row('seam:approval'),
        row('ext:demo'),
        ...RESOURCE_OWNED_ROW_IDS.map((id) => row(id)),
      ],
      resources: { mcp: [{ id: 'server-a' }], skills: { 'skill-a': { name: 'a' } } },
    })
    expect(built.target.tree.rows.map((item) => item.id)).toEqual([
      'ext:demo',
      'preset:default',
      'seam:approval',
    ])
    for (const id of RESOURCE_OWNED_ROW_IDS) expect(built.target.resource.rows[id]?.id).toBe(id)
    expect(built.artifact.digest.startsWith('sha256-')).toBe(true)
    expect(built.artifact.identity.treeHash).toBe(built.target.tree.hash)
    expect(decodeRuntimeTargetArtifact(built.artifact)).toEqual(built.target)
  })

  it.each([...RESOURCE_OWNED_ROW_IDS])('keeps absent resource slot %s null', (id) => {
    const built = buildCompleteRuntimeTarget({
      rows: [row('ext:demo')],
      resources: { mcp: [], skills: {} },
    })
    expect(built.target.resource.rows[id]).toBeNull()
    expect(built.target.tree.rows.map((item) => item.id)).toEqual(['ext:demo'])
  })

  it.each([...RESOURCE_OWNED_ROW_IDS])('records a disabled resource slot for %s', (id) => {
    const disabled = createPluginRow({
      id,
      plugin: `builtin:host/${id}`,
      snapshotDigest: 'builtin:host:v1',
      exportName: id,
      entryRevision: 'host-row:v1',
      extrasRevision: 'none',
      mountRevision: 'host-row:v1',
      disabled: true,
    })
    const built = buildCompleteRuntimeTarget({
      rows: [disabled],
      resources: { mcp: [], skills: {} },
    })
    expect(built.target.resource.rows[id]?.disabled).toBe(true)
    expect(built.target.tree.rows).toEqual([])
  })

  it.each([...RESOURCE_OWNED_ROW_IDS])('enables resource slot %s only on the resource half', (id) => {
    const built = buildCompleteRuntimeTarget({
      rows: [row(id)],
      resources: { mcp: [], skills: {} },
    })
    expect(built.target.resource.rows[id]?.disabled).toBe(false)
    expect(built.target.tree.rows.find((item) => item.id === id)).toBeUndefined()
  })

  it.each([...RESOURCE_OWNED_ROW_IDS])(
    'updates config/plugin/snapshot of %s without placing it on the ordinary tree',
    (id) => {
      const first = buildCompleteRuntimeTarget({
        rows: [row(id)],
        resources: { mcp: [], skills: {} },
      })
      const updated = createPluginRow({
        id,
        plugin: `examples@${revision}/${id}`,
        snapshotDigest: revision,
        exportName: 'updated',
        entryRevision: revision,
        extrasRevision: 'none',
        mountRevision: 'host-row:v2',
        config: { slot: id },
      })
      const second = buildCompleteRuntimeTarget({
        rows: [updated],
        resources: { mcp: [], skills: {} },
      })
      expect(second.target.tree.rows).toEqual([])
      expect(second.target.resource.rows[id]?.id).toBe(id)
      expect(second.target.resource.rows[id]?.plugin).toBe(`examples@${revision}/${id}`)
      expect(second.target.resource.rows[id]?.config).toEqual({ slot: id })
      expect(second.target.resource.rows[id]?.plugin).not.toBe(first.target.resource.rows[id]?.plugin)
      expect(second.artifact.identity.resourceRevision).not.toBe(first.artifact.identity.resourceRevision)
      expect(second.artifact.identity.compositeRevision).not.toBe(first.artifact.identity.compositeRevision)
    },
  )

  it.each([...RESOURCE_OWNED_ROW_IDS])('rejects a duplicate mount of %s', (id) => {
    expect(() =>
      buildCompleteRuntimeTarget({
        rows: [row(id), row(id)],
        resources: { mcp: [], skills: {} },
      }),
    ).toThrow(/duplicate row id/)
  })

  it('does not rebuild identity when the same rows are encoded twice', () => {
    const input = {
      rows: [row('ext:demo')],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }
    const first = buildCompleteRuntimeTarget(input)
    const second = buildCompleteRuntimeTarget(input)
    expect(second.artifact).toEqual(first.artifact)
    expect(second.target).toEqual(first.target)
  })
})
