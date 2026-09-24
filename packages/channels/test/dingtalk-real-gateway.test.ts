import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createRealGateway, requestPinnedDownload } from '../src/adapters/dingtalk/gateway-real.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))

type FetchCall = { url: string; init: RequestInit }

function jsonFetch(routes: Record<string, (init: RequestInit) => { body: unknown; status?: number }>): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const key = Object.keys(routes).find((candidate) => url.includes(candidate))
    if (key === undefined) return new Response('not found', { status: 404 })
    const result = routes[key]?.(init)
    return new Response(JSON.stringify(result?.body), {
      status: result?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('RealDingtalkGateway', () => {
  it('receives a defensive credential copy from the adapter before stream startup', async () => {
    const streamFactory = vi.fn(() => streamStub())
    const gateway = createRealGateway({ fetchImpl: jsonFetch({}).fetchImpl, streamFactory })
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    const credentials = { clientId: 'key', clientSecret: 'secret', robotCode: 'robot' }

    await adapter.connect({
      credentials,
      signal: new AbortController().signal,
      onEvent() {},
      log: { info() {}, warn() {}, error() {} },
    })
    credentials.clientSecret = 'changed-after-connect'

    expect(streamFactory).toHaveBeenCalledWith({
      clientId: 'key',
      clientSecret: 'secret',
      robotCode: 'robot',
    })
    await adapter.disconnect()
  })

  it('caches its token, maps group sends and creates then delivers cards', async () => {
    const { fetchImpl, calls } = jsonFetch({
      '/v1.0/oauth2/accessToken': () => ({ body: { accessToken: 'tok', expireIn: 7_200 } }),
      '/v1.0/robot/groupMessages/send': () => ({ body: { processQueryKey: 'pq1' } }),
      '/v1.0/card/instances/deliver': () => ({ body: { success: true } }),
      '/v1.0/card/instances': () => ({ body: { success: true } }),
    })
    const listeners = new Map<
      string,
      (message: { headers: { messageId: string }; data: string }) => Promise<void>
    >()
    const acknowledgements: Array<[string, unknown]> = []
    const gateway = createRealGateway({
      fetchImpl,
      cardTemplateId: 'tpl-1',
      streamFactory: () => ({
        registerCallbackListener: (topic, callback) => listeners.set(topic, callback),
        connect: async () => {},
        disconnect: async () => {},
        socketCallBackResponse: (messageId, body) => acknowledgements.push([messageId, body]),
      }),
    })
    gateway.setCredentials({ clientId: 'app-key', clientSecret: 'app-secret', robotCode: 'robot-1' })
    const seen: unknown[] = []
    await gateway.start(
      { onMessage: (message) => seen.push(message), onCard: () => {}, onDisconnect: () => {} },
      new AbortController().signal,
    )

    await expect(
      gateway.sendMarkdown({ conversationId: 'chat-1', conversationType: '2' }, 'title', 'markdown'),
    ).resolves.toEqual({ processQueryKey: 'pq1' })
    await gateway.createCard(
      'track-1',
      { cardParamMap: { title: 'hello' } },
      { conversationId: 'chat-1', conversationType: '2' },
    )

    expect(calls.filter((call) => call.url.includes('/oauth2/accessToken'))).toHaveLength(1)
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true)
    const send = calls.find((call) => call.url.endsWith('/v1.0/robot/groupMessages/send'))
    expect(JSON.parse(String(send?.init.body))).toMatchObject({
      robotCode: 'robot-1',
      openConversationId: 'chat-1',
      msgKey: 'sampleMarkdown',
    })
    const create = calls.find((call) => call.url.endsWith('/v1.0/card/instances'))
    expect(JSON.parse(String(create?.init.body))).toMatchObject({
      cardTemplateId: 'tpl-1',
      outTrackId: 'track-1',
    })

    await listeners.get('/v1.0/im/bot/messages/get')?.({
      headers: { messageId: 'header-1' },
      data: JSON.stringify({
        msgId: 'message-1',
        conversationId: 'chat-1',
        conversationType: '2',
        senderStaffId: 'staff-1',
        msgtype: 'text',
        text: { content: 'hello' },
        createAt: 1,
      }),
    })
    expect(seen).toEqual([expect.objectContaining({ msgId: 'message-1' })])
    expect(acknowledgements).toEqual([['header-1', { message: 'success', status: 'SUCCESS' }]])
  })

  it('isolates malformed callback payloads instead of treating them as transport disconnects', async () => {
    const disconnect = vi.fn()
    let callback: ((message: { headers: { messageId: string }; data: string }) => Promise<void>) | undefined
    const gateway = createRealGateway({
      fetchImpl: jsonFetch({}).fetchImpl,
      streamFactory: () => ({
        registerCallbackListener: (topic, listener) => {
          if (topic.includes('/messages/get')) callback = listener
        },
        connect: async () => {},
        disconnect: async () => {},
      }),
    })
    gateway.setCredentials({ clientId: 'key', clientSecret: 'secret' })
    await gateway.start(
      { onMessage: () => {}, onCard: () => {}, onDisconnect: disconnect },
      new AbortController().signal,
    )

    await expect(callback?.({ headers: { messageId: 'bad-1' }, data: '{' })).resolves.toBeUndefined()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('bounds downloads without trusting content-length and rejects unsafe download URLs', async () => {
    const downloadUrl = 'https://download.example/file'
    let unsafe = false
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/oauth2/accessToken')) {
        return Response.json({ accessToken: 'tok', expireIn: 7_200 })
      }
      if (url.includes('/robot/messageFiles/download')) {
        return Response.json({ downloadUrl: unsafe ? 'file:///etc/passwd' : downloadUrl })
      }
      if (url === downloadUrl) return new Response(new Uint8Array([1, 2, 3, 4, 5]))
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const resolveHostname = vi.fn(async () => ['8.8.8.8'])
    const gateway = createRealGateway({ fetchImpl, resolveHostname, streamFactory: () => streamStub() })
    gateway.setCredentials({ clientId: 'key', clientSecret: 'secret', robotCode: 'robot' })

    await expect(gateway.download('code', 3)).resolves.toEqual({ url: downloadUrl })
    expect(resolveHostname).toHaveBeenCalledWith('download.example')
    unsafe = true
    await expect(gateway.download('code', 3)).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })
  })

  it.each([
    ['https://private.example/file', ['127.0.0.1']],
    ['https://mixed.example/file', ['8.8.8.8', '169.254.169.254']],
    ['https://[::ffff:7f00:1]/file', []],
  ])('rejects a download target resolving to a private address: %s', async (downloadUrl, addresses) => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/oauth2/accessToken')) {
        return Response.json({ accessToken: 'tok', expireIn: 7_200 })
      }
      if (url.includes('/robot/messageFiles/download')) return Response.json({ downloadUrl })
      throw new Error('unsafe target was fetched')
    }) as unknown as typeof fetch
    const gateway = createRealGateway({
      fetchImpl,
      resolveHostname: async () => addresses,
      streamFactory: () => streamStub(),
    })
    gateway.setCredentials({ clientId: 'key', clientSecret: 'secret', robotCode: 'robot' })

    await expect(gateway.download('code', 3)).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('hands validated DNS answers to the pinned attachment transport', async () => {
    const { fetchImpl } = jsonFetch({
      '/v1.0/oauth2/accessToken': () => ({ body: { accessToken: 'tok', expireIn: 7_200 } }),
      '/v1.0/robot/messageFiles/download': () => ({
        body: { downloadUrl: 'https://download.example/file' },
      }),
    })
    const attachmentRequest = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mime: 'application/octet-stream',
    }))
    const gateway = createRealGateway({
      fetchImpl,
      resolveHostname: async () => ['8.8.8.8'],
      attachmentRequest,
      streamFactory: () => streamStub(),
    })
    gateway.setCredentials({ clientId: 'key', clientSecret: 'secret', robotCode: 'robot' })

    await expect(gateway.download('code', 3)).resolves.toMatchObject({ bytes: new Uint8Array([1]) })
    expect(attachmentRequest).toHaveBeenCalledWith(
      { url: new URL('https://download.example/file'), addresses: ['8.8.8.8'] },
      3,
    )
  })

  it('the production attachment transport independently refuses private pinned addresses', async () => {
    await expect(
      requestPinnedDownload({ url: new URL('https://download.example/file'), addresses: ['127.0.0.1'] }, 3),
    ).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })
  })

  it('does not expose credentials, tokens, or backend bodies in HTTP errors', async () => {
    const { fetchImpl } = jsonFetch({
      '/v1.0/oauth2/accessToken': () => ({
        body: { detail: 'app-secret sensitive-token-123' },
        status: 500,
      }),
    })
    const gateway = createRealGateway({ fetchImpl, streamFactory: () => streamStub() })
    gateway.setCredentials({ clientId: 'key', clientSecret: 'app-secret', robotCode: 'robot' })

    let thrown: unknown
    try {
      await gateway.sendMarkdown({ conversationId: 'chat', conversationType: '2' }, 'title', 'body')
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).not.toContain('app-secret')
    expect(String(thrown)).not.toContain('sensitive-token-123')
    expect(thrown).toMatchObject({ code: 'E_CONNECT_FAILED' })
  })
})

function streamStub() {
  return {
    registerCallbackListener() {},
    async connect() {},
    async disconnect() {},
  }
}
