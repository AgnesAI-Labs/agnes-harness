import { VOICE_SEGMENT_MAX_SECONDS } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  chunkPlan,
  downmixResample,
  encodeWav16,
  joinTranscripts,
  levelOf,
  rmsOf,
  toBase64,
} from '../src/voice/audio.js'

const RATE = 16_000

function noise(length: number): Float32Array {
  const out = new Float32Array(length)
  let seed = 12345
  for (let i = 0; i < length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
    out[i] = (seed / 0x7fffffff - 0.5) * 0.6
  }
  return out
}

function silence(samples: Float32Array, from: number, to: number): void {
  samples.fill(0, Math.round(from), Math.round(to))
}

describe('encodeWav16', () => {
  it('encodes 16 kHz mono 16-bit PCM WAV with a valid header', () => {
    const wav = encodeWav16(new Float32Array(RATE).fill(0.5), RATE)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4))
    expect(tag(0)).toBe('RIFF')
    expect(tag(8)).toBe('WAVE')
    expect(tag(12)).toBe('fmt ')
    expect(tag(36)).toBe('data')
    expect(wav.length).toBe(44 + 32_000)
    expect(view.getUint32(4, true)).toBe(36 + 32_000)
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(32_000)
    expect(wav.length - 44).toBe(2 * RATE)
    expect(view.getInt16(44, true)).toBe(16_384)
  })

  it('clamps out-of-range samples and keeps the sign', () => {
    const wav = encodeWav16(Float32Array.of(2, -2, 0, -0.5), RATE)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + 2 * i, true))).toEqual([32_767, -32_768, 0, -16_384])
  })

  it('owns its buffer so a DataView over the whole buffer sees the header', () => {
    const wav = encodeWav16(new Float32Array(10), RATE)
    expect(wav.byteOffset).toBe(0)
    expect(wav.buffer.byteLength).toBe(wav.length)
  })
})

describe('downmixResample', () => {
  it('downmixes stereo and resamples 48 kHz to 16 kHz', () => {
    const left = new Float32Array(48_000).fill(1)
    const right = new Float32Array(48_000).fill(0)
    const out = downmixResample([left, right], 48_000)
    expect(out.length).toBe(16_000)
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[8_000]).toBeCloseTo(0.5, 5)
    expect(out[15_999]).toBeCloseTo(0.5, 5)
  })

  it('averages the source samples that fall into each output sample', () => {
    const ramp = Float32Array.from({ length: 48 }, (_, i) => i)
    const out = downmixResample([ramp], 48_000)
    expect(Array.from(out.slice(0, 3))).toEqual([1, 4, 7])
  })

  it('handles non-integer ratios and upsampling', () => {
    expect(downmixResample([new Float32Array(44_100).fill(0.25)], 44_100).length).toBe(16_000)
    const up = downmixResample([Float32Array.of(0, 1, 0, 1)], 8_000)
    expect(up.length).toBe(8)
    expect(Math.max(...up)).toBeLessThanOrEqual(1)
    expect(Math.min(...up)).toBeGreaterThanOrEqual(0)
  })

  it('returns a copy at the target rate and an empty array for no input', () => {
    const input = Float32Array.of(0.1, 0.2)
    const out = downmixResample([input], RATE)
    expect(Array.from(out)).toEqual(Array.from(input))
    expect(out).not.toBe(input)
    expect(downmixResample([], 48_000).length).toBe(0)
  })
})

describe('chunkPlan', () => {
  it('keeps <= 20 s audio in one chunk', () => {
    const one = new Float32Array(VOICE_SEGMENT_MAX_SECONDS * RATE)
    expect(chunkPlan(one, RATE)).toEqual([[0, one.length]])
    expect(chunkPlan(new Float32Array(100), RATE)).toEqual([[0, 100]])
  })

  it('cuts longer audio at the quietest point between 15 and 20 s', () => {
    const s = noise(45 * RATE)
    silence(s, 17.3 * RATE, 17.5 * RATE)
    const plan = chunkPlan(s, RATE)
    expect((plan[0]?.[1] ?? 0) / RATE).toBeCloseTo(17.35, 2)
    expect(plan.every(([a, b]) => b - a <= VOICE_SEGMENT_MAX_SECONDS * RATE)).toBe(true)
    expect(plan[0]?.[0]).toBe(0)
    expect(plan.at(-1)?.[1]).toBe(s.length)
    for (let i = 1; i < plan.length; i++) expect(plan[i]?.[0]).toBe(plan[i - 1]?.[1])
    for (const [a, b] of plan.slice(0, -1)) expect(b - a).toBeGreaterThanOrEqual(15 * RATE)
  })

  it('takes the first of several equally quiet frames', () => {
    const s = noise(30 * RATE)
    silence(s, 16 * RATE, 19 * RATE)
    expect((chunkPlan(s, RATE)[0]?.[1] ?? 0) / RATE).toBeCloseTo(16.05, 2)
  })

  it('honours custom bounds', () => {
    const s = noise(10 * RATE)
    const plan = chunkPlan(s, RATE, { minS: 3, maxS: 4 })
    expect(plan.length).toBeGreaterThan(2)
    expect(plan.every(([a, b]) => b - a <= 4 * RATE)).toBe(true)
  })
})

describe('joinTranscripts', () => {
  it('joins Chinese without spaces and Latin words with one', () => {
    expect(joinTranscripts(['你好', '世界', 'hello', 'world'])).toBe('你好世界hello world')
  })

  it('trims parts, drops empty ones and spaces only between letters or digits', () => {
    expect(joinTranscripts(['  ', ' one ', '', 'two', '2', '你'])).toBe('one two 2你')
    expect(joinTranscripts([])).toBe('')
  })
})

describe('toBase64', () => {
  it('encodes bytes', () => {
    expect(toBase64(Uint8Array.of(97, 98, 99))).toBe('YWJj')
    expect(toBase64(new Uint8Array(0))).toBe('')
  })

  it('encodes a 640 KB recording without overflowing the stack', () => {
    const bytes = Uint8Array.from({ length: 640_044 }, (_, i) => i % 251)
    const text = toBase64(bytes)
    expect(text.length).toBe(Math.ceil(640_044 / 3) * 4)
    const back = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
    expect(back.length).toBe(bytes.length)
    expect(back[640_043]).toBe(bytes[640_043])
  })
})

describe('rmsOf / levelOf', () => {
  it('computes the RMS of a range', () => {
    const s = Float32Array.of(0.5, -0.5, 0, 0)
    expect(rmsOf(s)).toBeCloseTo(Math.sqrt(0.125), 6)
    expect(rmsOf(s, 0, 2)).toBeCloseTo(0.5, 6)
    expect(rmsOf(s, 2, 4)).toBe(0)
    expect(rmsOf(new Float32Array(0))).toBe(0)
    expect(rmsOf(s, 3, 3)).toBe(0)
  })

  it('maps RMS to five level steps', () => {
    expect([0.005, 0.02, 0.05, 0.1, 0.2].map(levelOf)).toEqual([0, 1, 2, 3, 4])
    expect([0.01, 0.03, 0.06, 0.12].map(levelOf)).toEqual([1, 2, 3, 4])
    expect(levelOf(0)).toBe(0)
  })
})
