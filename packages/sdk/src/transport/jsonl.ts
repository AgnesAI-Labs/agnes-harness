// JSONL framing: one message per line, UTF-8, with the 16 MiB ceiling protocol defines.
import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { ProtocolViolation } from '../errors.js'
import type { JsonRpcMessage } from './types.js'

const enc = new TextEncoder()
// fatal: true - bad UTF-8 throws instead of turning quietly into U+FFFD, and push() turns
// the throw into a ProtocolViolation.
const dec = new TextDecoder('utf-8', { fatal: true })

// One ruler for both ends, and for all three transports: MAX_FRAME_BYTES measures the UTF-8
// bytes of the message itself and does not count the `\n` terminator. The decoder measures
// a line's content and a websocket measures one text frame, neither of which includes the
// terminator; counting it here would leave a band of frames the decoder accepts and this
// package can never send.
export function encodeFrame(msg: JsonRpcMessage): Uint8Array {
  const json = enc.encode(JSON.stringify(msg))
  if (json.byteLength > MAX_FRAME_BYTES)
    throw new ProtocolViolation(
      `outbound frame ${json.byteLength} bytes exceeds ${MAX_FRAME_BYTES}`,
      'frame-too-large',
    )
  const out = new Uint8Array(json.byteLength + 1)
  out.set(json)
  out[json.byteLength] = 0x0a
  return out
}

export function parseMessage(text: string): JsonRpcMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProtocolViolation('invalid json frame', 'invalid-json')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { jsonrpc?: unknown }).jsonrpc !== '2.0'
  )
    throw new ProtocolViolation('frame is not JSON-RPC 2.0', 'invalid-envelope')
  const m = parsed as Record<string, unknown>
  const has = (key: string) => Object.hasOwn(m, key)
  const validId = typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id))
  const validError =
    m.error !== null &&
    typeof m.error === 'object' &&
    typeof (m.error as { code?: unknown }).code === 'number' &&
    typeof (m.error as { message?: unknown }).message === 'string'
  const valid = has('method')
    ? typeof m.method === 'string' && (!has('id') || validId) && !has('result') && !has('error')
    : has('id') &&
      (validId || m.id === null) &&
      has('result') !== has('error') &&
      (!has('error') || validError)
  if (!valid) throw new ProtocolViolation('invalid JSON-RPC envelope', 'invalid-envelope')
  return parsed as JsonRpcMessage
}

export class FrameDecoder {
  // Bytes are buffered, not strings: a multi-byte character can be split across a chunk
  // boundary, and decoding chunk by chunk fails on half a code point (or produces U+FFFD
  // without saying so). A line is decoded once, when all of it has arrived.
  private chunks: Uint8Array[] = []
  private size = 0
  // Framing that has lost sync cannot recover: the rest of an oversized frame would be
  // parsed as the next frame, which is silent resynchronisation. Once this decoder has
  // thrown it refuses to be used again - a bad stream has to break loudly, and the read
  // loop closes the connection on it.
  private poisoned = false

  push(chunk: Uint8Array): JsonRpcMessage[] {
    return this.guard(() => this.scan(chunk))
  }

  // Half a line left in the buffer at the end of the stream means the peer died mid-frame,
  // which must not be swallowed as an ordinary EOF.
  end(): void {
    this.guard(() => {
      if (this.size) throw new ProtocolViolation('stream ended mid-frame', 'truncated-frame')
    })
  }

  private guard<T>(body: () => T): T {
    if (this.poisoned)
      throw new ProtocolViolation('frame decoder is unusable after a protocol violation', 'decoder-poisoned')
    try {
      return body()
    } catch (e) {
      this.poisoned = true
      this.reset()
      throw e
    }
  }

  private scan(chunk: Uint8Array): JsonRpcMessage[] {
    const out: JsonRpcMessage[] = []
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue
      const line = this.take(chunk.subarray(start, i))
      start = i + 1
      if (line.trim()) out.push(parseMessage(line))
    }
    const rest = chunk.subarray(start)
    if (rest.length) {
      this.chunks.push(rest)
      this.size += rest.length
    }
    // The ceiling applies to an unterminated line too: waiting for a newline before
    // noticing means one enormous newline-free frame can exhaust memory first.
    if (this.size > MAX_FRAME_BYTES)
      throw new ProtocolViolation(`inbound frame exceeds ${MAX_FRAME_BYTES}`, 'frame-too-large')
    return out
  }

  private take(tail: Uint8Array): string {
    const total = this.size + tail.length
    if (total > MAX_FRAME_BYTES)
      throw new ProtocolViolation(`inbound frame exceeds ${MAX_FRAME_BYTES}`, 'frame-too-large')
    const buf = new Uint8Array(total)
    let off = 0
    for (const c of this.chunks) {
      buf.set(c, off)
      off += c.length
    }
    buf.set(tail, off)
    this.reset()
    try {
      return dec.decode(buf)
    } catch {
      throw new ProtocolViolation('frame is not valid utf-8', 'invalid-utf8')
    }
  }

  private reset(): void {
    this.chunks = []
    this.size = 0
  }
}
