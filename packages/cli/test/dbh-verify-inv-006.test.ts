import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { FrameTooLarge, splitLines } from '../src/modes/jsonl.js'

// DBH INV-006 verification. Oracle is external to the implementation under test:
// packages/protocol/src/constants.ts:53-54 defines MAX_FRAME_BYTES as "UTF-8 JSON message bytes,
// excluding the JSONL delimiter (LF)". splitLines() itself already treats CRLF as a delimiter
// (jsonl.ts:22 strips the CR before pushing the line), so a body of exactly MAX_FRAME_BYTES must
// be accepted under either delimiter. jsonl.ts:21 measures the ceiling against the LF *index*,
// which counts the CR as payload.
describe('DBH INV-006: JSONL frame ceiling must not count the CR of a CRLF delimiter', () => {
  const body = (): Buffer => Buffer.alloc(MAX_FRAME_BYTES, 0x20)

  it('[control] accepts a MAX_FRAME_BYTES body terminated by LF', () => {
    const split = splitLines()
    const lines = split(Buffer.concat([body(), Buffer.from('\n')]))
    expect(lines).toHaveLength(1)
    expect(Buffer.byteLength(lines[0] as string, 'utf8')).toBe(MAX_FRAME_BYTES)
  })

  it('accepts the same MAX_FRAME_BYTES body terminated by CRLF', () => {
    const split = splitLines()
    const lines = split(Buffer.concat([body(), Buffer.from('\r\n')]))
    expect(lines).toHaveLength(1)
    expect(Buffer.byteLength(lines[0] as string, 'utf8')).toBe(MAX_FRAME_BYTES)
  })

  // Same root cause on the sibling path: jsonl.ts:26 bounds the not-yet-framed buffer with the same
  // ruler, so a CRLF landing on a chunk boundary rejects the identical body. A TCP/pipe read is
  // free to split anywhere, so this is the form a 16 MiB frame actually arrives in.
  it('accepts a MAX_FRAME_BYTES body whose CRLF is split across chunks', () => {
    const split = splitLines()
    expect(split(Buffer.concat([body(), Buffer.from('\r')]))).toEqual([])
    const lines = split(Buffer.from('\n'))
    expect(lines).toHaveLength(1)
    expect(Buffer.byteLength(lines[0] as string, 'utf8')).toBe(MAX_FRAME_BYTES)
  })

  // Preservation: the ceiling still has to reject a body that is genuinely one byte over, under
  // either delimiter. Widening the bound instead of correcting the ruler would lose this.
  it('[preserve] still rejects a body one byte over the ceiling', () => {
    const over = (): Buffer => Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20)
    expect(() => splitLines()(Buffer.concat([over(), Buffer.from('\n')]))).toThrow(FrameTooLarge)
    expect(() => splitLines()(Buffer.concat([over(), Buffer.from('\r\n')]))).toThrow(FrameTooLarge)
    expect(() => splitLines()(over())).toThrow(FrameTooLarge)
  })
})
