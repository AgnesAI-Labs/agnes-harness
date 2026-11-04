/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
import { BrowserAudio } from '../../package-manager/bundled-plugins/browser/src/browser-audio.js'

it('plays PCM only after a user gesture and bounds queued sound across navigation/disconnect', () => {
  const scheduled: { at: number; stopped: boolean; samples: Float32Array[] }[] = []
  let closed = false
  let opened = false
  class Context {
    constructor() {
      opened = true
    }
    state = 'running'
    currentTime = 0
    destination = {}
    resume = async () => {}
    close = async () => {
      closed = true
    }
    createBuffer(channels: number, count: number, rate: number) {
      const samples = Array.from({ length: channels }, () => new Float32Array(count))
      return { duration: count / rate, samples, getChannelData: (channel: number) => samples[channel] }
    }
    createBufferSource() {
      const entry = { at: 0, stopped: false, samples: [] as Float32Array[] }
      const source = {
        buffer: undefined as ReturnType<Context['createBuffer']> | undefined,
        connect() {},
        disconnect() {},
        onended() {},
        start(at: number) {
          entry.at = at
          entry.samples = source.buffer!.samples
          scheduled.push(entry)
        },
        stop() {
          entry.stopped = true
        },
      }
      return source
    }
  }
  vi.stubGlobal('AudioContext', Context)
  const audio = new BrowserAudio()
  const pcm = new Uint8Array(2048 * 4)
  const bytes = new DataView(pcm.buffer)
  bytes.setInt16(0, 16384, true)
  bytes.setInt16(2, -16384, true)
  try {
    audio.push(pcm, 48000)
    expect(scheduled).toEqual([])
    audio.resume()
    // Text-only pages must never acquire an output device on ordinary input.
    expect(opened).toBe(false)
    audio.push(pcm, 0)
    audio.push(new Uint8Array(3), 48000)
    audio.push(new Uint8Array(16388), 48000)
    audio.push(pcm, 8000)
    expect(opened).toBe(false)
    audio.push(pcm, 48000)
    expect(scheduled[0]!.samples[0]![0]).toBe(0.5)
    expect(scheduled[0]!.samples[1]![0]).toBe(-0.5)
    for (let count = 0; count < 8; count++) audio.push(pcm, 48000)
    expect(scheduled.some((source) => source.stopped)).toBe(true)
    expect(scheduled.at(-1)!.at).toBeLessThan(0.2)
    const count = scheduled.length
    audio.push(pcm, 0)
    audio.push(new Uint8Array(3), 48000)
    expect(scheduled).toHaveLength(count)
    audio.reset()
    expect(scheduled.every((source) => source.stopped)).toBe(true)
    audio.close()
    expect(closed).toBe(true)
    audio.push(pcm, 48000)
    expect(scheduled).toHaveLength(count)
    opened = false
    audio.resume()
    expect(opened).toBe(false)
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('Output device unavailable')
        }
      },
    )
    expect(() => audio.push(pcm, 48000)).not.toThrow()
    vi.stubGlobal('AudioContext', Context)
    audio.push(pcm, 48000)
    expect(opened).toBe(false)
    audio.resume()
    audio.push(pcm, 48000)
    expect(opened).toBe(true)
  } finally {
    audio.close()
    vi.unstubAllGlobals()
  }
})
