import { describe, expect, it } from 'vitest'
import { createClient } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

describe('Node extension client', () => {
  it('uses the strict named Service contract', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/extension.call': () => ({ output: { answer: 'ok' } }),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal(),
    })
    try {
      await expect(
        client.extensions.call({
          sessionId: 'session-1',
          extension: 'example/service',
          service: 'status.get',
          input: { id: 'one' },
        }),
      ).resolves.toEqual({ output: { answer: 'ok' } })
      expect(endpoint.calls.at(-1)).toMatchObject({
        method: '_agnes/v1/extension.call',
        params: {
          sessionId: 'session-1',
          extension: 'example/service',
          service: 'status.get',
          input: { id: 'one' },
        },
      })
    } finally {
      await client.close()
    }
  })

  it('explicitly acknowledges an effect only after receiving its durable result', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/extension.call': () => ({ output: { created: 'one' } }),
      '_agnes/v1/extension.ack': () => ({}),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal(),
    })
    try {
      await expect(
        client.extensions.call({
          sessionId: 'session-1',
          extension: 'example/service',
          service: 'record.create',
          input: { value: 1 },
          commandId: 'create-1',
        }),
      ).resolves.toEqual({ output: { created: 'one' } })
      expect(endpoint.calls.slice(-2)).toEqual([
        {
          method: '_agnes/v1/extension.call',
          params: {
            sessionId: 'session-1',
            extension: 'example/service',
            service: 'record.create',
            input: { value: 1 },
            commandId: 'create-1',
          },
        },
        {
          method: '_agnes/v1/extension.ack',
          params: { extension: 'example/service', service: 'record.create', commandId: 'create-1' },
        },
      ])
    } finally {
      await client.close()
    }
  })
})
