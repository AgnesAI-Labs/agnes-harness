import type { IncomingMessage, ServerResponse } from 'node:http'
import { httpRpcError, validateMethod } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { ChannelRefusal } from './channel-dedicated.js'
import { channelWorkbench } from './channel-workbench.js'

const PAIRING_REFUSALS = [
  'TARGET_PAIRED',
  'TARGET_UNAVAILABLE',
  'CHANNEL_UNAVAILABLE',
  'CHANNEL_CLAIMED',
  'ID_CONFLICT',
]

/** Fixed workbench controls. Browser SDK control-plane restrictions remain in force. */
export function channelRelay(input: {
  client: Client
  origin: string
  profile: string
  initialize(): Promise<unknown>
  body(request: IncomingMessage): Promise<Record<string, unknown> | undefined>
  reply(response: ServerResponse, status: number, value: unknown): void
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', input.origin)
    if (url.pathname !== '/api/channels') return false
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.host !== new URL(input.origin).host ||
      request.headers.origin !== input.origin
    ) {
      request.resume()
      input.reply(response, 403, { error: httpRpcError(403, 'CAPABILITY_DENIED') })
      return true
    }
    const body = await input.body(request)
    if (body?.method === 'channels.pairing') {
      const params = pairingParams(body)
      if (!params) {
        input.reply(response, 400, { error: httpRpcError(400, 'INVALID_REQUEST') })
        return true
      }
      try {
        await input.initialize()
        input.reply(response, 200, await channelWorkbench(input.client, input.profile).pairing(params))
      } catch (error) {
        // Only the fixed refusal codes pass through; the daemon's message never does.
        const code = String((error as { data?: { code?: unknown } }).data?.code)
        input.reply(response, PAIRING_REFUSALS.includes(code) ? 409 : 503, {
          error: PAIRING_REFUSALS.includes(code) ? httpRpcError(409, code) : httpRpcError(503, 'UNAVAILABLE'),
        })
      }
      return true
    }
    if (typeof body?.method === 'string' && Object.hasOwn(WORKBENCH_FIELDS, body.method)) {
      const record = workbenchParams(body.method, body)
      if (!record) {
        input.reply(response, 400, { error: httpRpcError(400, 'INVALID_REQUEST') })
        return true
      }
      try {
        await input.initialize()
        const api = channelWorkbench(input.client, input.profile)
        const result =
          body.method === 'channels.overview'
            ? await api.overview()
            : body.method === 'channels.context'
              ? await api.context(
                  String(record.extension),
                  String(record.sessionId),
                  typeof record.instanceId === 'string' ? record.instanceId : undefined,
                )
              : body.method === 'channels.remove'
                ? await api.remove(record)
                : body.method === 'channels.dedicatedContext'
                  ? await api.dedicatedContext(String(record.extension))
                  : body.method === 'channels.configureDedicated'
                    ? await api.configureDedicated(record)
                    : await api.configure(record)
        input.reply(response, 200, result)
      } catch (error) {
        // A deterministic dedicated-connection refusal is distinct from an unconfirmed outcome.
        if (error instanceof ChannelRefusal) {
          const refused = httpRpcError(409, 'CHANNEL_REFUSED')
          const reason = error.reason ? { reason: error.reason } : {}
          input.reply(response, 409, { error: { ...refused, data: { ...refused.data, ...reason } } })
        } else input.reply(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
      }
      return true
    }
    const method =
      body?.method === '_agnes/v1/extension.callScoped' || body?.method === '_agnes/v1/extension.call'
        ? body.method
        : undefined
    const params = body?.params
    const profile = method === '_agnes/v1/extension.callScoped'
    const session = method === '_agnes/v1/extension.call'
    const allowed = profile
      ? ['channel.configuration', 'channel.status', 'channel.check', 'channel.configure']
      : session
        ? ['channel.session', 'channel.bind', 'channel.unbind']
        : []
    if (
      !body ||
      Object.keys(body).some((key) => !['method', 'params'].includes(key)) ||
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      typeof method !== 'string' ||
      !allowed.includes(String((params as Record<string, unknown>).service)) ||
      !validateMethod(method, 'params', params).ok
    ) {
      input.reply(response, 400, { error: httpRpcError(400, 'INVALID_REQUEST') })
      return true
    }
    try {
      await input.initialize()
      const catalog = await input.client.call<{
        providers: { extension: string; bindingAvailable: boolean }[]
      }>('_agnes/v1/channels.catalog', {})
      const provider = catalog.providers.find(
        (row) => row.extension === (params as Record<string, unknown>).extension,
      )
      if (!provider || (session && !provider.bindingAvailable)) {
        input.reply(response, 403, { error: httpRpcError(403, 'CAPABILITY_DENIED') })
        return true
      }
      input.reply(response, 200, await input.client.call(method, params))
    } catch {
      input.reply(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
    }
    return true
  }
}

const CONNECTION_FIELDS = ['credentialRefs', 'config', 'allowFrom', 'requireMention', 'operationId']
/** Workbench methods and the only fields each accepts. Identity, paths and agents are server-derived. */
const WORKBENCH_FIELDS: Record<string, readonly string[]> = {
  'channels.overview': [],
  'channels.context': ['extension', 'sessionId', 'instanceId'],
  'channels.configure': [
    'extension',
    'sessionId',
    'instanceId',
    'replaceId',
    ...CONNECTION_FIELDS,
    'configurationRevision',
  ],
  'channels.remove': ['extension', 'instanceId', 'operationId', 'configurationRevision', 'expectedVersion'],
  'channels.dedicatedContext': ['extension'],
  'channels.configureDedicated': [
    'extension',
    'workspaceId',
    'instanceId',
    ...CONNECTION_FIELDS,
    'configurationRevision',
  ],
}

function workbenchParams(method: string, body: Record<string, unknown>) {
  const { params } = body
  const record =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined
  const text = (key: string) =>
    typeof record?.[key] === 'string' &&
    (record[key] as string).length > 0 &&
    (record[key] as string).length <= 512
  const refs = record?.credentialRefs
  const connection = () =>
    text('instanceId') &&
    text('operationId') &&
    text('configurationRevision') &&
    !!refs &&
    typeof refs === 'object' &&
    !Array.isArray(refs) &&
    Object.keys(refs).length <= 32 &&
    Object.values(refs).every(
      (ref) => typeof ref === 'string' && /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(ref),
    ) &&
    (record.allowFrom === undefined ||
      (Array.isArray(record.allowFrom) &&
        record.allowFrom.length <= 1024 &&
        record.allowFrom.every((id) => typeof id === 'string' && id.length <= 256))) &&
    (record.requireMention === undefined || typeof record.requireMention === 'boolean')
  if (
    Object.keys(body).some((key) => !['method', 'params'].includes(key)) ||
    !record ||
    Object.keys(record).some((key) => !WORKBENCH_FIELDS[method]?.includes(key)) ||
    (method !== 'channels.overview' && !text('extension')) ||
    (['channels.context', 'channels.configure'].includes(method) && !text('sessionId')) ||
    (method === 'channels.remove' &&
      (!text('instanceId') ||
        !text('operationId') ||
        !text('configurationRevision') ||
        !Number.isSafeInteger(record.expectedVersion) ||
        Number(record.expectedVersion) < 0)) ||
    (method === 'channels.configure' && !connection()) ||
    (method === 'channels.configureDedicated' && (!text('workspaceId') || !connection()))
  )
    return undefined
  return record
}

/** The pairing controls: list targets, mint a code (behind a person's approval) and revoke a pairing. */
function pairingParams(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const { params } = body
  if (Object.keys(body).some((key) => !['method', 'params'].includes(key))) return undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined
  return validateMethod('_agnes/v1/channels.pairing', 'params', params).ok
    ? (params as Record<string, unknown>)
    : undefined
}
