import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { httpRpcError, normalizeRpcError, type RpcError } from '@agnes/protocol'
import { PLAN_MODE_BODY_LIMIT, PLAN_MODE_PATH, WORKSPACE_PICKER_PATH } from './server-assets.js'
import { json, readLimitedBody } from './server-http.js'
import { acceptsWebRequest } from './server-security.js'
import type { WebServerOptions } from './server-types.js'

/** One picker per listener, with the same cancellation lifecycle as the server. */
export function createWorkspacePickerRoute(
  expectedOrigin: string,
  options: Pick<WebServerOptions, 'workspacePicker'>,
) {
  let pickerPending = false
  let activePicker: AbortController | undefined
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!acceptsWebRequest('exact-navigation', expectedOrigin, request, WORKSPACE_PICKER_PATH)) {
      json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
      return
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' }).end()
      return
    }
    if (request.method === 'GET') {
      const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
      json(response, 200, { available })
      return
    }
    if (!acceptsWebRequest('post-origin', expectedOrigin, request)) {
      json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
      return
    }
    if (
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? '0') !== 0
    ) {
      json(response, 400, { error: { code: 'INVALID_REQUEST' } })
      return
    }
    if (pickerPending) {
      json(response, 409, { error: { code: 'PICKER_BUSY' } })
      return
    }
    pickerPending = true
    const controller = new AbortController()
    activePicker = controller
    const abort = (): void => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
      if (controller.signal.aborted && !response.writableEnded) return
      if (!available || !options.workspacePicker) {
        json(response, 503, { status: 'unavailable' })
        return
      }
      const result = await options.workspacePicker
        .pick(controller.signal)
        .catch(() => ({ status: 'unavailable' }) as const)
      if (controller.signal.aborted && !response.writableEnded) return
      if (
        result.status === 'selected' &&
        (result.path.length === 0 ||
          result.path.length > 4096 ||
          result.path.includes('\0') ||
          !isAbsolute(result.path))
      ) {
        json(response, 503, { status: 'unavailable' })
        return
      }
      json(response, result.status === 'unavailable' ? 503 : 200, result)
    } finally {
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
      if (activePicker === controller) activePicker = undefined
      pickerPending = false
    }
  }
  return { handle, close: () => activePicker?.abort() }
}

export async function handlePlanMode(
  request: IncomingMessage,
  response: ServerResponse,
  expectedOrigin: string,
  options: Pick<WebServerOptions, 'planCommand'>,
): Promise<void> {
  if (!acceptsWebRequest('exact-navigation', expectedOrigin, request, PLAN_MODE_PATH)) {
    json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end()
    return
  }
  if (!acceptsWebRequest('post-origin', expectedOrigin, request)) {
    json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
    return
  }
  const contentType = request.headers['content-type']
  if (
    request.headers['transfer-encoding'] !== undefined ||
    typeof contentType !== 'string' ||
    !contentType.startsWith('application/json')
  ) {
    json(response, 400, { error: { code: 'INVALID_REQUEST' } })
    return
  }
  const length = Number(request.headers['content-length'] ?? '')
  if (!Number.isInteger(length) || length < 2 || length > PLAN_MODE_BODY_LIMIT) {
    json(response, 400, { error: { code: 'INVALID_REQUEST' } })
    return
  }
  let raw: string
  try {
    raw = await readLimitedBody(request, length)
  } catch {
    if (!response.writableEnded) json(response, 400, { error: { code: 'INVALID_REQUEST' } })
    return
  }
  let parsed: { cwd?: unknown; line?: unknown; sessionId?: unknown }
  try {
    parsed = JSON.parse(raw) as { cwd?: unknown; line?: unknown; sessionId?: unknown }
  } catch {
    json(response, 400, { error: { code: 'INVALID_REQUEST' } })
    return
  }
  if (
    typeof parsed.cwd !== 'string' ||
    typeof parsed.line !== 'string' ||
    (parsed.sessionId !== undefined && typeof parsed.sessionId !== 'string')
  ) {
    json(response, 400, { error: { code: 'INVALID_REQUEST' } })
    return
  }
  if (!options.planCommand) {
    json(response, 503, { error: httpRpcError(503, 'UNAVAILABLE') })
    return
  }
  try {
    json(
      response,
      200,
      await options.planCommand({
        cwd: parsed.cwd,
        line: parsed.line,
        ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
      }),
    )
  } catch (error) {
    const rpc = (error as { rpc?: RpcError })?.rpc
    json(response, rpc?.code === -32006 ? 403 : 400, {
      error: rpc ? normalizeRpcError(rpc) : httpRpcError(400, 'INVALID_REQUEST'),
    })
  }
}
