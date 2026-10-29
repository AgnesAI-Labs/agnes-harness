import { setImmediate } from 'node:timers/promises'
import { HostError } from '@agnes/host-common/errors'
import {
  type LoadedRuntimePackage,
  preflightRuntimePackageAsync,
} from '@agnes/host-extensions/assemble/packages'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { AssembleDeps } from './assembly-deps.js'

// Selected from the serial 1/2/4 synthetic measurements; eligibility remains explicitly Host-owned.
export const DEFAULT_RUNTIME_PREPARE_CONCURRENCY = 4

/** Prepare only. Returning input order preserves registration and dependency activation order. */
export async function prepareRuntimeSelection(
  sources: readonly Readonly<RuntimePluginSnapshot>[],
  deps: Pick<AssembleDeps, 'runtimePrepareConcurrency' | 'runtimePrepareIndependent' | 'signal'>,
  profile: string,
  load: (source: Readonly<RuntimePluginSnapshot>) => Promise<LoadedRuntimePackage | undefined>,
): Promise<Map<string, LoadedRuntimePackage>> {
  const limit = deps.runtimePrepareConcurrency ?? DEFAULT_RUNTIME_PREPARE_CONCURRENCY
  if (!Number.isInteger(limit) || limit < 1 || limit > 4)
    throw new HostError('E_EXT_LOAD', 'runtime prepare concurrency must be an integer from 1 to 4', {
      detail: { reason: 'runtime-prepare-concurrency' },
    })
  const packageIds = new Set<string>()
  const rowIds = new Set<string>()
  const metadata: Awaited<ReturnType<typeof preflightRuntimePackageAsync>>[] = []
  for (const source of sources) {
    deps.signal?.throwIfAborted()
    const id = source.snapshot.packageId
    if (packageIds.has(id))
      throw new HostError('E_EXT_LOAD', 'multiple runtime snapshots selected for one package', {
        detail: { package: id, reason: 'duplicate-runtime-snapshot' },
      })
    packageIds.add(id)
    if (!source.trusted || source.snapshot.profile !== profile)
      throw new HostError('E_EXT_LOAD', 'runtime snapshot is not eligible for this profile', {
        detail: { package: id, reason: 'runtime-snapshot-ineligible' },
      })
    const checked = await preflightRuntimePackageAsync(source)
    for (const declaration of checked.declarations) {
      if (rowIds.has(declaration.id))
        throw new HostError('E_PACKAGE_DUPLICATE', 'duplicate runtime plugin row', {
          detail: { row: declaration.id, reason: 'duplicate-runtime-row' },
        })
      rowIds.add(declaration.id)
    }
    metadata.push(checked)
    // Admission stays serial and finishes before any import, without one long synchronous walk.
    await setImmediate()
  }
  // An approval for one immutable snapshot never covers a later update of that package.
  const approved = new Set(
    deps.runtimePrepareIndependent?.map(({ packageId, snapshotId }) => `${packageId}\0${snapshotId}`),
  )
  const connected = new Set<string>()
  const providers = new Map<string, string[]>()
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    const checked = metadata[index]
    if (!source || !checked) continue
    for (const declaration of checked.declarations)
      for (const service of declaration.provide ?? []) {
        const ids = providers.get(service) ?? []
        ids.push(source.snapshot.packageId)
        providers.set(service, ids)
      }
  }
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    const checked = metadata[index]
    if (!source || !checked) continue
    const id = source.snapshot.packageId
    const dependencies = [
      ...checked.dependencyIds,
      ...checked.declarations.flatMap((declaration) =>
        (declaration.inject ?? []).flatMap((service) => providers.get(service) ?? []),
      ),
    ]
    for (const dependency of dependencies)
      if (packageIds.has(dependency)) {
        connected.add(id)
        connected.add(dependency)
      }
  }
  const independent = (source: Readonly<RuntimePluginSnapshot> | undefined) =>
    source !== undefined &&
    approved.has(`${source.snapshot.packageId}\0${source.snapshot.snapshotId}`) &&
    !connected.has(source.snapshot.packageId)
  const prepared = new Map<string, LoadedRuntimePackage>()
  for (let start = 0; start < sources.length; ) {
    deps.signal?.throwIfAborted()
    const first = sources[start]
    if (!first) break
    let end = start + 1
    if (independent(first)) while (end < sources.length && independent(sources[end])) end++
    const batch = sources.slice(start, end)
    const results: (LoadedRuntimePackage | undefined)[] = []
    const failures: { index: number; error: unknown }[] = []
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(limit, batch.length) }, async () => {
        while (!failures.length && !deps.signal?.aborted) {
          const index = next++
          const source = batch[index]
          if (!source) return
          try {
            results[index] = await load(source)
          } catch (error) {
            failures.push({ index, error })
          }
        }
      }),
    )
    failures.sort((a, b) => a.index - b.index)
    if (failures.length === 1) throw failures[0]?.error
    if (failures.length > 1) {
      const error = new HostError('E_EXT_LOAD', 'multiple runtime package prepares failed', {
        detail: {
          reason: 'runtime-prepare-failed',
          packages: failures.map(({ index }) => batch[index]?.snapshot.packageId),
        },
      })
      // Collect every settled failure without publishing raw module errors in public diagnostics.
      Object.defineProperty(error, 'cause', { value: new AggregateError(failures.map(({ error }) => error)) })
      throw error
    }
    deps.signal?.throwIfAborted()
    for (const result of results) if (result) prepared.set(result.source.snapshot.packageId, result)
    start = end
  }
  return prepared
}
