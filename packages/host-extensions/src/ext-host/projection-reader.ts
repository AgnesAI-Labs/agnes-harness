import { ExtensionError, type ProjectionReader, type ProjectionReadResult } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import type { Lease } from './lease.js'
import type { KernelPorts, RegMeta } from './ports.js'

export function projectionReader(
  port: KernelPorts['projections'],
  meta: RegMeta,
  lease: Lease,
  alive: () => void,
  names: readonly string[],
): ProjectionReader {
  const declared = new Set(names)
  return Object.freeze({
    async readOwn<T extends JsonValue = JsonValue>(name: string): Promise<ProjectionReadResult<T>> {
      alive()
      if (!declared.has(name) || !lease.allows('projection', name))
        throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection not declared')
      try {
        const { asOfSeq, unit } = await port.read(`${meta.source}/${name}`, meta, () => {
          alive()
          if (!lease.allows('projection', name))
            throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'projection not declared')
        })
        alive()
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
