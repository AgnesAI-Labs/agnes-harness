// The openai-audio wire format as pure functions: the payload a request carries, the request bodies,
// the WAV header reader that sizes a recording and the status classification. Nothing here opens a
// connection; index.ts does.
import type { RequestBody } from '@agnes/protocol'
import { type Classified, plain } from '../payload-wire.js'
import { isStepfunModel, STEPFUN_DEFAULT_VOICE } from './stepfun.js'

export const OPENAI_AUDIO_WIRE_API = 'openai-audio'
/** The longest speech accepted: 768,000 bytes are 1,024,000 base64 characters (Task 3's schema cap). */
export const MAX_SPEECH_BYTES = 768_000
/** The most a transcription reply may carry, as JSON or as an event stream. */
export const MAX_TRANSCRIPT_BYTES = 256 * 1024

export type OpenAiAudioPayload =
  | { op: 'transcribe'; audio: { type: 'audio'; data: string; mimeType: 'audio/wav' }; language?: string }
  | { op: 'speech'; text: string; voice?: string; speed?: number }

export type WavHeader = {
  sampleRate: number
  channels: number
  bits: number
  byteRate: number
  /** The sound bytes after the 44-byte header, from the length of the base64 text. */
  dataBytes: number
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const WAV_HEADER_BYTES = 44

/**
 * The format of a base64 PCM WAV, read from its first 44 bytes, or undefined when the text is not
 * base64 or does not start with a RIFF/WAVE/PCM header. The one reader for a recording: the adapter
 * sizes a call from it and the host validates a recording with it.
 */
export function wavHeader(base64: string): WavHeader | undefined {
  if (base64.length < 60 || base64.length % 4 !== 0 || !BASE64.test(base64)) return undefined
  const head = Buffer.from(base64.slice(0, 64), 'base64')
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return undefined
  if (head.readUInt16LE(20) !== 1) return undefined
  const byteRate = head.readUInt32LE(28)
  if (byteRate === 0) return undefined
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return {
    sampleRate: head.readUInt32LE(24),
    channels: head.readUInt16LE(22),
    bits: head.readUInt16LE(34),
    byteRate,
    dataBytes: Math.max(0, (base64.length * 3) / 4 - padding - WAV_HEADER_BYTES),
  }
}

/**
 * What a payload costs, in the units a call is accounted in: a recording is its seconds rounded up
 * and a speech is the UTF-8 bytes of its text. The request's byte size is never the measure.
 */
export function openAiAudioUnits(payload: unknown): number | undefined {
  if (!plain(payload)) return undefined
  if (payload.op === 'speech')
    return typeof payload.text === 'string' ? new TextEncoder().encode(payload.text).length : undefined
  if (payload.op !== 'transcribe' || !plain(payload.audio) || typeof payload.audio.data !== 'string')
    return undefined
  const header = wavHeader(payload.audio.data)
  return header && Math.ceil(header.dataBytes / header.byteRate)
}

const LANGUAGE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/
const TRANSCRIBE_KEYS = ['op', 'audio', 'language']
const SPEECH_KEYS = ['op', 'text', 'voice', 'speed']

/**
 * The payload a request carries, or why this is not a request the vendor can answer. A recording
 * that does not start as a WAV is refused here, before anything is sent.
 */
export function readAudioPayload(req: RequestBody): OpenAiAudioPayload | string {
  if (req.tools.length > 0) return 'tools are not supported'
  if (req.messages.length > 0) return 'messages are not supported'
  if (req.system !== '') return 'a system prompt is not supported'
  const p = req.payload
  if (p === undefined) return 'answers payload requests only'
  if (!plain(p) || (p.op !== 'transcribe' && p.op !== 'speech'))
    return 'payload.op must be transcribe or speech'
  const allowed = p.op === 'transcribe' ? TRANSCRIBE_KEYS : SPEECH_KEYS
  if (Object.keys(p).some((key) => !allowed.includes(key))) return 'payload has an unknown field'
  if (p.op === 'transcribe') {
    const { audio, language } = p
    if (
      !plain(audio) ||
      audio.type !== 'audio' ||
      audio.mimeType !== 'audio/wav' ||
      typeof audio.data !== 'string' ||
      Object.keys(audio).length !== 3
    )
      return 'payload.audio must be a base64 audio/wav'
    if (wavHeader(audio.data) === undefined) return 'payload.audio is not a WAV recording'
    if (language !== undefined && (typeof language !== 'string' || !LANGUAGE.test(language)))
      return 'payload.language is not a language code'
    return {
      op: 'transcribe',
      audio: { type: 'audio', data: audio.data, mimeType: 'audio/wav' },
      ...(language === undefined ? {} : { language }),
    }
  }
  const { text, voice, speed } = p
  if (typeof text !== 'string' || text === '') return 'payload.text must be a non-empty string'
  if (voice !== undefined && (typeof voice !== 'string' || voice.length > 128))
    return 'payload.voice must be a short string'
  if (speed !== undefined && (typeof speed !== 'number' || !(speed >= 0.25 && speed <= 4)))
    return 'payload.speed must be between 0.25 and 4'
  return {
    op: 'speech',
    text,
    ...(voice === undefined ? {} : { voice }),
    ...(speed === undefined ? {} : { speed }),
  }
}

/** A SiliconFlow-style model id carries its vendor, as in `FunAudioLLM/CosyVoice2-0.5B`. */
const namespaced = (model: string): boolean => model.includes('/')

/**
 * The voice a speech call names. Empty means the vendor's default. A namespaced model takes voices
 * as `<model>:<name>`, so a bare name gets the prefix; any other model gets the name as given.
 */
export function speechVoice(model: string, voice: string | undefined): string {
  if (voice === undefined || voice === '') {
    if (isStepfunModel(model)) return STEPFUN_DEFAULT_VOICE
    return namespaced(model) ? `${model}:anna` : 'alloy'
  }
  return namespaced(model) && !voice.includes(':') ? `${model}:${voice}` : voice
}

/**
 * The JSON body of `POST <base>/audio/speech`. The format is always mp3. `speed` is left out when it
 * is 1 so the plain request is safe on every vendor; StepFun accepts 0.5 to 2 and is clamped to it.
 * Only a namespaced model is sent `stream:false` and `sample_rate`.
 */
export function speechBody(model: string, p: Extract<OpenAiAudioPayload, { op: 'speech' }>): string {
  const speed =
    p.speed === undefined || !isStepfunModel(model) ? p.speed : Math.min(2, Math.max(0.5, p.speed))
  return JSON.stringify({
    model,
    input: p.text,
    voice: speechVoice(model, p.voice),
    response_format: 'mp3',
    ...(speed === undefined || speed === 1 ? {} : { speed }),
    ...(namespaced(model) ? { stream: false, sample_rate: 32000 } : {}),
  })
}

/**
 * A `multipart/form-data` body: the text fields, then `file` as `audio.wav`. The boundary is the
 * caller's and must not occur in the data; a random one per call makes that certain.
 */
export function multipartBody(
  fields: Readonly<Record<string, string>>,
  file: Uint8Array,
  boundary: string,
): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder()
  const head = Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('')
  const open = text.encode(
    `${head}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  )
  const close = text.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(open.length + file.length + close.length)
  body.set(open, 0)
  body.set(file, open.length)
  body.set(close, open.length + file.length)
  return body
}

const rejected = (code: Classified['code']): Classified => ({ code, retryable: false, zeroUsage: true })

/**
 * What a non-2xx status means. The body is never consulted: a vendor's error text can quote the
 * request or the key, and the status says enough to act on.
 */
export function classifyAudioStatus(status: number): Classified {
  if (status === 401 || status === 403) return rejected('AUTH')
  if (status === 402) return rejected('QUOTA')
  if (status === 404) return rejected('NO_MODEL')
  if (status === 413) return rejected('OVERFLOW')
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true, zeroUsage: true }
  if (status === 529) return { code: 'RATE_LIMIT', retryable: true, zeroUsage: false }
  if (status >= 400 && status < 500) return rejected('CONTRACT_MISMATCH')
  return { code: 'TRANSPORT', retryable: true, zeroUsage: false }
}
