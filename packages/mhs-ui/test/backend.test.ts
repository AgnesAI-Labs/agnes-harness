import { Device as DeviceSdk, type Json } from '@agnes/mhs-device'
import { type DeviceLink, Hub, North, type OwnedStore, type StoreTransaction } from '@agnes/mhs-hub'
import { encodeMedia } from '@agnes/mhs-hub/media'
import { expect, it } from 'vitest'
import { MhsClient } from '../src/client.js'
import { sampleFrom } from '../src/media.js'
import { fake } from './fixtures.js'

it('consumes the real SDK declaration, Hub/North query/effect outputs and binary media codec', async () => {
  const rows = new Map<string, { value: Json; revision: string }>()
  let revision = 0
  const store: OwnedStore = {
    async transaction<T>(run: (tx: StoreTransaction) => T): Promise<T> {
      return run({
        get: (key) => rows.get(key),
        put: (key, value, expected) => {
          if ((rows.get(key)?.revision ?? null) !== expected) throw new Error('conflict')
          rows.set(key, { value: structuredClone(value), revision: String(++revision) })
        },
        remove: (key) => {
          rows.delete(key)
        },
      })
    },
    async scan({ prefix, limit, cursor }) {
      const all = [...rows]
          .filter(([key]) => key.startsWith(prefix) && (!cursor || key > cursor))
          .sort(([a], [b]) => a.localeCompare(b)),
        page = all.slice(0, limit)
      return {
        rows: page.map(([key, row]) => ({ key, ...row })),
        ...(page.length < all.length ? { nextCursor: page.at(-1)?.[0] ?? '' } : {}),
      }
    },
  }
  const sdk = new DeviceSdk({
    protocol: 'mhs/v1',
    device: { id: 'sensor-01', kind: 'sensor' },
    state: { lamp: { type: 'boolean', writable: true } },
    sources: [{ id: 'air', kind: 'values', description: 'Air', fields: { temperature: { type: 'number' } } }],
    maps: [{ id: 'site', bounds: [0, 0, 10, 10] }],
  })
  sdk.update({ lamp: false })
  const hub = new Hub({
    store,
    wakes: {
      async enqueue() {
        return { wakeId: 'wake', state: 'queued' }
      },
    },
    authority: {
      async assertActive() {},
      async admit(_subject, context) {
        if (context !== 'synthetic-native-admission') throw new Error('approval-required')
      },
    },
  })
  await hub.recover()
  const link: DeviceLink = {
    registration: sdk.description,
    available: true,
    async request(method, params) {
      if (method === 'mhs/set') {
        const result = sdk.set(params.values as Record<string, Json>)
        hub.state('sensor-01', sdk.state())
        return result
      }
      if (method === 'mhs/configure') return sdk.configure(params)
      if (method === 'mhs/stop') {
        await sdk.stop()
        return {}
      }
      throw new Error('not-used')
    },
    async call() {
      throw new Error('not-used')
    },
    manual() {},
    close() {
      hub.offline('sensor-01', link)
    },
  }
  hub.online(link)
  hub.state('sensor-01', sdk.state())
  const north = new North(hub),
    f = fake()
  f.ports.services.query = (name, input) =>
    north.query(name.replace(/^mhs\./, ''), input as Record<string, unknown>)
  f.ports.services.effect = async (name, input, { operationId }) => ({
    state: 'completed',
    operationId,
    output: (await north.effect(name.replace(/^mhs\./, ''), input as Record<string, unknown>, {
      operationId,
      context: 'synthetic-native-admission',
    })) as Json,
  })
  const client = new MhsClient(f.ports)
  expect((await client.devices())[0]).toMatchObject({ id: 'sensor-01', state: { lamp: false } })
  expect(await client.effect('set', { device: 'sensor-01', values: { lamp: true } })).toMatchObject({
    state: 'completed',
    output: { state: 'terminal', outcome: { status: 'done' } },
  })
  expect((await client.devices())[0]?.state.lamp).toBe(true)
  const decoded = sampleFrom(
    encodeMedia({ device: 'sensor-01', source: 'air', at: 123, data: { temperature: 22 } }),
  )
  expect(decoded).toMatchObject({ device: 'sensor-01', source: 'air', at: 123, data: { temperature: 22 } })
  expect(await client.effect('stop', {})).toMatchObject({ state: 'completed', output: { state: 'settled' } })
  client.dispose()
  await hub.shutdown()
})
