import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ProtocolViolation } from '../src/errors.js'
import { encodeFrame, FrameDecoder } from '../src/transport/jsonl.js'
import { classify } from '../src/transport/types.js'

describe('jsonl framing', () => {
  it('encodes one message per line and decodes across chunk boundaries', () => {
    const a = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const b = encodeFrame({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } })
    const all = new Uint8Array([...a, ...b])
    const d = new FrameDecoder()
    const first = d.push(all.subarray(0, 10))
    const rest = d.push(all.subarray(10))
    expect(first).toEqual([])
    expect(rest.map(classify)).toEqual(['request', 'notification'])
  })

  it('splits a multibyte character across chunks without corrupting it', () => {
    const frame = encodeFrame({ jsonrpc: '2.0', method: 'm', params: { s: '漢字🌱' } })
    const d = new FrameDecoder()
    for (let i = 0; i < frame.length; i++) d.push(frame.subarray(i, i + 1))
    const out = new FrameDecoder().push(frame)
    expect(out).toEqual([{ jsonrpc: '2.0', method: 'm', params: { s: '漢字🌱' } }])
  })

  it('rejects frames over 16 MiB on both directions', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES)
    expect(() => encodeFrame({ jsonrpc: '2.0', method: 'm', params: { big } })).toThrow(ProtocolViolation)
    const d = new FrameDecoder()
    expect(() => d.push(new TextEncoder().encode(`{"jsonrpc":"2.0","method":"m","params":"${big}"`))).toThrow(
      ProtocolViolation,
    )
  })

  it('rejects bad json and messages without jsonrpc', () => {
    // One decoder per assertion: a decoder that has thrown is poisoned, and sharing one
    // would make the second assertion true whatever the input.
    expect(() => new FrameDecoder().push(new TextEncoder().encode('{nope}\n'))).toThrow(ProtocolViolation)
    expect(() => new FrameDecoder().push(new TextEncoder().encode('{"id":1}\n'))).toThrow(ProtocolViolation)
  })

  // The ceiling measures the message itself and does not count the `\n` terminator. Both
  // ends use the same ruler, so exactly at the limit passes on both and one byte over
  // throws on both.
  const atSize = (n: number) => {
    const shell = JSON.stringify({ jsonrpc: '2.0', method: 'm', params: '' }).length
    return { jsonrpc: '2.0' as const, method: 'm', params: 'x'.repeat(n - shell) }
  }

  it('encodes a frame exactly at the limit and rejects one byte more', () => {
    const frame = encodeFrame(atSize(MAX_FRAME_BYTES))
    // MAX bytes of message plus one newline: the newline is not part of the budget.
    expect(frame.byteLength).toBe(MAX_FRAME_BYTES + 1)
    expect(() => encodeFrame(atSize(MAX_FRAME_BYTES + 1))).toThrow(ProtocolViolation)
  })

  it('decodes a frame exactly at the limit and rejects one byte more', () => {
    const shell = JSON.stringify({ jsonrpc: '2.0', method: 'm', params: '' }).length
    const out = new FrameDecoder().push(encodeFrame(atSize(MAX_FRAME_BYTES)))
    expect(out).toHaveLength(1)
    expect((out[0] as { params: string }).params.length).toBe(MAX_FRAME_BYTES - shell)
    const over = new TextEncoder().encode(`${JSON.stringify(atSize(MAX_FRAME_BYTES + 1))}\n`)
    expect(() => new FrameDecoder().push(over)).toThrow(ProtocolViolation)
  })

  it('is unusable after a violation instead of silently resynchronising', () => {
    const d = new FrameDecoder()
    // Parsing the leftover bytes of a rejected frame as a new frame is silent
    // resynchronisation: a bad stream has to break loudly.
    expect(() => d.push(new TextEncoder().encode('{nope}\n'))).toThrow(ProtocolViolation)
    expect(() => d.push(encodeFrame({ jsonrpc: '2.0', method: 'm' }))).toThrow(
      /unusable after a protocol violation/,
    )
    expect(() => d.end()).toThrow(/unusable after a protocol violation/)
  })

  it('classifies by the three-way rule', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response')
    expect(
      classify({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'x', data: { code: 'x' } } }),
    ).toBe('response')
    expect(classify({ jsonrpc: '2.0', id: 'a', method: 'x' })).toBe('request')
    expect(classify({ jsonrpc: '2.0', method: 'x' })).toBe('notification')
  })

  it('end() throws when the stream stops mid-frame and is silent on a clean boundary', () => {
    const d = new FrameDecoder()
    d.push(new TextEncoder().encode('{"jsonrpc":"2.0","method":"m"'))
    expect(() => d.end()).toThrow(ProtocolViolation)
    const clean = new FrameDecoder()
    clean.push(encodeFrame({ jsonrpc: '2.0', method: 'm' }))
    expect(() => clean.end()).not.toThrow()
  })
})
