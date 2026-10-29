import { expect, it, vi } from 'vitest'
import { Client as BaseClient } from '../src/client.js'
import { createClient } from '../src/index.browser.js'

it('rejects raw admin and Extension Service calls from the browser client before connecting', async () => {
  const client = createClient({ transport: { kind: 'ws', url: 'ws://127.0.0.1/unused' } })
  await expect(client.call('_agnes/v1/packages.list', { profile: 'local-dev' })).rejects.toMatchObject({
    kind: 'unsupported',
  })
  await expect(client.credentials.list()).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(
    client.credentials.create({ label: 'Work', value: 'synthetic-browser-canary' }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(
    client.notify('_agnes/v1/admin.credentials.set', { id: 'unused', value: 'synthetic-browser-canary' }),
  ).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(client.config.modelSlots.get()).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(client.config.modelSlots.save({ revision: 0, slots: { fast: null } })).rejects.toMatchObject({
    kind: 'unsupported',
  })
  await expect(client.autoReview.get()).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(client.autoReview.save({ enabled: true })).rejects.toMatchObject({ kind: 'unsupported' })
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

it('leaves session reads such as deliverables to the browser client', async () => {
  const page = { sessionId: 'session-a', upto: 0, items: [] }
  const call = vi.spyOn(BaseClient.prototype, 'call').mockResolvedValue(page)
  try {
    const client = createClient({ transport: { kind: 'ws', url: 'ws://127.0.0.1/unused' } })
    await expect(
      client.call('_agnes/v1/session.deliverables', { sessionId: 'session-a', afterSeq: 0 }),
    ).resolves.toEqual(page)
    expect(call).toHaveBeenCalledWith(
      '_agnes/v1/session.deliverables',
      { sessionId: 'session-a', afterSeq: 0 },
      undefined,
    )
  } finally {
    call.mockRestore()
  }
})
