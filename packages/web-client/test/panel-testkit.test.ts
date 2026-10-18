import { expect, it } from 'vitest'
import type { ModuleIdentity } from '../src/index.js'
import { createClientPanelTestHost } from '../testkit/index.js'

it.each([false, true])(
  'closes fixture message channels and restores globals on apply failure=%s',
  async (fail) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel')
    let closed: Promise<unknown> | undefined
    let delivered: Promise<unknown> | undefined
    const identity: ModuleIdentity = {
      packageId: 'panel-test',
      rowId: 'ext:panel-test/main',
      revision: 'one',
      services: [],
      homeEntries: [],
      publicConfig: {},
      binding: {
        owner: 'ext:panel-test/main',
        packageId: 'panel-test',
        lifetime: 'profile',
        availability: 'active',
        integrity: 'one',
        profileId: 'test',
        activationId: 'current',
      },
    }
    const creating = createClientPanelTestHost(
      {
        apply() {
          const channel = new globalThis.MessageChannel()
          closed = new Promise((resolve) => channel.port1.addEventListener('close', resolve, { once: true }))
          delivered = new Promise((resolve) => {
            channel.port1.onmessage = (event) => resolve(event.data)
          })
          channel.port2.postMessage('fixture message')
          if (fail) throw new Error('client failed')
        },
      },
      identity,
      async () => ({ output: {} }),
    )
    if (fail) await expect(creating).rejects.toThrow('client failed')
    else {
      const host = await creating
      try {
        expect(await delivered).toBe('fixture message')
      } finally {
        await host.dispose()
      }
    }
    expect(closed).toBeDefined()
    await closed
    expect(Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel')).toEqual(previous)
  },
)
