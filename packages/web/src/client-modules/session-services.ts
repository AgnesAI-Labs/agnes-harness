import { JsonRpcError } from '@agnes/sdk/browser'
import type { ClientEffectCaller, ClientServiceCaller } from '@agnes/web-client'
import type { Translate } from '@agnes/web-conversation/presentation'

export function clientSessionServices(t: Translate) {
  const call = async (
    request: { rowId: string; sessionId: string; service: string; input: Record<string, unknown> },
    options: { commandId: string } | { signal: AbortSignal },
  ) => {
    const commandId = 'commandId' in options ? options.commandId : undefined
    const effect = commandId !== undefined
    const response = await fetch(effect ? '/api/client-modules/effect' : '/api/client-modules/service', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...('signal' in options ? { signal: options.signal } : {}),
      body: JSON.stringify(effect ? { ...request, commandId } : request),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const unavailable = t(effect ? 'app.plugin.effectUnavailable' : 'app.plugin.serviceUnavailable')
      const failure = (body as { error?: { code?: unknown; data?: { code?: unknown } } } | null)?.error
      const code = failure?.data?.code
      if (
        typeof failure?.code === 'number' &&
        typeof code === 'string' &&
        (effect || code === 'GENERATION_STALE')
      )
        throw new JsonRpcError({ code: failure.code, message: unavailable, data: { code } })
      throw new Error(unavailable)
    }
    if (!body || typeof body !== 'object' || !('output' in body))
      throw new Error(t(effect ? 'app.plugin.effectInvalid' : 'app.plugin.serviceInvalid'))
    return body.output
  }
  const clientServiceCaller: ClientServiceCaller = (module, sessionId, service, input, signal) =>
    call({ rowId: module.rowId ?? module.packageId, sessionId, service, input }, { signal })
  const clientEffectCaller: ClientEffectCaller = (module, sessionId, service, commandId, input) =>
    call({ rowId: module.rowId ?? module.packageId, sessionId, service, input }, { commandId })
  return { clientServiceCaller, clientEffectCaller }
}
