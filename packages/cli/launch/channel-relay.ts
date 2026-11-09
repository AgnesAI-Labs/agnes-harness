import type { IncomingMessage, ServerResponse } from 'node:http'
import { httpRpcError, validateMethod } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { channelWorkbench } from './channel-workbench.js'

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
    if (
      typeof body?.method === 'string' &&
      ['channels.overview', 'channels.context', 'channels.configure', 'channels.remove'].includes(body.method)
    ) {
      const params = body.params
      const record =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : undefined
      const fields =
        body.method === 'channels.overview'
          ? []
          : body.method === 'channels.remove'
            ? ['extension', 'instanceId', 'operationId', 'configurationRevision', 'expectedVersion']
          : body.method === 'channels.context'
            ? ['extension', 'sessionId', 'instanceId']
            : [
                'extension',
                'sessionId',
                'instanceId',
                'replaceId',
                'credentialRefs',
                'config',
                'allowFrom',
                'requireMention',
                'operationId',
                'configurationRevision',
              ]
      const text = (key: string) =>
        typeof record?.[key] === 'string' &&
        (record[key] as string).length > 0 &&
        (record[key] as string).length <= 512
      const refs = record?.credentialRefs
      if (
        Object.keys(body).some((key) => !['method', 'params'].includes(key)) ||
        !record ||
        Object.keys(record).some((key) => !fields.includes(key)) ||
        (body.method !== 'channels.overview' && !text('extension')) ||
        (['channels.context', 'channels.configure'].includes(body.method) && !text('sessionId')) ||
        (body.method === 'channels.remove' &&
          (!text('instanceId') || !text('operationId') || !text('configurationRevision') ||
            !Number.isSafeInteger(record.expectedVersion) || Number(record.expectedVersion) < 0)) ||
        (body.method === 'channels.configure' &&
          (!text('instanceId') ||
            !text('operationId') ||
            !text('configurationRevision') ||
            !refs ||
            typeof refs !== 'object' ||
            Array.isArray(refs) ||
            Object.keys(refs).length > 32 ||
            Object.values(refs).some(
              (ref) => typeof ref !== 'string' || !/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(ref),
            ) ||
            (record.allowFrom !== undefined &&
              (!Array.isArray(record.allowFrom) ||
                record.allowFrom.length > 1024 ||
                record.allowFrom.some((id) => typeof id !== 'string' || id.length > 256))) ||
            (record.requireMention !== undefined && typeof record.requireMention !== 'boolean')))
      ) {
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
                : await api.configure(record)
        input.reply(response, 200, result)
      } catch {
        input.reply(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
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
