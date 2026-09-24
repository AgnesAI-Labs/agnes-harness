import type { ExtensionFactory } from '@agnes/extension-api'
import type { InstalledPackage } from '@agnes/package-manager'
import { validateExtensionIsolationPolicy } from '@agnes/protocol'
import type { PackageModule, SeamInitContext } from '../assemble/packages.js'
import { HostError } from '../errors.js'
import { readManifestIn } from '../packages/manager.js'
import { startGenericHooksRunner } from './generic-hooks-runner.js'
import {
  type ExtensionIsolationMode,
  type ExtensionIsolationOptions,
  prepareHooksIsolationRuntime,
  startHooksIsolationRunner,
} from './hooks-isolation-assembly.js'
import { isolatedHooksRunnerFactory } from './hooks-isolation-client.js'
import type { createManagedExtHost } from './managed-host.js'

export type ExtensionIsolationServices = {
  prepareRuntime?: typeof prepareHooksIsolationRuntime
  startRunner?: typeof startHooksIsolationRunner
}

// `fail` here is not literally `managed-host`'s method: assemble.ts wraps it to also forward to the
// builtin-row host, which needs the caller's load token (see `SelectFactory` below) to tell a stale
// generation's crash report apart from the one that is current, so the signature carries it too.
type Managed = Pick<ReturnType<typeof createManagedExtHost>, 'setIsolation'> & {
  fail: (id: string, error: unknown, token?: symbol) => Promise<void>
}
type SelectFactory = (
  packageId: string,
  extensionId: string,
  packageDirectory: string,
  extensionDirectory: string,
  /** The caller's load token, threaded through to a crash report so a stale generation cannot be
   *  mistaken for the one it reports against. */
  token?: symbol,
) => Promise<ExtensionFactory | undefined>

export function validateExtensionIsolation(options: ExtensionIsolationOptions | undefined): void {
  if (!options) return
  if (!validateExtensionIsolationPolicy(options).ok)
    throw new HostError('E_EXT_LOAD', 'invalid extension isolation assembly option')
}

/** Select a verified generic Hook entry or the release-owned adapter for each exact extension id. */
export function createExtensionFactorySelector(input: {
  options?: ExtensionIsolationOptions
  services?: ExtensionIsolationServices
  runtimeDirectory: string
  target: string
  modules: ReadonlyMap<string, PackageModule>
  inventory?: ReadonlyMap<string, InstalledPackage>
  contextFor(packageId: string, extensionId: string): SeamInitContext
  managed: Managed
  audit(kind: string, detail: Record<string, unknown>): void
}): SelectFactory {
  let runtime: ReturnType<typeof prepareHooksIsolationRuntime> | undefined
  const audit = (kind: string, detail: Record<string, unknown>): void => {
    try {
      input.audit(kind, detail)
    } catch {
      // Diagnostics cannot change extension lifecycle outcomes.
    }
  }
  const modeFor = (id: string): ExtensionIsolationMode => input.options?.extensions[id] ?? 'off'
  const inProcess = (packageId: string, extensionId: string): ExtensionFactory | undefined =>
    input.modules.get(packageId)?.ecosystem?.[extensionId]?.(input.contextFor(packageId, extensionId))
  return async (packageId, extensionId, packageDirectory, extensionDirectory, token) => {
    const mode = modeFor(extensionId)
    const author =
      input.modules.get(packageId)?.embeddedExtensions?.find((manifest) => manifest.id === extensionId) ??
      readManifestIn(extensionDirectory)
    if (!author || author.id !== extensionId)
      throw new HostError('E_EXT_ISOLATION_UNAVAILABLE', 'extension manifest unavailable')
    const supports = author.runtime?.supports ?? ['in-process']
    const unavailable = (reason: string): never => {
      input.managed.setIsolation(extensionId, { mode, backend: 'unavailable', fallback: false, reason })
      throw new HostError('E_EXT_ISOLATION_UNAVAILABLE', reason)
    }
    if (mode === 'off') {
      if (!supports.includes('in-process'))
        return unavailable('artifact does not support in-process execution')
      input.managed.setIsolation(extensionId, { mode, backend: 'in-process', fallback: false })
      return inProcess(packageId, extensionId)
    }
    const fallback = (reason: string): ExtensionFactory | undefined => {
      if (!supports.includes('in-process'))
        return unavailable('artifact cannot fall back to in-process execution')
      input.managed.setIsolation(extensionId, { mode, backend: 'in-process', fallback: true, reason })
      audit('extension.isolation-fallback', { id: extensionId, package: packageId, reason })
      return inProcess(packageId, extensionId)
    }
    if (!supports.includes('isolated')) {
      if (mode === 'preferred') return fallback('artifact-incompatible')
      return unavailable('artifact does not support isolated execution')
    }
    if (author.capabilities.projections?.length) {
      if (mode === 'preferred') return fallback('projection-in-process-only')
      return unavailable('projection-in-process-only')
    }
    const prepare = input.modules.get(packageId)?.isolatedEcosystem?.[extensionId]
    const generic = input.inventory?.get(packageId)
    const fixed = packageId === '@agnes/base' && extensionId === 'agnes/hooks-runner' && prepare
    if (
      (!fixed && !generic) ||
      (generic && Object.keys(author.capabilities).some((key) => !['hooks', 'events'].includes(key)))
    ) {
      if (mode === 'preferred') return fallback('adapter-unavailable')
      return unavailable('extension adapter unavailable')
    }
    try {
      const backend = input.options?.backend ?? 'auto'
      if (backend !== 'auto' && backend !== 'seatbelt')
        return mode === 'preferred' ? fallback('backend-unavailable') : unavailable('backend unavailable')
      runtime ??= (input.services?.prepareRuntime ?? prepareHooksIsolationRuntime)(
        input.runtimeDirectory,
        input.target,
        backend,
      )
    } catch {
      if (mode === 'preferred') return fallback('backend-unavailable')
      return unavailable('runtime or backend unavailable')
    }
    const preparation = fixed ? await fixed(input.contextFor(packageId, extensionId)) : undefined
    input.managed.setIsolation(extensionId, { mode, backend: runtime.backend, fallback: false })
    return (api) =>
      isolatedHooksRunnerFactory(
        async () => {
          const runner = generic
            ? await startGenericHooksRunner({
                runtime: runtime as NonNullable<typeof runtime>,
                row: generic,
                extensionDirectory,
                manifest: author,
                api,
              })
            : await (input.services?.startRunner ?? startHooksIsolationRunner)({
                preparedRuntime: runtime as NonNullable<typeof runtime>,
                packageDirectory,
                extensionDirectory,
                preparation: preparation as NonNullable<typeof preparation>,
                api,
              })
          input.managed.setIsolation(extensionId, {
            mode,
            backend: runtime?.backend ?? 'seatbelt',
            fallback: false,
            pid: runner.pid,
            protocol: 1,
          })
          audit('extension.isolated', {
            id: extensionId,
            package: packageId,
            backend: runtime?.backend ?? 'seatbelt',
            pid: runner.pid,
            protocol: 1,
          })
          return runner
        },
        (error) => {
          input.managed.fail(extensionId, error, token).catch(() => {
            // A rejection here must not become an unhandled rejection; the caller already has no
            // way to observe or retry this report.
          })
          audit('extension.isolation-failed', {
            id: extensionId,
            package: packageId,
            backend: runtime?.backend ?? 'seatbelt',
            stage: 'runtime',
          })
        },
      )(api)
  }
}
