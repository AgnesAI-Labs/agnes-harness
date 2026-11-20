import { expect, it } from 'vitest'
import {
  type PublicationLease,
  readFrontendPublication,
  watchFrontendPublication,
} from './frontend-publication.js'

const lease: PublicationLease = {
  identity: 'current-plugin-1',
  publication: {
    enabled: true,
    access: 'public-owner',
    host: '127.0.0.1',
    port: 8443,
  },
}

it('requires a current ready installed contribution and rejects ambiguous publication owners', async () => {
  const row = {
    rowId: 'web:cloud',
    moduleName: 'fixture/cloud',
    enabled: true,
    phase: 'ready',
    services: ['frontend.publish'],
    extIds: ['fixture/cloud'],
    revision: '1',
  }
  let rows: unknown[] = []
  const client = {
    clientModules: { list: async () => ({ rows }) },
    call: async () => ({ output: lease.publication }),
  } as unknown as Parameters<typeof readFrontendPublication>[0]
  expect(await readFrontendPublication(client, 'local-dev')).toBeUndefined()
  rows = [{ ...row, enabled: false }]
  expect(await readFrontendPublication(client, 'local-dev')).toBeUndefined()
  rows = [{ ...row, phase: 'pending-activation' }]
  expect(await readFrontendPublication(client, 'local-dev')).toBeUndefined()
  rows = [row]
  expect((await readFrontendPublication(client, 'local-dev'))?.publication).toEqual(lease.publication)
  rows = [row, { ...row, rowId: 'web:other' }]
  await expect(readFrontendPublication(client, 'local-dev')).rejects.toThrow('only one')
})

it('starts only for an enabled plugin, revokes an old lease and stops after close', async () => {
  let selected: PublicationLease | undefined
  let current: (() => Promise<boolean>) | undefined
  const live = new Set<string>()
  const watcher = await watchFrontendPublication({
    read: async () => selected,
    open: async (next, gate) => {
      live.add(next.identity)
      current = gate
      return {
        url: 'http://fixture',
        close: async () => {
          live.delete(next.identity)
        },
      }
    },
    intervalMs: 60_000,
  })
  try {
    expect(live.size).toBe(0)
    selected = lease
    await watcher.refresh()
    expect(await current?.()).toBe(true)
    selected = { ...lease, identity: 'replacement' }
    expect(await current?.()).toBe(false)
    await watcher.refresh()
    expect([...live]).toEqual(['replacement'])
    selected = undefined
    expect(await current?.()).toBe(false)
    await watcher.refresh()
    expect(live.size).toBe(0)
  } finally {
    await watcher.close()
  }
  selected = lease
  await watcher.refresh()
  expect(live.size).toBe(0)
})
