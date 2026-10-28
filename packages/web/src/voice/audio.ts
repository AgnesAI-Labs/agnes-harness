import { VOICE_SEGMENT_MAX_SECONDS } from '@agnes/protocol'

/** The rate the daemon accepts: 16 kHz mono 16-bit PCM. */
const TARGET_RATE = 16_000
const WAV_HEADER_BYTES = 44
const BASE64_BLOCK = 0x8000
const LEVEL_STEPS = [0.01, 0.03, 0.06, 0.12] as const

const at = (samples: Float32Array, index: number): number => samples[index] ?? 0

/** Averages the channels, then resamples by averaging the source samples under each output sample. */
export function downmixResample(
  channels: readonly Float32Array[],
  rate: number,
  target: 16000 = TARGET_RATE,
): Float32Array {
  const length = channels.length === 0 ? 0 : Math.min(...channels.map((channel) => channel.length))
  const mono = new Float32Array(length)
  for (const channel of channels)
    for (let i = 0; i < length; i++) mono[i] = at(mono, i) + at(channel, i) / channels.length
  if (rate === target || length === 0) return mono
  const step = rate / target
  const out = new Float32Array(Math.floor(length / step))
  if (step < 1) {
    for (let i = 0; i < out.length; i++) {
      const position = i * step
      const from = Math.floor(position)
      const next = Math.min(from + 1, length - 1)
      out[i] = at(mono, from) + (at(mono, next) - at(mono, from)) * (position - from)
    }
    return out
  }
  for (let i = 0; i < out.length; i++) {
    const start = i * step
    const end = Math.min(start + step, length)
    let sum = 0
    for (let j = Math.floor(start); j < end; j++)
      sum += at(mono, j) * (Math.min(j + 1, end) - Math.max(j, start))
    out[i] = sum / (end - start)
  }
  return out
}

/** Canonical 44-byte header plus little-endian 16-bit mono PCM: the only layout the host accepts. */
export function encodeWav16(samples: Float32Array, rate: 16000): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, at(samples, i)))
    view.setInt16(
      WAV_HEADER_BYTES + i * 2,
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      true,
    )
  }
  return bytes
}

/** Cuts at the quietest 100 ms frame between `minS` and `maxS`; every chunk but the last is >= `minS`. */
export function chunkPlan(
  samples: Float32Array,
  rate: number,
  o: { minS?: number; maxS?: number; frameS?: number } = {},
): Array<[number, number]> {
  const min = Math.round((o.minS ?? 15) * rate)
  const max = Math.round((o.maxS ?? VOICE_SEGMENT_MAX_SECONDS) * rate)
  const frame = Math.max(1, Math.round((o.frameS ?? 0.1) * rate))
  const out: Array<[number, number]> = []
  let start = 0
  while (samples.length - start > max) {
    let best = start + max
    let bestRms = Number.POSITIVE_INFINITY
    for (let f = start + min; f + frame <= start + max; f += frame) {
      const rms = rmsOf(samples, f, f + frame)
      if (rms < bestRms) {
        bestRms = rms
        best = f + Math.floor(frame / 2)
      }
    }
    out.push([start, best])
    start = best
  }
  out.push([start, samples.length])
  return out
}

/** Joins chunk transcripts: a space only between two Latin letters or digits. */
export function joinTranscripts(parts: readonly string[]): string {
  let text = ''
  for (const part of parts) {
    const next = part.trim()
    if (!next) continue
    text += /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(next) ? ` ${next}` : next
  }
  return text
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_BLOCK))
  }
  return btoa(binary)
}

export function rmsOf(samples: Float32Array, from = 0, to = samples.length): number {
  const start = Math.max(0, from)
  const end = Math.min(samples.length, to)
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i++) sum += at(samples, i) ** 2
  return Math.sqrt(sum / (end - start))
}

export function levelOf(rms: number): 0 | 1 | 2 | 3 | 4 {
  let level = 0
  for (const step of LEVEL_STEPS) if (rms >= step) level++
  return level as 0 | 1 | 2 | 3 | 4
}
