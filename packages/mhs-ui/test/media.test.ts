import { afterEach, expect, it, vi } from 'vitest'
import { VideoView } from '../src/media.js'

afterEach(() => vi.unstubAllGlobals())
it('waits for a keyframe after start/drop/overflow, closes output frames and owns decoder cleanup', () => {
  const decoded: { type: string }[] = [],
    frames: { close(): void }[] = []
  let callbacks: VideoDecoderInit,
    closed = 0,
    queue = 0
  class Decoder {
    state = 'configured'
    get decodeQueueSize() {
      return queue
    }
    constructor(init: VideoDecoderInit) {
      callbacks = init
    }
    configure() {}
    decode(chunk: { type: string }) {
      decoded.push(chunk)
    }
    close() {
      closed++
      this.state = 'closed'
    }
  }
  vi.stubGlobal('VideoDecoder', Decoder)
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      type: string
      constructor(init: { type: string }) {
        this.type = init.type
      }
    },
  )
  const drawImage = vi.fn(),
    failed = vi.fn(),
    canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement
  const view = new VideoView(canvas, failed),
    sample = {
      device: 'd',
      source: 'v',
      at: 1,
      mime: '',
      rawData: {},
      bytes: new Uint8Array([1]),
      data: { codec: 'avc1.42E01E', key: false },
    }
  view.push(sample)
  expect(decoded).toHaveLength(0)
  view.push({ ...sample, data: { ...sample.data, key: true } })
  view.push(sample)
  expect(decoded.map((c) => c.type)).toEqual(['key', 'delta'])
  view.dropped()
  view.push(sample)
  expect(decoded).toHaveLength(2)
  queue = 3
  view.push({ ...sample, data: { ...sample.data, key: true } })
  expect(decoded).toHaveLength(2)
  queue = 0
  view.push({ ...sample, data: { ...sample.data, key: true } })
  expect(decoded).toHaveLength(3)
  const frame = { displayWidth: 640, displayHeight: 360, close: vi.fn() }
  frames.push(frame)
  callbacks!.output(frame as unknown as VideoFrame)
  expect(canvas.width).toBe(640)
  expect(drawImage).toHaveBeenCalled()
  expect(frame.close).toHaveBeenCalled()
  view.close()
  view.close()
  view.push(sample)
  expect(closed).toBe(1)
  expect(failed).not.toHaveBeenCalled()
})
it('reports unsupported codecs without fabricating a frame', () => {
  vi.stubGlobal('VideoDecoder', undefined)
  const failed = vi.fn(),
    view = new VideoView({} as HTMLCanvasElement, failed)
  view.push({
    device: 'd',
    source: 'v',
    at: 1,
    mime: '',
    data: { key: true },
    rawData: {},
    bytes: new Uint8Array([1]),
  })
  expect(failed).toHaveBeenCalled()
  view.close()
})
