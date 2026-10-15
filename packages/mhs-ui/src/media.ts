import { type Data, number, record, text } from './model.js'
export type Sample = {
  device: string
  source: string
  at: number
  data: Data
  mime: string
  bytes?: Uint8Array
}
export function sampleFrom(frame: unknown): Sample {
  let raw: unknown = frame,
    bytes: Uint8Array | undefined
  if (frame instanceof Uint8Array) {
    if (frame.byteLength < 4 || frame.byteLength > 1 << 20) throw new Error('invalid-media-frame')
    const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
    if (length > 65536 || length + 4 > frame.byteLength) throw new Error('invalid-media-frame')
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, length + 4)))
    if (frame.byteLength > length + 4) bytes = frame.slice(length + 4)
  }
  const value = record(raw)
  if (
    !text(value.device) ||
    !text(value.source) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at)
  )
    throw new Error('invalid-media-frame')
  return {
    device: text(value.device),
    source: text(value.source),
    at: number(value.at),
    data: record(value.data),
    mime: text(value.mime),
    ...(bytes ? { bytes } : {}),
  }
}
/** Own every decoder/frame/URL. One bounded latest frame; no replay after a drop. */
export class VideoView {
  private decoder: VideoDecoder | undefined
  private needsKey = true
  private closed = false
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly failed: () => void,
  ) {}
  push(sample: Sample) {
    if (this.closed || !sample.bytes) return
    if (typeof VideoDecoder === 'undefined') {
      this.failed()
      return
    }
    const data = sample.data,
      key = data.key === true || data.keyframe === true || data.type === 'key'
    if (!this.decoder) {
      const codec = text(data.codec)
      if (!codec.startsWith('avc1.')) {
        this.failed()
        return
      }
      this.decoder = new VideoDecoder({
        output: (frame) => {
          try {
            this.canvas.width = frame.displayWidth
            this.canvas.height = frame.displayHeight
            this.canvas.getContext('2d')?.drawImage(frame, 0, 0)
          } finally {
            frame.close()
          }
        },
        error: () => {
          this.needsKey = true
          this.failed()
        },
      })
      this.decoder.configure({ codec, optimizeForLatency: true })
    }
    if (this.decoder.decodeQueueSize > 2) {
      this.needsKey = true
      return
    }
    if (this.needsKey && !key) return
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: number(data.timestamp, sample.at * 1000),
          data: sample.bytes,
        }),
      )
      this.needsKey = false
    } catch {
      this.needsKey = true
      this.failed()
    }
  }
  dropped() {
    this.needsKey = true
  }
  close() {
    this.closed = true
    if (this.decoder?.state !== 'closed') this.decoder?.close()
    this.decoder = undefined
  }
}
