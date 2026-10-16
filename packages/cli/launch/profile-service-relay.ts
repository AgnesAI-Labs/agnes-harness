import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  httpRpcError,
  type ProfileServiceCallParams,
  type ProfileServiceOperationParams,
  validateMethod,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk'

/** Same-origin profile relay. Reconciles the current roster without opening a session. */
export function profileServiceRelay(input: {
  client: Client
  origin: string
  profile: string
  initialize(): Promise<unknown>
  body(request: IncomingMessage): Promise<Record<string, unknown> | undefined>
  reply(response: ServerResponse, status: number, value: unknown): void
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', input.origin)
    if (url.pathname !== '/api/client-modules/profile') return false
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
      !body ||
      !Object.keys(body).every((key) =>
        ['rowId', 'service', 'input', 'operationId', 'read', 'sessionReads'].includes(key),
      ) ||
      typeof body.rowId !== 'string'
    ) {
      input.reply(response, 400, { error: httpRpcError(400, 'INVALID_REQUEST') })
      return true
    }
    try {
      await input.initialize()
      const roster = await input.client.clientModules.list(input.profile)
      const row = roster.rows?.find(
        (candidate) =>
          candidate.rowId === body.rowId &&
          candidate.enabled &&
          candidate.phase === 'ready' &&
          candidate.services?.includes(String(body.service)),
      )
      if (!row?.extIds?.includes(row.moduleName)) throw new Error('unavailable row')
      const params = {
        extension: row.moduleName,
        service: body.service,
        ...(body.operationId !== undefined ? { operationId: body.operationId } : {}),
      }
      const method =
        body.read === true ? '_agnes/v1/extension.readOperation' : '_agnes/v1/extension.callScoped'
      const call =
        body.read === true
          ? params
          : {
              ...params,
              input: body.input ?? {},
              ...(body.sessionReads !== undefined ? { sessionReads: body.sessionReads } : {}),
            }
      if (
        (body.read !== undefined && body.read !== true) ||
        (body.read && (body.input !== undefined || body.sessionReads !== undefined)) ||
        !validateMethod(method, 'params', call).ok
      ) {
        input.reply(response, 400, { error: httpRpcError(400, 'INVALID_REQUEST') })
        return true
      }
      const result =
        method === '_agnes/v1/extension.readOperation'
          ? await input.client.call(method, call as ProfileServiceOperationParams)
          : await input.client.call(method, call as ProfileServiceCallParams)
      input.reply(response, 200, result)
    } catch {
      input.reply(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
    }
    return true
  }
}
