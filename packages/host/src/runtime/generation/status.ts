import { relative } from 'node:path'
import type {
  PluginGenerationSnapshot,
  RuntimeGenerationSnapshotStore,
  SessionGenerationPin,
} from '@agnes/package-manager'
import type { Host } from '../lifecycle/host.js'
import { type GenerationFailure, generationFailure } from './failure.js'
import {
  addBasePackageStatus,
  freezeGenerationStatus,
  generationSessions,
  generationStatusSnapshots,
} from './runtime-descriptor.js'

export type PluginGenerationStatus = Readonly<{
  currentGenerationId?: string
  /** Damaged durable records, located relative to the profile directory; collection stands down while any exists. */
  blocked?: readonly Readonly<{ file: string; reason: string }>[]
  generations: readonly Readonly<{
    id: string
    current?: boolean
    state: 'active' | 'draining' | 'historical' | 'failed'
    boundSessions: number
    openSessions: number
    live: boolean
    packages: readonly Readonly<{ id: string; version: string }>[]
    sessions?: readonly Readonly<{ key: string; open: boolean }>[]
    error?: string
  }>[]
  plugins: readonly Readonly<{
    id: string
    state: 'active' | 'draining' | 'historical' | 'restart-required' | 'failed'
    boundSessions: number
    drainingSessions: number
    historicalSessions: number
    error?: string
  }>[]
}>

type Generation = { snapshot: PluginGenerationSnapshot; host: Host }

/** Public status is derived from pins and live holders; it never restores a cold container. */
export function describeGenerationStatus(input: {
  pins: readonly SessionGenerationPin[]
  read: (id: string) => ReturnType<RuntimeGenerationSnapshotStore['describe']>
  failures: ReadonlyMap<string, GenerationFailure>
  live: ReadonlyMap<string, Generation>
  failedSnapshots: ReadonlyMap<string, PluginGenerationSnapshot>
  basePackages: ReadonlySet<string>
  current: Generation | undefined
  initial: Host
  requiresRestart(host: Host, id: string): boolean
  store: RuntimeGenerationSnapshotStore
  profileDir: string
}): PluginGenerationStatus {
  const {
    pins,
    read,
    failures,
    live,
    failedSnapshots,
    basePackages,
    current,
    initial,
    requiresRestart,
    store,
    profileDir,
  } = input
  const errors = new Map(failures)
  const counts = new Map<string, number>()
  const pinsByKey = new Map(pins.map((pin) => [pin.sessionKey, pin.generationId]))
  for (const pin of pins) counts.set(pin.generationId, (counts.get(pin.generationId) ?? 0) + 1)
  const snapshots = generationStatusSnapshots(counts.keys(), live, failedSnapshots, errors, read)
  const active = new Set(current?.snapshot.packages.map((pkg) => pkg.id) ?? [])
  const plugins = new Map<string, PluginGenerationStatus['plugins'][number]>()
  const generations: PluginGenerationStatus['generations'][number][] = []
  for (const [id, snapshot] of snapshots) {
    const boundSessions = counts.get(id) ?? 0
    const extensions = errors.has(id) ? [] : (live.get(id)?.host.extensions() ?? [])
    const retainedFailure =
      id === current?.snapshot.id ? undefined : extensions.find((entry) => entry.error)?.error
    const generationError =
      errors.get(id)?.code ?? (retainedFailure ? generationFailure(retainedFailure).code : undefined)
    const openSessions = [...(live.get(id)?.host.kernel.sessions.values() ?? [])].filter(
      (session) => pinsByKey.get(session.key) === id,
    ).length
    generations.push({
      id,
      current: id === current?.snapshot.id,
      state: generationError
        ? 'failed'
        : id === current?.snapshot.id
          ? 'active'
          : openSessions > 0
            ? 'draining'
            : 'historical',
      ...(generationError ? { error: generationError } : {}),
      boundSessions,
      openSessions,
      live: live.has(id),
      packages: snapshot.packages,
      sessions: generationSessions(pins, id, (key) => !!live.get(id)?.host.kernel.get(key)),
    })
    for (const pkg of snapshot.packages) {
      const packageId = pkg.id,
        previous = plugins.get(packageId)
      const failed = errors.has(id)
        ? undefined
        : extensions.find((entry) => entry.package === packageId && entry.error)
      // Plugin readiness describes the current head. Retained failures remain
      // attached to their generation and must not poison a healthy replacement.
      const error =
        id === current?.snapshot.id
          ? (failed?.error ? generationFailure(failed.error) : errors.get(id))?.code
          : previous?.error
      plugins.set(packageId, {
        id: packageId,
        state: error
          ? 'failed'
          : requiresRestart(current?.host ?? initial, packageId)
            ? 'restart-required'
            : active.has(packageId)
              ? 'active'
              : openSessions > 0 || previous?.state === 'draining'
                ? 'draining'
                : 'historical',
        boundSessions: (previous?.boundSessions ?? 0) + boundSessions,
        drainingSessions:
          (previous?.drainingSessions ?? 0) + (id === current?.snapshot.id ? 0 : boundSessions),
        historicalSessions:
          (previous?.historicalSessions ?? 0) +
          (id === current?.snapshot.id ? 0 : Math.max(0, boundSessions - openSessions)),
        ...(error ? { error } : {}),
      })
    }
  }
  addBasePackageStatus(plugins, basePackages, pins.length)
  for (const [id, error] of errors) {
    if (snapshots.has(id)) continue
    generations.push({
      id,
      state: 'failed',
      boundSessions: counts.get(id) ?? 0,
      openSessions: 0,
      live: false,
      packages: [],
      error: error.code,
    })
  }
  const blocked = store.scanDamage().map((problem) => ({
    file: relative(profileDir, problem.file),
    reason: problem.reason.slice(0, 512),
  }))
  return freezeGenerationStatus({
    ...(current ? { currentGenerationId: current.snapshot.id } : {}),
    ...(blocked.length ? { blocked } : {}),
    generations,
    plugins: [...plugins.values()],
  })
}
