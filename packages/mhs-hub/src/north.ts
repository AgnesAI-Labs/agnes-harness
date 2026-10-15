import { type Json, MhsError, object } from '@agnes/mhs-device'
import type { Hub } from './hub.js'
import type { Invocation } from './ports.js'

/** Service facade. Invocation is supplied by the trusted Host adapter, never the request body. */
export class North {
  constructor(readonly hub: Hub) {}
  async query(method: string, input: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'devices':
        return this.hub.list()
      case 'read': {
        const read = await this.hub.read(
          typeof input.device === 'string' ? input.device : undefined,
          Array.isArray(input.sources) ? input.sources.map(String) : [],
        )
        return { ...read, items: read.items.map(({ bytes: _bytes, ...item }) => item) }
      }
      case 'world':
        return this.hub.world()
      case 'maps':
        return this.hub.maps()
      case 'activity':
        await this.hub.list()
        return this.hub.activity.list(input)
      case 'operation':
        await this.hub.list()
        return this.hub.journal.read(String(input.operationId))
      default:
        throw new MhsError('unknown-query')
    }
  }
  async effect(method: string, input: Record<string, unknown>, invocation: Invocation): Promise<unknown> {
    const device = typeof input.device === 'string' ? input.device : undefined
    switch (method) {
      case 'call':
        return this.hub.call(device, String(input.tool), input.args, invocation)
      case 'set':
        if (!device) throw new MhsError('device-required')
        return this.hub.effect('set', device, object(input.values) as Record<string, Json>, invocation)
      case 'stop':
        await this.hub.list()
        return this.hub.stop(device)
      case 'lease':
        if (!device) throw new MhsError('device-required')
        return this.hub.manualLease(device, invocation)
      case 'watch': {
        const devices = await this.hub.list()
        const picked =
          device ??
          (devices.filter((d) => d.available).length === 1 ? devices.find((d) => d.available)?.id : undefined)
        if (!picked || !devices.some((d) => d.id === picked)) throw new MhsError('device-required')
        return this.hub.watches.create(
          picked,
          object(input.until) as Record<string, Json>,
          typeof input.timeout === 'number' ? input.timeout : 600,
          invocation,
          typeof input.note === 'string' ? input.note : undefined,
        )
      }
      case 'unwatch':
        await this.hub.list()
        return this.hub.watches.cancel(String(input.watch), invocation)
      case 'configure':
      case 'resume':
      case 'cancel':
        if (!device) throw new MhsError('device-required')
        return this.hub.effect(method, device, object(input.params ?? {}) as Record<string, Json>, invocation)
      default:
        throw new MhsError('unknown-effect')
    }
  }
}
