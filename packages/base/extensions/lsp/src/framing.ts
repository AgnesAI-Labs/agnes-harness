// LSP wire framing: `Content-Length: <bytes>\r\n\r\n<json>`. The length counts UTF-8 bytes, not
// characters, so a message with CJK text is longer on the wire than `.length` says.
const SEP = Buffer.from('\r\n\r\n')
const MAX_FRAME_BYTES = 32 * 1024 * 1024

export function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

/** Incremental decoder: feed it output chunks of any size, get back every message completed so far. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: string): unknown[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk, 'utf8')])
    const out: unknown[] = []
    for (;;) {
      const end = this.buf.indexOf(SEP)
      if (end < 0) return out
      const length = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('latin1'))?.[1]
      const start = end + SEP.length
      if (length === undefined) {
        // Not a frame header (stray log output); drop it and resynchronise on the next separator.
        this.buf = this.buf.subarray(start)
        continue
      }
      const size = Number(length)
      if (size > MAX_FRAME_BYTES) throw new Error('language server frame is too large')
      if (this.buf.length < start + size) return out
      try {
        out.push(JSON.parse(this.buf.subarray(start, start + size).toString('utf8')))
      } catch {
        // A frame that is not JSON is skipped; the stream stays aligned on the declared length.
      }
      this.buf = this.buf.subarray(start + size)
    }
  }
}
