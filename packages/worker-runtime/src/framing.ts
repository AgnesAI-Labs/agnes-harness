import { MAX_FRAME_BYTES } from '@agnes/protocol'

export class FrameTooLarge extends Error {
  override name = 'FrameTooLarge'
  constructor() {
    super('frame exceeds byte limit')
  }
}
export class InvalidFrame extends Error {
  override name = 'InvalidFrame'
  constructor() {
    super('invalid or incomplete JSONL frame')
  }
}

/** Bounded byte accumulation; a failed stream must never silently resynchronize. */
export class JsonlDecoder {
  private buffer = Buffer.alloc(0)
  private size = 0
  private closed = false
  private readonly maxBytes: number
  constructor(maxBytes = MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES)
      throw new InvalidFrame()
    this.maxBytes = maxBytes
  }
  feed(chunk: Buffer): unknown[] {
    if (this.closed) throw new InvalidFrame()
    try {
      const out: unknown[] = []
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        this.append(chunk.subarray(start, end))
        if (newline < 0) break
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.size))
        this.size = 0
        if (text.trim()) out.push(JSON.parse(text))
        start = newline + 1
      }
      return out
    } catch (error) {
      this.closed = true
      this.buffer = Buffer.alloc(0)
      this.size = 0
      if (error instanceof FrameTooLarge) throw error
      throw new InvalidFrame()
    }
  }
  end(): void {
    const invalid = this.closed || this.size !== 0
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.size = 0
    if (invalid) throw new InvalidFrame()
  }
  private append(part: Buffer): void {
    const total = this.size + part.length
    if (total > this.maxBytes) throw new FrameTooLarge()
    if (total > this.buffer.length) {
      const next = Buffer.alloc(Math.min(this.maxBytes, Math.max(total, this.buffer.length * 2, 256)))
      this.buffer.copy(next, 0, 0, this.size)
      this.buffer = next
    }
    part.copy(this.buffer, this.size)
    this.size = total
  }
}
export function encodeFrame(msg: unknown): Buffer {
  let json: string | undefined
  try {
    json = JSON.stringify(msg)
  } catch {
    throw new InvalidFrame()
  }
  if (json === undefined) throw new InvalidFrame()
  if (Buffer.byteLength(json, 'utf8') > MAX_FRAME_BYTES) throw new FrameTooLarge()
  return Buffer.from(`${json}\n`, 'utf8')
}
