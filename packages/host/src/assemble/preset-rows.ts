import type { Context } from '@agnes/cordis'
import { createPluginRow, EMPTY_EXTRAS_REVISION, normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { PresetDoc } from '../presets/types.js'
import type { HostBuiltinRowClaim } from './seams-cordis.js'

const PRESET_ROW_REVISION = 'host-preset-row:v1'
const PRESET_SNAPSHOT = 'builtin:host-presets:v1'

const presetConfig = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'agnes-host',
    validate(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'preset must be an object' }] }
      }
      if (typeof (value as { name?: unknown }).name !== 'string') {
        return { issues: [{ message: 'preset name must be a string', path: ['name'] }] }
      }
      return { value: value as PresetDoc }
    },
  }),
})

export type BuiltPresetRows = Readonly<{
  rows: readonly ReturnType<typeof createPluginRow>[]
  builtinClaims: readonly Readonly<HostBuiltinRowClaim>[]
}>

/** Publish package preset documents as ordinary data rows for the later session-overlay phase. */
export function buildPresetRows(presets: Readonly<Record<string, PresetDoc>>): BuiltPresetRows {
  const rows: ReturnType<typeof createPluginRow>[] = []
  const builtinClaims: HostBuiltinRowClaim[] = []
  for (const name of Object.keys(presets).sort()) {
    const id = `preset:${name}`
    const config = presets[name]
    if (!config) continue
    const plugin = Object.assign(
      (ctx: Context, value: PresetDoc) => ctx.provide(id, Object.freeze({ ...value })),
      { Config: presetConfig, provide: id },
    )
    const entry = normalizePluginExport(plugin)
    const row = createPluginRow({
      id,
      plugin: `builtin:host/preset/${name}`,
      snapshotDigest: PRESET_SNAPSHOT,
      exportName: name,
      entryRevision: PRESET_ROW_REVISION,
      extrasRevision: EMPTY_EXTRAS_REVISION,
      mountRevision: PRESET_ROW_REVISION,
      config,
      provides: [id],
    })
    rows.push(row)
    builtinClaims.push(Object.freeze({ row, entry }))
  }
  return Object.freeze({ rows: Object.freeze(rows), builtinClaims: Object.freeze(builtinClaims) })
}
