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
    access: 'key-owner',
    auth: { keySha256: 'a'.repeat(64) },
    host: '127.0.0.1',
    port: 8443,
  },
}

it('discovers only the private publication owner and binds its identity to the service lease', async () => {
  const owner = { extension: 'fixture/cloud', identity: 'activation-1' }
  let projection: { owner?: typeof owner } = {}
  const calls: unknown[] = []
  const client = {
    async call(method: string, input: unknown) {
      calls.push([method, input])
      if (method === '_agnes/v1/clientModules.frontendPublication') return projection
      if (method === '_agnes/v1/extension.callScoped') return { output: lease.publication }
      throw new Error(`unexpected method ${method}`)
    },
  } as unknown as Parameters<typeof readFrontendPublication>[0]
  expect(await readFrontendPublication(client, 'local-dev')).toBeUndefined()
  expect(calls).toEqual([['_agnes/v1/clientModules.frontendPublication', { profile: 'local-dev' }]])
  projection = { owner }
  const published = await readFrontendPublication(client, 'local-dev')
  expect(published?.publication).toEqual(lease.publication)
  expect(calls.slice(1)).toEqual([
    ['_agnes/v1/clientModules.frontendPublication', { profile: 'local-dev' }],
    [
      '_agnes/v1/extension.callScoped',
      { extension: owner.extension, service: 'frontend.publish', input: {} },
    ],
    ['_agnes/v1/clientModules.frontendPublication', { profile: 'local-dev' }],
  ])
  projection = { owner: { ...owner, identity: 'activation-2' } }
  expect((await readFrontendPublication(client, 'local-dev'))?.identity).not.toBe(published?.identity)
})

it.each([
  ['activation changes', { extension: 'fixture/cloud', identity: 'activation-2' }],
  ['extension changes', { extension: 'fixture/replacement', identity: 'activation-1' }],
  ['owner disappears', undefined],
] as const)('discards service output when the %s during the call', async (_scenario, replacement) => {
  let owner: { extension: string; identity: string } | undefined = {
    extension: 'fixture/cloud',
    identity: 'activation-1',
  }
  const client = {
    async call(method: string) {
      if (method === '_agnes/v1/clientModules.frontendPublication') return owner ? { owner } : {}
      if (method === '_agnes/v1/extension.callScoped') {
        owner = replacement
        return { output: lease.publication }
      }
      throw new Error(`unexpected method ${method}`)
    },
  } as unknown as Parameters<typeof readFrontendPublication>[0]
  expect(await readFrontendPublication(client, 'local-dev')).toBeUndefined()
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
