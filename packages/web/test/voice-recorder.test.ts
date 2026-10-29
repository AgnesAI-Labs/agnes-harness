/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserMedia } from '../src/voice/recorder.js'

class FakeRecorder extends EventTarget {
  static last: FakeRecorder | undefined
  state: 'inactive' | 'recording' = 'inactive'
  readonly mimeType = 'audio/webm'
  constructor() {
    super()
    FakeRecorder.last = this
  }
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    // The spec makes stop() on an inactive recorder do nothing: no second stop event.
    if (this.state !== 'inactive') this.finish()
  }
  /** What the browser does on stop, and on its own when the track ends (a headset unplugged). */
  finish(): void {
    this.state = 'inactive'
    const data = Object.assign(new Event('dataavailable'), { data: new Blob(['webm-bytes']) })
    this.dispatchEvent(data)
    this.dispatchEvent(new Event('stop'))
  }
}

class FakeContext {
  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  async decodeAudioData() {
    return { numberOfChannels: 1, sampleRate: 48_000, getChannelData: () => new Float32Array(480) }
  }
  async close() {}
}

const track = { stop: vi.fn() }
beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeContext)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  })
  track.stop.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

/** Resolves with the recording, or with 'hung' if it does not arrive in time. */
const settle = <T>(promise: Promise<T>): Promise<T | 'hung'> =>
  Promise.race([promise, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 200))])

describe('browserMedia', () => {
  it('decodes the recording on stop and releases the microphone', async () => {
    const input = await browserMedia().open()
    const heard = await settle(input.stop())
    expect(heard).toMatchObject({ sampleRate: 48_000 })
    expect(track.stop).toHaveBeenCalled()
  })

  it('still returns the recording when the recorder already stopped on its own', async () => {
    const input = await browserMedia().open()
    FakeRecorder.last?.finish()
    const heard = await settle(input.stop())
    expect(heard).toMatchObject({ sampleRate: 48_000 })
    expect(track.stop).toHaveBeenCalled()
  })
})
