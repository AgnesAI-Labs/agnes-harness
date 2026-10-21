import type { EntryRow, RuntimeConvergenceReport } from '@agnes/plugin-runtime/host'
import type { Host } from './host.js'
import { HOST_MEMBER_SCOPES, type HostFacadeOverrides, memberScope } from './host-routing.js'

const sources = new WeakMap<Host, () => Host>()
const executionRows = new WeakMap<Host, () => readonly Readonly<EntryRow>[]>()

/** Host-private execution evidence; published targets omit static rows merged at mount time. */
export function registerHostExecutionRows(host: Host, rows: () => readonly Readonly<EntryRow>[]): void {
  executionRows.set(host, rows)
}

export function hostExecutionRows(host: Host): readonly Readonly<EntryRow>[] | undefined {
  return executionRows.get(hostInspectionSource(host))?.()
}

/** Only Host-created facades may expose their owning object to descriptor-based inspection. */
export function hostInspectionSource(host: Host): Host {
  const seen = new Set<Host>()
  while (sources.has(host) && !seen.has(host)) {
    seen.add(host)
    host = sources.get(host)!()
  }
  return host
}

/** Overrides own their properties, including replacements by embedders and instrumentation. */
export function createHostFacade(base: Host, overrides: HostFacadeOverrides, current = () => base): Host {
  const facade = new Proxy(base, {
    get(_target, property) {
      const scope = memberScope(HOST_MEMBER_SCOPES, property, base, overrides, current())
      if (!scope) return undefined
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property)
      if (scope === 'session')
        throw new Error(`E_HOST_SESSION_ROUTE: ${String(property)} requires an explicit binding owner`)
      const target = current(),
        value = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            const target = current()
            return Reflect.apply(Reflect.get(target, property, target), target, args)
          }
        : value
    },
    set(target, property, value) {
      return Object.hasOwn(overrides, property)
        ? Reflect.set(overrides, property, value)
        : Reflect.set(target, property, value, target)
    },
    defineProperty(target, property, descriptor) {
      return Reflect.defineProperty(
        Object.hasOwn(overrides, property) ? overrides : target,
        property,
        descriptor,
      )
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(
        Object.hasOwn(overrides, property) ? overrides : target,
        property,
      )
    },
  })
  sources.set(facade, current)
  return facade
}

/** Publication may converge independently across compositions; retry the same desired input. */
export type HostPublicationReport = Readonly<{
  operation: 'runtime-target' | 'skills' | 'models' | 'extension-rows'
  ok: boolean
  recovery: 'retry-same-input'
  containers: readonly Readonly<{
    compositionHash: string
    status: 'applied' | 'failed'
    error?: string
  }>[]
}>
export type HostConvergenceReport = RuntimeConvergenceReport & { publication?: HostPublicationReport }

export class HostPublicationError extends Error {
  constructor(readonly report: HostPublicationReport) {
    super(
      `E_COMPOSITION_PUBLICATION: ${report.operation} applied to ${report.containers.filter((row) => row.status === 'applied').length}/${report.containers.length} containers; retry the same input; ${report.containers
        .filter((row) => row.status === 'failed')
        .map((row) => row.error)
        .join('; ')}`,
    )
  }
}

/** Compatibility callers must preserve the partial-success report instead of acknowledging success. */
export function assertHostPublication(report: HostPublicationReport | void): void {
  if (report && !report.ok) throw new HostPublicationError(report)
}
