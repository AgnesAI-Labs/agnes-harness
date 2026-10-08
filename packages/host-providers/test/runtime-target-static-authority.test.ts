import { createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'
import { resolveRuntimeTargetBuiltinClaims } from '../src/runtime-target-static-authority.js'

function row(id: string, plugin = `builtin:host/${id}`) {
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: plugin.startsWith('builtin:') ? 'builtin:host:v1' : `sha256-${'b'.repeat(64)}`,
    exportName: id,
    entryRevision: plugin.startsWith('builtin:') ? 'host-row:v1' : 'snapshot-a',
    extrasRevision: 'none',
    mountRevision: 'host-row:v1',
  })
}

function claim(id: string) {
  const value = row(id)
  return Object.freeze({ row: value, entry: normalizePluginExport(() => undefined) })
}

describe('runtime target static claim authority', () => {
  it('selects Host-private builtin claims and keeps unused default-false claims', () => {
    const preset = claim('preset:default')
    const extra = claim('preset:hidden')
    const target = buildCompleteRuntimeTarget({
      rows: [preset.row, row('ext:third', '@scope/demo@snapshot-a/third')],
      resources: { mcp: [], skills: {} },
    }).target
    const resolved = resolveRuntimeTargetBuiltinClaims(target, [preset, extra])
    expect(resolved.map((item) => item.row.id)).toEqual(['preset:default', 'preset:hidden'])
  })

  it('fails closed instead of synthesizing a third-party snapshot for a missing builtin row', () => {
    const target = buildCompleteRuntimeTarget({
      rows: [row('preset:default')],
      resources: { mcp: [], skills: {} },
    }).target
    expect(() => resolveRuntimeTargetBuiltinClaims(target, [])).toThrow('E_RUNTIME_TARGET_STATIC_CLAIM')
    expect(() => resolveRuntimeTargetBuiltinClaims(target, [claim('preset:other')])).toThrow(
      'E_RUNTIME_TARGET_STATIC_CLAIM',
    )
  })
})
