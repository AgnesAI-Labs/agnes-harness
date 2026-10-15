// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const scenes = vi.hoisted(() => ({ dispose: vi.fn(), render: vi.fn() }))
vi.mock('../src/scene.js', () => ({
  MarsScene: class {
    ready = Promise.resolve()
    dispose = scenes.dispose
    render = scenes.render
  },
}))

import { MarsCameras } from '../src/cameras.js'
import { MarsSimulation } from '../src/simulation.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('encodes on demand at declared 20 Hz, separates stills/video, requests keys and closes every frame/encoder', async () => {
  vi.useFakeTimers()
  let encoded = 0,
    closed = 0,
    framesClosed = 0
  const configs: VideoEncoderConfig[] = [],
    keys: boolean[] = []
  class Encoder {
    state = 'configured'
    encodeQueueSize = 0
    static async isConfigSupported() {
      return { supported: true }
    }
    constructor(private readonly init: VideoEncoderInit) {}
    configure(c: VideoEncoderConfig) {
      configs.push(c)
    }
    encode(_f: unknown, options: VideoEncoderEncodeOptions) {
      encoded++
      keys.push(options.keyFrame === true)
      this.init.output(
        {
          byteLength: 1,
          type: options.keyFrame ? 'key' : 'delta',
          timestamp: encoded * 50_000,
          copyTo: (b: Uint8Array) => b.set([1]),
        } as unknown as EncodedVideoChunk,
        {},
      )
    }
    close() {
      closed++
      this.state = 'closed'
    }
  }
  vi.stubGlobal('VideoEncoder', Encoder)
  vi.stubGlobal(
    'VideoFrame',
    class {
      close() {
        framesClosed++
      }
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((fn) =>
    fn(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
  )
  const sim = new MarsSimulation(true),
    camera = new MarsCameras(sim, document),
    sources: string[] = []
  sim.device('cam-base').onObservation = (o) => {
    sources.push(o.source)
    return true
  }
  await camera.capture(0)
  expect(encoded).toBe(0)
  expect(sources).toContain('view')
  await sim.device('cam-base').configure({ view_video: { on: true, hz: 20 } })
  for (let i = 1; i <= 20; i++) {
    await vi.advanceTimersByTimeAsync(50)
    await camera.capture(i * 50)
  }
  await expect(
    sim
      .device('rover-01')
      .configure({ front_video: { on: true, hz: 20 }, hazcam_video: { on: true, hz: 20 } }),
  ).rejects.toThrow('video-camera-budget')
  expect(configs[0]?.framerate).toBe(20)
  expect(encoded).toBe(20)
  expect(sources.filter((s) => s === 'view_video')).toHaveLength(20)
  expect(keys[0]).toBe(true)
  expect(framesClosed).toBe(20)
  await sim.device('cam-base').onKeyframe?.('view_video')
  await vi.advanceTimersByTimeAsync(50)
  await camera.capture(1050)
  expect(keys.at(-1)).toBe(true)
  await sim.device('cam-base').configure({ view_video: { on: false } })
  expect(closed).toBe(1)
  await camera.capture(1100)
  expect(encoded).toBe(21)
  camera.dispose()
  camera.dispose()
  expect(scenes.dispose).toHaveBeenCalled()
  expect(sim.device('cam-base').onConfigure).toBeUndefined()
  await sim.stop()
})
it('reports unavailable WebCodecs and still releases the detached renderer', async () => {
  vi.stubGlobal('VideoEncoder', undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((fn) =>
    fn(new Blob([new Uint8Array([1])], { type: 'image/png' })),
  )
  const sim = new MarsSimulation(true),
    camera = new MarsCameras(sim, document)
  await sim.device('cam-base').configure({ view_video: { on: true, hz: 20 } })
  await camera.capture(0)
  expect(camera.error).toContain('unavailable')
  camera.dispose()
  await sim.stop()
})
