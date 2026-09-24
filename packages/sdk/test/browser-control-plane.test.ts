import { expect, it } from 'vitest'
import { createClient } from '../src/index.browser.js'

it('rejects raw admin and Extension Service calls from the browser client before connecting', async () => {
  const client = createClient({ transport: { kind: 'ws', url: 'ws://127.0.0.1/unused' } })
  await expect(client.call('_agnes/v1/packages.list', { profile: 'local-dev' })).rejects.toMatchObject({
    kind: 'unsupported',
  })
  await expect(client.call('_agnes/v1/resources.list', { profile: 'local-dev' })).rejects.toMatchObject({
    kind: 'unsupported',
  })
  await expect(client.call('_agnes/v1/mcp.servers.list', { profile: 'local-dev' })).rejects.toMatchObject({
    kind: 'unsupported',
  })
  await expect(
    client.call('_agnes/v1/extension.call', {
      extension: 'example/service',
      service: 'status.get',
      input: {},
    }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(
    client.call('_agnes/v1/extension.ack', {
      extension: 'example/service',
      service: 'status.get',
      commandId: 'forged',
    }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(
    client.clientModules.callService({
      profile: 'local-dev',
      rowId: 'web:example/service',
      sessionId: 'session-a',
      service: 'status.get',
      input: {},
    }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(
    client.clientModules.callEffect({
      profile: 'local-dev',
      rowId: 'web:example/service',
      sessionId: 'session-a',
      service: 'status.write',
      commandId: 'effect-1',
      input: {},
    }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
})
