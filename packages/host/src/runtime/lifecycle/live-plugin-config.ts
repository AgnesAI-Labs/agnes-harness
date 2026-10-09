import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import type { PluginRow, RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { HostConvergenceReport } from './host-facade.js'
import { assertHostPublication } from './host-facade.js'

type ConfigHost = {
  runtimeTargetSnapshot?(): RuntimeTarget
  applyRuntimeTarget(target: RuntimeTarget): Promise<HostConvergenceReport | void>
}

/** Only live configuration for the same pinned code may cross a generation boundary. */
export function overlayLivePluginConfig(
  rows: readonly Readonly<PluginRow>[],
  current: RuntimeTarget,
): readonly Readonly<PluginRow>[] {
  const live = new Map(
    current.tree.rows
      .filter(
        (row) =>
          row.configReload === 'live' &&
          row.id !== 'seam:sandbox' &&
          row.id !== 'seam:platform' &&
          !row.id.startsWith('adapter:'),
      )
      .map((row) => [row.id, row]),
  )
  return rows.map((row) => {
    const latest = live.get(row.id)
    return latest && latest.mountIdentity === row.mountIdentity && !latest.disabled && !row.disabled
      ? { ...row, config: latest.config, configReload: 'live' as const }
      : row
  })
}

/** Host apply owns the admission barrier; compensate all previously changed containers on refusal. */
export async function applyLivePluginConfig(
  hosts: Iterable<ConfigHost>,
  current: RuntimeTarget,
): Promise<() => Promise<void>> {
  const changed: { host: ConfigHost; previous: RuntimeTarget }[] = []
  const rollback = async () => {
    const failures: unknown[] = []
    for (const { host, previous } of [...changed].reverse()) {
      try {
        const report = await host.applyRuntimeTarget(previous)
        if (report) {
          assertHostPublication(report.publication)
          if (!report.ok) throw new Error('E_PLUGIN_CONFIG_ROLLBACK')
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Live plugin configuration rollback failed')
  }
  try {
    for (const host of new Set(hosts)) {
      const previous = host.runtimeTargetSnapshot?.()
      if (!previous) continue
      const rows = overlayLivePluginConfig(previous.tree.rows, current)
      if (JSON.stringify(rows) === JSON.stringify(previous.tree.rows)) continue
      changed.push({ host, previous })
      const target = buildCompleteRuntimeTarget({
        rows: [...rows, ...Object.values(previous.resource.rows).flatMap((row) => (row ? [row] : []))],
        resources: previous.resource.resources,
      }).target
      const report = await host.applyRuntimeTarget(target)
      if (report) {
        assertHostPublication(report.publication)
        if (!report.ok) throw new Error('E_PLUGIN_CONFIG_REFUSED')
      }
    }
    return rollback
  } catch (error) {
    await rollback()
    throw error
  }
}
