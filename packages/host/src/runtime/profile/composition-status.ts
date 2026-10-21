import type { PluginGenerationStatus } from '../generation/host.js'
import { mergeGenerationStatus } from '../generation/runtime-descriptor.js'
import type { CompositionContainer } from './composition-selection.js'

/** Merge the inspection of every independently composed session container. */
export function mergeCompositionStatuses(
  statuses: readonly PluginGenerationStatus[],
  containers: Iterable<CompositionContainer>,
  openingFailures: ReadonlyMap<string, string>,
): PluginGenerationStatus {
  const first = statuses[0]
  if (!first) throw new Error('Plugin generation status is unavailable')
  const opened = new Map([...containers].flatMap(({ host }) => [...host.kernel.sessions]))
  const all = new Map<string, PluginGenerationStatus['generations'][number]>()
  for (const status of statuses)
    for (const item of status.generations) {
      const previous = all.get(item.id)
      all.set(item.id, previous ? mergeGenerationStatus(previous, item, opened.values()) : item)
    }
  for (const [id, error] of openingFailures) {
    const generation = all.get(id)
    if (generation) all.set(id, { ...generation, state: 'failed', error })
  }
  const blocked = [
    ...new Map(statuses.flatMap((status) => status.blocked ?? []).map((item) => [item.file, item])).values(),
  ]
  return {
    ...first,
    ...(blocked.length ? { blocked } : {}),
    generations: [...all.values()],
    plugins: [
      ...new Map(
        statuses.flatMap((status) => status.plugins.map((item) => [item.id, item] as const)),
      ).values(),
    ].map((plugin) => {
      if (plugin.state === 'failed' || plugin.state === 'restart-required') return plugin
      const relevant = [...all.values()].filter((generation) =>
        generation.packages.some((pkg) => pkg.id === plugin.id),
      )
      const failed = relevant.find((generation) => generation.state === 'failed')
      return {
        ...plugin,
        ...(failed?.error ? { error: failed.error } : {}),
        state: failed
          ? ('failed' as const)
          : relevant.some((generation) => generation.state === 'active')
            ? ('active' as const)
            : relevant.some((generation) => generation.openSessions > 0)
              ? ('draining' as const)
              : ('historical' as const),
        boundSessions: relevant.reduce((count, generation) => count + generation.boundSessions, 0),
        historicalSessions: relevant.reduce(
          (count, generation) =>
            count +
            (generation.state === 'active'
              ? 0
              : Math.max(0, generation.boundSessions - generation.openSessions)),
          0,
        ),
        drainingSessions: relevant.reduce(
          (count, generation) => count + (generation.state !== 'active' ? generation.boundSessions : 0),
          0,
        ),
      }
    }),
  }
}
