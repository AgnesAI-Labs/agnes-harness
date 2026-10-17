import type { Context } from '@agnes/cordis'
import {
  type SchedulingBridge,
  type SchedulingService,
  schedulingKind,
  schedulingServiceCapabilities,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { ExtensionServiceHost } from './author-port.js'

export function installSchedulingService(
  host: ExtensionServiceHost,
  root: Context,
  origins: RowOriginLookup | undefined,
  bridge: SchedulingBridge | undefined,
): void {
  host.install(
    root,
    schedulingKind,
    {
      ports: [],
      audience: 'shared',
      services: schedulingServiceCapabilities,
    },
    origins,
  )
  if (!bridge) return
  host.registerOn(
    root,
    schedulingKind,
    {
      id: 'agnes/scheduling',
      version: '1.0.0',
      open(ports): SchedulingService {
        const session = ports.binding.session
        if (!session) throw new Error('scheduling requires an admitted session')
        const call = <T>(operation: Parameters<SchedulingBridge>[1], input: unknown): Promise<T> =>
          bridge(session, operation, input, ports.binding.signal) as Promise<T>
        return {
          list: (input) => call('list', input ?? {}),
          get: (id) => call('get', { id }),
          upsert: (input) => call('upsert', input),
          control: (input) => call('control', input),
          archive: (input) => call('archive', input),
          runs: (id) => call('runs', { id }),
        }
      },
    },
    { owner: 'agnes/scheduling', packageId: '@agnes/host' },
  )
}
