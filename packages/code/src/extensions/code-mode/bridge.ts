import type { ToolContext } from '@agnes/extension-api'
import { type BridgeResponse, validateBridgeFrame } from '@agnes/protocol'
import type { BridgeHandler } from '../../runtime/index.js'
import { bridgeDispatch } from './bridge-dispatch.js'
import { bridgeError, toBridgeError } from './bridge-errors.js'
import { copyBridgeData, parseBridgeRequest } from './bridge-frame.js'

export { hasBridgeCode, toBridgeError } from './bridge-errors.js'
export { BRIDGE_METHODS, type BridgeMethod } from './bridge-frame.js'

export function createBridge(ctx: ToolContext, opts: { maxBytes?: number } = {}): BridgeHandler {
  return async (frame) => {
    const parsed = parseBridgeRequest(frame, opts)
    if (!parsed.ok) return parsed.response
    const { id } = parsed.request
    const fail = (error: ReturnType<typeof toBridgeError>): BridgeResponse => ({ jsonrpc: '2.0', id, error })
    if (ctx.signal.aborted) return fail(bridgeError(-32800))
    let abort: () => void = () => {}
    try {
      const dispatch = bridgeDispatch(ctx, parsed.request)
      const cancelled = new Promise<BridgeResponse>((resolve) => {
        abort = () => resolve(fail(bridgeError(-32800)))
        ctx.signal.addEventListener('abort', abort, { once: true })
      })
      const running = Promise.resolve().then(async (): Promise<BridgeResponse> => {
        if (ctx.signal.aborted) return fail(bridgeError(-32800))
        try {
          const result = await dispatch()
          if (ctx.signal.aborted) return fail(bridgeError(-32800))
          const reply = copyBridgeData(
            { jsonrpc: '2.0', id, result: result ?? null },
            opts.maxBytes ?? 1048576,
          )
          const check = validateBridgeFrame(reply)
          return check.ok ? (check.value as BridgeResponse) : fail(bridgeError(-32603))
        } catch (error) {
          return fail(toBridgeError(error))
        }
      })
      return await Promise.race([running, cancelled])
    } catch (error) {
      return fail(toBridgeError(error))
    } finally {
      ctx.signal.removeEventListener('abort', abort)
    }
  }
}
