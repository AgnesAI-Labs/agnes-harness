import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { ChannelError } from '../../errors.js'
import type {
  DingtalkGateway,
  DingtalkHandlers,
  DingtalkTarget,
  RawCardCallback,
  RawDept,
  RawRobotMessage,
  RawUser,
} from './gateway.js'

/**
 * DingTalk assumptions (2026-09-11; not live-verified):
 * A1 `dingtalk-stream` exports DWClient, callback listener registration and connect/disconnect.
 *    Robot and card callback topics below carry JSON strings and accept SUCCESS acknowledgements.
 * A2 access tokens use `/v1.0/oauth2/accessToken` and `x-acs-dingtalk-access-token`.
 * A3 robot group/direct message endpoints accept `sampleMarkdown` payloads.
 * A4 cards use create, deliver and PUT-update endpoints plus the documented open-space models.
 * A5 message-file download returns an HTTPS URL which can be fetched without authentication.
 * A6 legacy department/user endpoints accept an access token in the query string.
 * Task 24 must verify every assumption against a real enterprise before this list is marked verified.
 */

const API = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'
const TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
const TOPIC_CARD = '/v1.0/card/instances/callback'

type StreamMessage = { headers: { messageId: string }; data: string }

export type StreamClientLike = {
  registerCallbackListener(topic: string, callback: (message: StreamMessage) => Promise<void>): void
  connect(): Promise<void>
  disconnect(): Promise<void>
  socketCallBackResponse?(messageId: string, body: unknown): void
  onDisconnect?(callback: (error?: unknown) => void): void
}

export type DingtalkCredentials = {
  clientId: string
  clientSecret: string
  robotCode?: string
}

export type RealGatewayOptions = {
  fetchImpl?: typeof fetch
  streamFactory?: (credentials: DingtalkCredentials) => StreamClientLike | Promise<StreamClientLike>
  cardTemplateId?: string
  /** Injectable for deterministic tests; every resolved address must be public. */
  resolveHostname?: (hostname: string) => Promise<string[]>
  /** Test/embedding seam. Production pins the validated DNS answers onto the TLS socket. */
  attachmentRequest?: (
    target: { url: URL; addresses: string[] },
    maxBytes: number,
  ) => Promise<{ bytes: Uint8Array; mime: string } | { url: string }>
}

export type RealDingtalkGateway = DingtalkGateway & {
  setCredentials(credentials: DingtalkCredentials): void
}

export function createRealGateway(options: RealGatewayOptions = {}): RealDingtalkGateway {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveHostname =
    options.resolveHostname ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address))
  let credentials: DingtalkCredentials | undefined
  let credentialsVersion = 0
  let token: { value: string; expiresAt: number } | undefined
  let tokenRequest: Promise<string> | undefined
  let stream: StreamClientLike | undefined
  let removeAbortListener: (() => void) | undefined

  function setCredentials(next: DingtalkCredentials): void {
    if (next.clientId.length === 0 || next.clientSecret.length === 0) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk credentials are incomplete')
    }
    credentials = { ...next }
    credentialsVersion++
    token = undefined
    tokenRequest = undefined
  }

  function requireCredentials(): DingtalkCredentials {
    if (credentials === undefined) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk credentials are not set')
    }
    return credentials
  }

  function requireRobotCode(): string {
    const robotCode = requireCredentials().robotCode
    if (robotCode === undefined || robotCode.length === 0) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk robotCode is not set')
    }
    return robotCode
  }

  async function request(input: string, init: RequestInit, operation: string): Promise<Response> {
    try {
      // Never forward access tokens, app secrets, or request bodies to a redirect target.
      return await fetchImpl(input, { ...init, redirect: 'error' })
    } catch {
      throw new ChannelError('E_CONNECT_FAILED', `DingTalk ${operation} request failed`)
    }
  }

  async function readJson<T>(response: Response, operation: string): Promise<T> {
    if (!response.ok) {
      throw new ChannelError('E_CONNECT_FAILED', `DingTalk ${operation} failed with HTTP ${response.status}`)
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new ChannelError('E_CONNECT_FAILED', `DingTalk ${operation} returned invalid JSON`)
    }
  }

  async function acquireAccessToken(): Promise<string> {
    const current = requireCredentials()
    const version = credentialsVersion
    const response = await request(
      `${API}/v1.0/oauth2/accessToken`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: current.clientId, appSecret: current.clientSecret }),
      },
      'access token',
    )
    const payload = await readJson<{ accessToken?: unknown; expireIn?: unknown }>(response, 'access token')
    if (
      typeof payload.accessToken !== 'string' ||
      payload.accessToken.length === 0 ||
      typeof payload.expireIn !== 'number' ||
      !Number.isFinite(payload.expireIn) ||
      payload.expireIn <= 0
    ) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk access token response is invalid')
    }
    if (version !== credentialsVersion) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk credentials changed during token request')
    }
    token = { value: payload.accessToken, expiresAt: Date.now() + payload.expireIn * 1_000 }
    return token.value
  }

  async function accessToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > Date.now() + 60_000) return token.value
    tokenRequest ??= acquireAccessToken()
    const pending = tokenRequest
    try {
      return await pending
    } finally {
      if (tokenRequest === pending) tokenRequest = undefined
    }
  }

  async function api<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    const response = await request(
      `${API}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': await accessToken(),
        },
        body: JSON.stringify(body),
      },
      'API',
    )
    return readJson<T>(response, 'API')
  }

  async function oapi<T>(path: string, body: unknown): Promise<T> {
    const response = await request(
      `${OAPI}${path}?access_token=${encodeURIComponent(await accessToken())}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      'directory API',
    )
    const payload = await readJson<{ errcode?: unknown } & T>(response, 'directory API')
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new ChannelError('E_CONNECT_FAILED', `DingTalk directory API failed with code ${payload.errcode}`)
    }
    return payload
  }

  function openSpace(target: DingtalkTarget, robotCode: string): Record<string, unknown> {
    if (target.conversationType === '2') {
      return {
        imGroupOpenSpaceModel: { supportForward: true },
        openSpaceId: `dtv1.card//IM_GROUP.${target.conversationId}`,
        imGroupOpenDeliverModel: { robotCode },
      }
    }
    return {
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: `dtv1.card//IM_ROBOT.${target.userIds?.[0] ?? target.conversationId}`,
      imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode },
    }
  }

  async function makeStream(current: DingtalkCredentials): Promise<StreamClientLike> {
    if (options.streamFactory !== undefined) return options.streamFactory(current)
    try {
      // Keep the SDK optional: deployments which enable DingTalk install this package, while
      // fake-gateway tests and other channel deployments do not load it.
      const packageName = 'dingtalk-stream'
      const module = (await import(packageName)) as unknown as {
        DWClient?: new (options: { clientId: string; clientSecret: string }) => StreamClientLike
      }
      if (module.DWClient === undefined) throw new Error('DWClient export missing')
      return new module.DWClient({ clientId: current.clientId, clientSecret: current.clientSecret })
    } catch {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk Stream SDK is unavailable')
    }
  }

  function registerCallback<T>(client: StreamClientLike, topic: string, handler: (payload: T) => void): void {
    client.registerCallbackListener(topic, async (message) => {
      try {
        if (stream !== client) return
        const payload = JSON.parse(message.data) as unknown
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
        handler(payload as T)
      } catch {
        // A malformed event is isolated from the transport lifecycle and must not reconnect it.
      } finally {
        try {
          client.socketCallBackResponse?.(message.headers.messageId, {
            message: 'success',
            status: 'SUCCESS',
          })
        } catch {
          // Acknowledgement failures are SDK-local and must not escape its callback.
        }
      }
    })
  }

  async function stop(): Promise<void> {
    removeAbortListener?.()
    removeAbortListener = undefined
    const current = stream
    stream = undefined
    if (current === undefined) return
    try {
      await current.disconnect()
    } catch {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk stream disconnect failed')
    }
  }

  return {
    setCredentials,

    async start(handlers: DingtalkHandlers, signal: AbortSignal): Promise<{ botUserId: string }> {
      if (signal.aborted) throw new ChannelError('E_CONNECT_FAILED', 'DingTalk stream start was aborted')
      const currentCredentials = requireCredentials()
      await stop()
      const client = await makeStream(currentCredentials)
      stream = client
      registerCallback<RawRobotMessage>(client, TOPIC_ROBOT, handlers.onMessage)
      registerCallback<RawCardCallback>(client, TOPIC_CARD, handlers.onCard)
      client.onDisconnect?.(() => {
        if (stream === client && !signal.aborted) {
          handlers.onDisconnect(new Error('DingTalk stream disconnected'))
        }
      })
      const onAbort = () => {
        if (stream === client) void stop().catch(() => undefined)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      try {
        await client.connect()
      } catch {
        if (stream === client) await stop().catch(() => undefined)
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk stream connect failed')
      }
      if (signal.aborted || stream !== client) {
        if (stream === client) await stop().catch(() => undefined)
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk stream start was aborted')
      }
      return { botUserId: currentCredentials.robotCode ?? '' }
    },

    stop,

    async sendMarkdown(target, title, markdown) {
      const robotCode = requireRobotCode()
      const msgParam = JSON.stringify({ title, text: markdown })
      if (target.conversationType === '2') {
        return api<{ processQueryKey: string }>('/v1.0/robot/groupMessages/send', {
          robotCode,
          openConversationId: target.conversationId,
          msgKey: 'sampleMarkdown',
          msgParam,
        })
      }
      return api<{ processQueryKey: string }>('/v1.0/robot/oToMessages/batchSend', {
        robotCode,
        userIds: target.userIds ?? [target.conversationId],
        msgKey: 'sampleMarkdown',
        msgParam,
      })
    },

    async createCard(outTrackId, cardData, target) {
      const robotCode = requireRobotCode()
      await api('/v1.0/card/instances', {
        cardTemplateId: options.cardTemplateId ?? 'agnes-basic',
        outTrackId,
        cardData,
        ...openSpace(target, robotCode),
      })
      await api('/v1.0/card/instances/deliver', {
        outTrackId,
        ...openSpace(target, robotCode),
      })
    },

    async updateCard(outTrackId, cardData) {
      await api('/v1.0/card/instances', { outTrackId, cardData }, 'PUT')
    },

    async download(downloadCode, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk download size limit is invalid')
      }
      const robotCode = requireRobotCode()
      const payload = await api<{ downloadUrl?: unknown }>('/v1.0/robot/messageFiles/download', {
        downloadCode,
        robotCode,
      })
      const target =
        typeof payload.downloadUrl === 'string'
          ? await resolvePublicHttpsUrl(payload.downloadUrl, resolveHostname)
          : undefined
      if (target === undefined) {
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk returned an unsafe download URL')
      }
      if (options.attachmentRequest !== undefined) {
        return options.attachmentRequest(target, maxBytes)
      }
      if (options.fetchImpl === undefined) return requestPinnedDownload(target, maxBytes)
      const response = await request(
        target.url.href,
        { method: 'GET', redirect: 'error' },
        'attachment download',
      )
      if (!response.ok) {
        throw new ChannelError(
          'E_CONNECT_FAILED',
          `DingTalk attachment download failed with HTTP ${response.status}`,
        )
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        return { url: target.url.href }
      }
      let bytes: Uint8Array | undefined
      try {
        bytes = await readBoundedBody(response, maxBytes)
      } catch {
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk attachment download failed')
      }
      if (bytes === undefined) return { url: target.url.href }
      return {
        bytes,
        mime: response.headers.get('content-type') ?? 'application/octet-stream',
      }
    },

    async listDepartments(parentId = 1) {
      const payload = await oapi<{ result?: RawDept[] }>('/topapi/v2/department/listsub', {
        dept_id: parentId,
      })
      return payload.result ?? []
    },

    async listUsers(deptId, cursor = 0) {
      const payload = await oapi<{
        result?: { list?: RawUser[]; has_more?: boolean; next_cursor?: number }
      }>('/topapi/v2/user/list', { dept_id: deptId, cursor, size: 100 })
      const result = payload.result
      return {
        users: result?.list ?? [],
        ...(result?.has_more === true && result.next_cursor !== undefined
          ? { nextCursor: result.next_cursor }
          : {}),
      }
    },
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function resolvePublicHttpsUrl(
  value: string,
  resolveHostname: (hostname: string) => Promise<string[]>,
): Promise<{ url: URL; addresses: string[] } | undefined> {
  if (
    value.length > 4_096 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x20 || code === 0x7f
    })
  ) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      return undefined
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return undefined
    const family = isIP(hostname)
    if (family === 4) return isPublicIpv4(hostname) ? { url, addresses: [hostname] } : undefined
    if (family === 6) return isPublicIpv6(hostname) ? { url, addresses: [hostname] } : undefined
    let addresses: string[]
    try {
      addresses = await resolveHostname(hostname)
    } catch {
      return undefined
    }
    return addresses.length > 0 && addresses.every(isPublicAddress) ? { url, addresses } : undefined
  } catch {
    return undefined
  }
}

/** HTTPS attachment fetch with no redirect and no second DNS lookup. */
export function requestPinnedDownload(
  target: { url: URL; addresses: string[] },
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mime: string } | { url: string }> {
  const resolved = target.addresses.map((address) => ({ address, family: isIP(address) as 4 | 6 }))
  if (resolved.length === 0 || resolved.some((entry) => !isPublicAddress(entry.address))) {
    return Promise.reject(new ChannelError('E_CONNECT_FAILED', 'DingTalk download address is unsafe'))
  }
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, resolved)
    else {
      const selected = resolved[0] as (typeof resolved)[number]
      callback(null, selected.address, selected.family)
    }
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target.url,
      {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup,
        headers: { accept: '*/*' },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          response.resume()
          reject(
            new ChannelError('E_CONNECT_FAILED', `DingTalk attachment download failed with HTTP ${status}`),
          )
          return
        }
        const declaredLength = Number(response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy()
          resolve({ url: target.url.href })
          return
        }
        const chunks: Uint8Array[] = []
        let total = 0
        let settled = false
        response.on('data', (chunk: Buffer) => {
          if (settled) return
          total += chunk.byteLength
          if (total > maxBytes) {
            settled = true
            response.destroy()
            resolve({ url: target.url.href })
          } else chunks.push(new Uint8Array(chunk))
        })
        response.once('end', () => {
          if (settled) return
          settled = true
          const bytes = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          const contentType = response.headers['content-type']
          resolve({
            bytes,
            mime: Array.isArray(contentType)
              ? (contentType[0] ?? 'application/octet-stream')
              : (contentType ?? 'application/octet-stream'),
          })
        })
        response.once('error', () => {
          if (settled) return
          settled = true
          reject(new ChannelError('E_CONNECT_FAILED', 'DingTalk attachment download failed'))
        })
      },
    )
    request.setTimeout(30_000, () => request.destroy(new Error('attachment timeout')))
    request.once('error', () => {
      reject(new ChannelError('E_CONNECT_FAILED', 'DingTalk attachment download failed'))
    })
    request.end()
  })
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false
}

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  const [a = 0, b = 0] = parts
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPublicIpv6(hostname: string): boolean {
  const words = ipv6Words(hostname)
  if (words === undefined) return false
  const first = words[0] ?? 0
  if ((first & 0xfe00) === 0xfc00) return false // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false
  if ((first & 0xff00) === 0xff00) return false // multicast
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0)
  if (firstFiveZero && words[5] === 0xffff) {
    const ipv4 = `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.${(words[7] ?? 0) >> 8}.${
      (words[7] ?? 0) & 0xff
    }`
    return isPublicIpv4(ipv4)
  }
  // Unspecified, loopback, and deprecated IPv4-compatible forms all live below ::/96.
  if (words.slice(0, 6).every((word) => word === 0)) return false
  return true
}

function ipv6Words(value: string): number[] | undefined {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized.includes('%') || normalized.split('::').length > 2) return undefined
  const halves = normalized.split('::')
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return []
    const out: number[] = []
    for (const part of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
      out.push(Number.parseInt(part, 16))
    }
    return out
  }
  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves[1] ?? '')
  if (left === undefined || right === undefined) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}
