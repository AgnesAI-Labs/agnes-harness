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

  it('uses separate profile and bound-wake methods without a session selector', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/extension.callScoped': () => ({ state: 'approval-required', operationId: 'stable' }),
      '_agnes/v1/extension.readOperation': () => ({ state: 'unknown', operationId: 'stable' }),
      '_agnes/v1/extension.wakes.enqueue': () => ({ state: 'queued', wakeId: 'wake:one' }),
      '_agnes/v1/extension.wakes.read': () => ({ state: 'delivered', wakeId: 'wake:one' }),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal(),
    })
    try {
      expect(
        await client.extensions.callScoped({
          extension: 'example/reports',
          service: 'report.publish',
          input: {},
          operationId: 'stable',
        }),
      ).toMatchObject({ state: 'approval-required' })
      expect(
        await client.extensions.readOperation({
          extension: 'example/reports',
          service: 'report.publish',
          operationId: 'stable',
        }),
      ).toMatchObject({ state: 'unknown' })
      expect(
        await client.extensions.wakes.enqueue({
          target: { bindingId: 'bound' },
          idempotencyKey: 'operation/result',
          event: { name: 'report.done', summary: 'Done' },
        }),
      ).toMatchObject({ state: 'queued' })
      expect(await client.extensions.wakes.read('wake:one')).toMatchObject({ state: 'delivered' })
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
