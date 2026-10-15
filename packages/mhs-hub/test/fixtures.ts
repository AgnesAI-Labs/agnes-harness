import { Device, type Json, type Outcome, type Registration } from '@agnes/mhs-device'
import type {
  Authority,
  DeviceLink,
  Hub,
  Invocation,
  OwnedStore,
  StoreRow,
  StoreTransaction,
} from '../src/index.js'

export class MemoryStore implements OwnedStore {
  rows = new Map<string, { value: Json; revision: string }>()
  private sequence = 0
  async transaction<T>(fn: (tx: StoreTransaction) => T): Promise<T> {
    const rows = structuredClone(this.rows)
    const result = fn({
      get: (key) => structuredClone(rows.get(key)),
      put: (key, value, expected) => {
        if ((rows.get(key)?.revision ?? null) !== expected) throw new Error('CAS_CONFLICT')
        rows.set(key, { value: structuredClone(value), revision: String(++this.sequence) })
      },
      remove: (key, expected) => {
        if (rows.get(key)?.revision !== expected) throw new Error('CAS_CONFLICT')
        rows.delete(key)
      },
    })
    this.rows = rows
    return result
  }
  async scan({
    prefix,
    limit,
    cursor,
  }: {
    prefix: string
    limit: number
    cursor?: string
  }): Promise<{ rows: StoreRow[]; nextCursor?: string }> {
    const all = [...this.rows.entries()]
      .filter(([k]) => k.startsWith(prefix) && (!cursor || k > cursor))
      .sort(([a], [b]) => a.localeCompare(b))
    const rows = all.slice(0, limit).map(([key, row]) => ({ key, ...structuredClone(row) }))
    return { rows, ...(all.length > rows.length ? { nextCursor: rows.at(-1)?.key ?? '' } : {}) }
  }
}
export const description: Registration = {
  protocol: 'mhs/v1',
  device: { id: 'rover', kind: 'robot' },
  resources: { drive: 'reject' },
  manual: { axes: [{ id: 'vx', min: -1, max: 1 }], deadman_s: 0.2 },
  state: {
    battery: { type: 'number', alert: { warn: 30, bad: 10, below: true } },
    lamp: { type: 'boolean', writable: true },
  },
  tools: [
    {
      name: 'move',
      description: 'Move forward',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'number', minimum: -2, maximum: 2 } },
        required: ['x'],
      },
      timeout: 2,
      motion: true,
      uses: ['drive'],
    },
  ],
  sources: [
    { id: 'front', kind: 'image', description: 'Front camera' },
    { id: 'video', kind: 'video', description: 'Live video' },
    { id: 'motors', kind: 'values', description: 'Motors' },
  ],
  maps: [{ id: 'test-map', name: 'Test map' }],
}
export const proof = Object.freeze({ native: 'synthetic-host-admission' })
export const authority: Authority = {
  async assertActive() {},
  async admit(_subject, context) {
    if (context !== proof) throw new Error('approval-required')
  },
}
export const invocation = (id: string): Invocation => ({
  operationId: id,
  context: proof,
  sessionId: 's1',
  laneId: 'lane1',
  target: { bindingId: 'bound-s1-lane1' },
})
export function attach(
  hub: Hub,
  options: { result?: Promise<Json>; onStop?: () => void } = {},
): { device: Device; link: DeviceLink } {
  const device = new Device(description, {
    arm() {},
    async stop() {
      options.onStop?.()
    },
  })
  device.onManual = async () => {}
  device.tool('move', async (args) => (options.result ? options.result : args.x))
  const link: DeviceLink = {
    registration: description,
    available: true,
    async request(method, params) {
      if (method === 'mhs/stop') {
        await device.stop()
        return {}
      }
      if (method === 'mhs/set') return device.set(params.values as Record<string, Json>)
      return {}
    },
    async call(id, name, args) {
      const accepted = device.call(id, name, args)
      return {
        accepted: accepted.accepted,
        ...(accepted.reason ? { reason: accepted.reason } : {}),
        result: accepted.result ?? Promise.resolve<Outcome>({ status: 'rejected' }),
      }
    },
    manual(axes) {
      void device.manual(axes).catch(() => {})
    },
    close() {
      void device.disconnect().catch(() => {})
    },
  }
  hub.online(link)
  device.onState = (values) => hub.state('rover', values)
  device.update({ battery: 90, lamp: false })
  return { device, link }
}
