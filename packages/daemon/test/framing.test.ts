import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { encodeFrame, FrameTooLarge, InvalidFrame, JsonlDecoder } from '../src/supervisor/framing.js'

it('round trips fragmented unicode and coalesced messages without retaining caller bytes', () => {
  const d = new JsonlDecoder()
  const bytes = encodeFrame({ text: '中文🙂' })
  for (const byte of bytes.subarray(0, bytes.length - 1)) {
    const input = Buffer.from([byte])
    expect(d.feed(input)).toEqual([])
    input.fill(0)
  }
  expect(d.feed(Buffer.from('\n \r\nnull\n42\n'))).toEqual([{ text: '中文🙂' }, null, 42])
  d.end()
})
it('uses the actual default byte cap symmetrically without counting LF', () => {
  const value = 'x'.repeat(MAX_FRAME_BYTES - 2)
  const frame = encodeFrame(value)
  expect(frame.length).toBe(MAX_FRAME_BYTES + 1)
  const d = new JsonlDecoder()
  expect(d.feed(frame)).toEqual([value])
  d.end()
  expect(() => encodeFrame(`${value}x`)).toThrow(FrameTooLarge)
  expect(() => new JsonlDecoder().feed(Buffer.from(`"${value}x"\n`))).toThrow(FrameTooLarge)
})
it('checks a trailing oversized fragment even after valid complete frames', () => {
  const d = new JsonlDecoder(8)
  expect(() => d.feed(Buffer.from('0\n123456789'))).toThrow(FrameTooLarge)
  expect(() => d.feed(Buffer.from('0\n'))).toThrow(InvalidFrame)
})
it('enforces the byte rather than character count across chunks', () => {
  const d = new JsonlDecoder(5)
  expect(d.feed(Buffer.from('"中'))).toEqual([])
  expect(() => d.feed(Buffer.from('中"\n'))).toThrow(FrameTooLarge)
})
it.each([Buffer.from('"PRIVATE\n'), Buffer.from([34, 255, 34, 10])])(
  'rejects malformed input with fixed errors and poisons the decoder',
  (bytes) => {
    const d = new JsonlDecoder()
    expect(() => d.feed(bytes)).toThrow('invalid or incomplete JSONL frame')
    expect(() => d.feed(Buffer.from('0\n'))).toThrow(InvalidFrame)
  },
)
it('rejects truncated EOF and input after successful EOF', () => {
  const d = new JsonlDecoder()
  d.feed(Buffer.from('0'))
  expect(() => d.end()).toThrow(InvalidFrame)
  const clean = new JsonlDecoder()
  clean.end()
  expect(() => clean.feed(Buffer.from('0\n'))).toThrow(InvalidFrame)
})
it.each([
  undefined,
  1n,
  () => {},
  {
    toJSON: () => {
      throw new Error('PRIVATE')
    },
  },
])('rejects unserializable output without exposing data', (value) => {
  expect(() => encodeFrame(value)).toThrow('invalid or incomplete JSONL frame')
})
