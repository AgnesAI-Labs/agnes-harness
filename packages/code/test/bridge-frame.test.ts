import { validateBridgeFrame } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { BRIDGE_METHODS, parseBridgeRequest } from '../src/extensions/code-mode/bridge-frame.js'

const frame = (args: unknown = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'bridge.tools.invoke',
  params: { name: 'read', args },
})
function rejected(value: unknown, code: number, opts?: { maxBytes?: number }) {
  const result = parseBridgeRequest(value, opts)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected refusal')
  expect(result.response).toMatchObject({ error: { code } })
  expect(validateBridgeFrame(result.response).ok).toBe(true)
}
it('accepts a protocol-valid request and returns detached data', () => {
  const input = frame({ path: 'a' })
  const parsed = parseBridgeRequest(input)
  expect(parsed).toEqual({ ok: true, request: input })
  input.params.args = { path: 'b' }
  if (!parsed.ok) throw new Error('unexpected refusal')
  expect(parsed.request.params).toEqual({ name: 'read', args: { path: 'a' } })
})
it('exposes eight immutable methods with no direct harness mutation method', () => {
  expect(BRIDGE_METHODS).toHaveLength(8)
  expect(BRIDGE_METHODS).not.toContain('bridge.harness.propose')
  expect(Object.isFrozen(BRIDGE_METHODS)).toBe(true)
})
it('enforces the actual default one-MiB UTF-8 boundary', () => {
  const overhead = Buffer.byteLength(JSON.stringify(frame({ blob: '' })))
  const exact = frame({ blob: 'x'.repeat(1048576 - overhead) })
  expect(parseBridgeRequest(exact).ok).toBe(true)
  rejected(frame({ blob: 'x'.repeat(1048577 - overhead) }), -32600)
})
it('counts multibyte characters and JSON escaping as wire bytes', () => {
  const input = frame({ text: '界\n😀' })
  const bytes = Buffer.byteLength(JSON.stringify(input))
  expect(parseBridgeRequest(input, { maxBytes: bytes }).ok).toBe(true)
  rejected(input, -32600, { maxBytes: bytes - 1 })
})
it.each([0, -1, NaN, Infinity, 1.1, 1048577])('refuses invalid or widened byte cap %j', (maxBytes) => {
  expect(() => parseBridgeRequest(frame(), { maxBytes })).toThrow('byte limit')
})
it.each([
  null,
  [],
  'text',
  { jsonrpc: '2.0', id: 1, result: {} },
  { ...frame(), id: null },
  { ...frame(), id: 2 ** 53 },
  { ...frame(), actor: 'root' },
])('refuses invalid request envelopes %j', (input) => rejected(input, -32600))
it('distinguishes unknown methods and invalid known-method parameters', () => {
  rejected({ ...frame(), method: 'bridge.fs.write' }, -32601)
  rejected({ ...frame(), params: { name: '9bad', args: {} } }, -32602)
  rejected({ ...frame(), params: { name: 'read', args: {}, depth: 99 } }, -32602)
})
it('never calls getters or toJSON supplied as frame data', () => {
  let calls = 0
  const getter = {
    ...frame(),
    get extra() {
      calls++
      return null
    },
  }
  rejected(getter, -32600)
  rejected(
    {
      ...frame(),
      toJSON() {
        calls++
        return frame()
      },
    },
    -32600,
  )
  expect(calls).toBe(0)
})
it('refuses cycles, sparse arrays, functions, nonfinite and overly deep values', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [cycle, Array(2), () => {}, NaN, Infinity, 1n]) rejected(frame(value), -32600)
  let deep: unknown = null
  for (let i = 0; i < 70; i++) deep = [deep]
  rejected(frame(deep), -32600)
})
