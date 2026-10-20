import type { ToolContext } from '@agnes/extension-api'
import { type BridgeResponse, validateBridgeFrame } from '@agnes/protocol'
import type { BridgeHandler } from '../../runtime/index.js'
import { bridgeDispatch, type NestedCallStatus } from './bridge-dispatch.js'
import { bridgeError, toBridgeError } from './bridge-errors.js'
import { copyBridgeData, parseBridgeRequest } from './bridge-frame.js'

export { hasBridgeCode, toBridgeError } from './bridge-errors.js'
export { BRIDGE_METHODS, type BridgeMethod } from './bridge-frame.js'

export type NestedCall = { name: string; status: NestedCallStatus; readOnly: boolean }
/** A bridge handler that also remembers how each nested tool call ended. */
export type RecordingBridge = BridgeHandler & { calls(): ReadonlyArray<NestedCall> }

export function createBridge(
  ctx: ToolContext,
  opts: { maxBytes?: number; maxParallel?: number; maxCalls?: number; toolsOnly?: boolean } = {},
): RecordingBridge {
  let active = 0
  let calls = 0
  // Once a call parked for approval, the rest of the cell must not start more work behind it.
  let parked = false
  const nested: NestedCall[] = []
  const record = (name: string, status: NestedCallStatus) => {
    let readOnly = false
    try {
      readOnly = ctx.tools.list().find((def) => def.name === name)?.meta.isReadOnly === true
    } catch {
      /* An unknown tool counts as not read-only. */
    }
    nested.push({ name, status, readOnly })
  }
  const handler: BridgeHandler = async (frame) => {
    const parsed = parseBridgeRequest(frame, opts)
    if (!parsed.ok) return parsed.response
    const { id } = parsed.request
    const fail = (error: ReturnType<typeof toBridgeError>): BridgeResponse => ({ jsonrpc: '2.0', id, error })
    if (opts.toolsOnly && parsed.request.method !== 'bridge.tools.invoke') return fail(bridgeError(-32601))
    if (ctx.signal.aborted) return fail(bridgeError(-32800))
    if (parked) return fail(bridgeError(1006))
    if (++calls > (opts.maxCalls ?? 256)) return fail(bridgeError(1001))
    if (active >= (opts.maxParallel ?? 4)) return fail(bridgeError(1001))
    active++
    let abort: () => void = () => {}
    try {
      const dispatch = bridgeDispatch(ctx, parsed.request, record)
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
          const mapped = toBridgeError(error)
          if (mapped.code === 1006) parked = true
          return fail(mapped)
        }
      })
      return await Promise.race([running, cancelled])
    } catch (error) {
      return fail(toBridgeError(error))
    } finally {
      active--
      ctx.signal.removeEventListener('abort', abort)
    }
  }
  return Object.assign(handler, { calls: () => nested.slice() })
}
