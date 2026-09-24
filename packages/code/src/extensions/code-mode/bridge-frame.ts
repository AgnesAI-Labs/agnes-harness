import {
  type BridgeRequest,
  type BridgeResponse,
  type BridgeMethod as ProtocolBridgeMethod,
  validateBridgeFrame,
} from '@agnes/protocol'

export const BRIDGE_METHODS = Object.freeze([
  'bridge.tools.invoke',
  'bridge.subagent.spawn',
  'bridge.subagent.fork',
  'bridge.subagent.collect',
  'bridge.artifacts.put',
  'bridge.artifacts.get',
  'bridge.plan.set',
  'bridge.log',
] as const satisfies readonly ProtocolBridgeMethod[])
export type BridgeMethod = (typeof BRIDGE_METHODS)[number]
export type ParsedBridgeRequest =
  | { ok: true; request: BridgeRequest }
  | { ok: false; response: BridgeResponse }

/** Serialize data only, with a running byte budget; never call toJSON or property getters. */
export function copyBridgeData(input: unknown, maxBytes: number): unknown {
  let used = 0
  const active = new Set<object>()
  const token = (text: string) => {
    used += Buffer.byteLength(text, 'utf8')
    if (used > maxBytes) throw new Error('oversized')
    return text
  }
  const encode = (value: unknown, depth: number): string => {
    if (depth > 64) throw new Error('deep')
    if (value === null || typeof value === 'boolean') return token(JSON.stringify(value))
    if (typeof value === 'number' && Number.isFinite(value)) return token(JSON.stringify(value))
    if (typeof value === 'string') {
      if (value.length > maxBytes) throw new Error('oversized')
      return token(JSON.stringify(value))
    }
    if (!value || typeof value !== 'object' || active.has(value)) throw new Error('non-json')
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('non-data')
    active.add(value)
    try {
      const props = Object.getOwnPropertyDescriptors(value)
      if (Object.getOwnPropertySymbols(value).length) throw new Error('symbol')
      const keys = Object.keys(props).filter((key) => !(array && key === 'length'))
      if (array && keys.length !== value.length) throw new Error('sparse')
      const parts = [token(array ? '[' : '{')]
      for (const [i, key] of keys.entries()) {
        const prop = props[key]
        if (!prop || !('value' in prop) || !prop.enumerable || (array && key !== String(i)))
          throw new Error('non-data')
        if (i) parts.push(token(','))
        if (!array) parts.push(token(JSON.stringify(key)), token(':'))
        parts.push(encode(prop.value, depth + 1))
      }
      parts.push(token(array ? ']' : '}'))
      return parts.join('')
    } finally {
      active.delete(value)
    }
  }
  return JSON.parse(encode(input, 0)) as unknown
}

export function parseBridgeRequest(frame: unknown, opts: { maxBytes?: number } = {}): ParsedBridgeRequest {
  const maxBytes = opts.maxBytes ?? 1048576
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1048576)
    throw new Error('invalid bridge frame byte limit')
  const fail = (
    id: number | string | null,
    code: -32600 | -32601 | -32602,
    message: string,
  ): ParsedBridgeRequest => ({ ok: false, response: { jsonrpc: '2.0', id, error: { code, message } } })
  let data: unknown
  try {
    data = copyBridgeData(frame, maxBytes)
  } catch {
    return fail(null, -32600, 'invalid or oversized bridge frame')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return fail(null, -32600, 'invalid bridge request')
  const f = data as Record<string, unknown>
  const id =
    typeof f.id === 'string' || (typeof f.id === 'number' && Number.isSafeInteger(f.id)) ? f.id : null
  if (
    id === null ||
    f.jsonrpc !== '2.0' ||
    typeof f.method !== 'string' ||
    !Object.hasOwn(f, 'params') ||
    Object.keys(f).length !== 4
  )
    return fail(id, -32600, 'invalid bridge request')
  if (!(BRIDGE_METHODS as readonly string[]).includes(f.method))
    return fail(id, -32601, 'unknown bridge method')
  const checked = validateBridgeFrame(f)
  if (!checked.ok) return fail(id, -32602, 'invalid bridge parameters')
  return { ok: true, request: { jsonrpc: '2.0', id, method: f.method, params: f.params } as BridgeRequest }
}
