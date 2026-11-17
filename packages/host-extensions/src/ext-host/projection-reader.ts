import { ExtensionError, type ProjectionReader, type ProjectionReadResult } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import type { Lease } from './lease.js'
import type { KernelPorts, RegMeta } from './ports.js'

export function projectionReader(
  port: KernelPorts['projections'],
  meta: RegMeta,
  lease: Lease,
  alive: () => void,
  names: readonly string[] | (() => readonly string[]),
): ProjectionReader {
  // Installed rows register dynamically; their live host-owned name set replaces a static lease
  // projection scope. Both paths still require the source lease and invocation to be alive.
  const allowed = (name: string) =>
    typeof names === 'function'
      ? names().includes(name)
      : names.includes(name) && lease.allows('projection', name)
  return Object.freeze({
    async readOwn<T extends JsonValue = JsonValue>(name: string): Promise<ProjectionReadResult<T>> {
      alive()
      if (!allowed(name)) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection not declared')
      try {
        const { asOfSeq, unit } = await port.read(`${meta.source}/${name}`, meta, () => {
          alive()
          if (!allowed(name)) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection not declared')
        })
        alive()
        if (!allowed(name)) throw new Error('projection registration expired')
        if ('error' in unit) throw new Error('unavailable')
        const data = inspectJsonData(unit.view === undefined ? unit.state : unit.view, 262144)
        if (!data.ok) throw new Error('unavailable')
        return { status: 'available', name, asOfSeq, stateVersion: unit.stateVersion, value: data.value as T }
      } catch {
        return {
          status: 'unavailable',
          name,
          error: { code: 'E_PROJECTION_STATE', safeMessage: 'projection unavailable' },
        }
      }
    },
  })
}
