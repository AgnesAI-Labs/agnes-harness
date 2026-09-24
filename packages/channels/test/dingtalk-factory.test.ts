import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectOptions } from '../src/adapter.js'
import type { RawCardCallback, RawRobotMessage } from '../src/adapters/dingtalk/gateway.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))

function connectOptions(override: Partial<ConnectOptions> = {}): ConnectOptions {
  return {
    credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
    signal: new AbortController().signal,
    onEvent: () => {},
    log: { info() {}, warn() {}, error() {} },
    ...override,
  }
}

const rawMessage: RawRobotMessage = {
  msgId: 'message-1',
  conversationId: 'conversation-1',
  conversationType: '2',
  senderStaffId: 'user-1',
  msgtype: 'text',
  text: { content: 'hello' },
  createAt: 1_789_000_000_000,
}

const rawCard: RawCardCallback = {
  outTrackId: 'card-1',
  userId: 'user-1',
  cardPrivateData: { actionIds: ['approve'], params: { ticket: 'ticket-1' } },
  conversationId: 'conversation-1',
  conversationType: '2',
}

describe('createDingtalkAdapter', () => {
  it('loads the checked manifest, reports cloned capabilities and uses the injected gateway', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })

    expect(adapter.manifest).toMatchObject({
      id: 'dingtalk',
      connection: { modes: ['stream'], default: 'stream' },
    })
    const capabilities = adapter.capabilities()
    expect(capabilities).toMatchObject({ edit: true, card: true, thread: false, attachment: true })
    capabilities.edit = false
    expect(adapter.capabilities().edit).toBe(true)

    await adapter.connect(connectOptions())
    expect(gateway.started).toBe(true)
    await adapter.disconnect()
    expect(gateway.started).toBe(false)
  })

  it.each([
    [{ clientSecret: 'app-secret' }, 'clientId'],
    [{ clientId: 'app-key' }, 'clientSecret'],
    [{ clientId: '', clientSecret: 'app-secret' }, 'clientId'],
  ])('fails closed before starting the gateway when credentials are incomplete', async (credentials, key) => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })

    await expect(adapter.connect(connectOptions({ credentials }))).rejects.toMatchObject({
      code: 'E_CONNECT_FAILED',
      detail: { key },
    })
    expect(gateway.started).toBe(false)
  })

  it('refuses an already-aborted connection before starting the gateway', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    const controller = new AbortController()
    controller.abort()

    await expect(adapter.connect(connectOptions({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'E_CONNECT_FAILED',
    })
    expect(gateway.started).toBe(false)
  })

  it('cleans up a partially started gateway without masking its start error', async () => {
    const gateway = new FakeDingtalkGateway()
    const startError = new Error('stream startup failed')
    gateway.start = vi.fn(async () => {
      gateway.started = true
      throw startError
    })
    gateway.stop = vi.fn(async () => {
      gateway.started = false
      throw new Error('cleanup also failed')
    })
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })

    await expect(adapter.connect(connectOptions())).rejects.toBe(startError)
    expect(gateway.stop).toHaveBeenCalledOnce()
    expect(gateway.started).toBe(false)
  })

  it('does not copy an untrusted gateway error into adapter logs', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    const warn = vi.fn()
    await adapter.connect(connectOptions({ log: { info() {}, warn, error() {} } }))

    gateway.emitDisconnect(new Error('app-secret must never reach the log'))

    expect(warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('app-secret')
    await adapter.disconnect()
  })

  it('constructs the real backend lazily without substituting a fake gateway', async () => {
    await expect(createDingtalkAdapter(manifestPath)).resolves.toMatchObject({
      manifest: { id: 'dingtalk' },
    })
  })
})

describe('FakeDingtalkGateway', () => {
  it('delivers all callbacks only while started and stops on abort', async () => {
    const gateway = new FakeDingtalkGateway()
    const onMessage = vi.fn()
    const onCard = vi.fn()
    const onDisconnect = vi.fn()
    gateway.emitMessage(rawMessage)
    expect(onMessage).not.toHaveBeenCalled()

    const controller = new AbortController()
    await expect(gateway.start({ onMessage, onCard, onDisconnect }, controller.signal)).resolves.toEqual({
      botUserId: 'bot-1',
    })
    gateway.emitMessage(rawMessage)
    gateway.emitCard(rawCard)
    const disconnectError = new Error('stream lost')
    gateway.emitDisconnect(disconnectError)
    expect(onMessage).toHaveBeenCalledWith(rawMessage)
    expect(onCard).toHaveBeenCalledWith(rawCard)
    expect(onDisconnect).toHaveBeenCalledWith(disconnectError)

    controller.abort()
    expect(gateway.started).toBe(false)
    gateway.emitMessage(rawMessage)
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('records markdown/card sends and returns stable unique markdown references', async () => {
    const gateway = new FakeDingtalkGateway()
    const target = { conversationId: 'conversation-1', conversationType: '2' as const }

    await expect(gateway.sendMarkdown(target, 'Title', 'Body')).resolves.toEqual({
      processQueryKey: 'pq1',
    })
    await expect(gateway.sendMarkdown(target, 'Again', 'More')).resolves.toEqual({
      processQueryKey: 'pq2',
    })
    await gateway.createCard('track-1', { title: 'Card' }, target)
    await gateway.updateCard('track-1', { title: 'Updated' })
    expect(gateway.sent).toEqual([
      { kind: 'markdown', target, payload: { title: 'Title', markdown: 'Body' } },
      { kind: 'markdown', target, payload: { title: 'Again', markdown: 'More' } },
      { kind: 'card', outTrackId: 'track-1', target, payload: { title: 'Card' } },
      { kind: 'cardUpdate', outTrackId: 'track-1', payload: { title: 'Updated' } },
    ])
  })

  it('supports bounded downloads and deterministic department/user pagination', async () => {
    const gateway = new FakeDingtalkGateway()
    gateway.downloads.set('small', { bytes: new Uint8Array([1, 2]), mime: 'image/png' })
    gateway.downloads.set('large', { bytes: new Uint8Array(4), mime: 'application/octet-stream' })
    gateway.departments = [
      { dept_id: 2, name: 'Sales', parent_id: 1 },
      { dept_id: 3, name: 'Platform', parent_id: 2 },
    ]
    gateway.users.set(
      2,
      Array.from({ length: 5 }, (_, index) => ({
        userid: `user-${index}`,
        name: `User ${index}`,
        dept_id_list: [2],
      })),
    )

    await expect(gateway.download('small', 2)).resolves.toMatchObject({ mime: 'image/png' })
    await expect(gateway.download('large', 2)).resolves.toEqual({
      url: 'https://dl.example/large',
    })
    await expect(gateway.download('missing', 2)).rejects.toThrow(/no download missing/)
    await expect(gateway.listDepartments()).resolves.toEqual([{ dept_id: 2, name: 'Sales', parent_id: 1 }])
    await expect(gateway.listDepartments(2)).resolves.toEqual([
      { dept_id: 3, name: 'Platform', parent_id: 2 },
    ])
    await expect(gateway.listUsers(2)).resolves.toMatchObject({
      users: [{ userid: 'user-0' }, { userid: 'user-1' }],
      nextCursor: 2,
    })
    await expect(gateway.listUsers(2, 4)).resolves.toEqual({
      users: [{ userid: 'user-4', name: 'User 4', dept_id_list: [2] }],
    })
  })
})
