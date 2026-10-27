import { createHash, randomUUID } from 'node:crypto'
import {
  OPENAI_AUDIO_WIRE_API,
  openAiAudioUnits,
  wavHeader,
} from '@agnes/host-infrastructure/configuration-payload-only'
import {
  type AiErrorCode,
  type ConfigAccount,
  type JsonValue,
  type RequestBody,
  rpcError,
  VOICE_AUDIO_MAX_BASE64,
  VOICE_CALL_TIMEOUT_MS,
  VOICE_SEGMENT_MAX_SECONDS,
  VOICE_SEGMENT_SLACK_SECONDS,
  VOICE_SPEAK_MAX_CHARS,
  VOICE_SPEECH_MAX_BASE64,
  VOICE_TRANSCRIPT_MAX_CHARS,
  type VoiceSettings,
  type VoiceStatusResult,
} from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import { abortable, accountedSideCall, type SideCallRun } from './session-side-call.js'

export type VoiceFailure = 'unavailable' | 'too-large' | 'invalid-audio' | 'budget' | 'timeout' | 'provider'
export type VoiceFailureDetail = Readonly<{
  providerCode?: AiErrorCode
  retryable?: boolean
  retryAfterMs?: number
}>

/** A voice call was refused or failed; `code` says why without provider bodies, addresses or keys. */
export class VoiceError extends Error {
  constructor(
    readonly code: VoiceFailure,
    message: string,
    readonly detail: VoiceFailureDetail = {},
  ) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** The wire error for a failed voice call, wherever the session runs; any other error is returned as is. */
export function voiceRpcError(error: unknown): unknown {
  if (!(error instanceof VoiceError)) return error
  switch (error.code) {
    case 'unavailable':
      return rpcError('SEMANTIC_REJECTED', { reason: 'VOICE_UNAVAILABLE' })
    case 'too-large':
      return rpcError('INVALID_PARAMS', { reason: 'VOICE_TOO_LARGE' })
    case 'invalid-audio':
      return rpcError('INVALID_PARAMS', { reason: 'VOICE_AUDIO_FORMAT' })
    case 'budget':
      return rpcError('SEMANTIC_REJECTED', { reason: 'BUDGET' })
    case 'timeout':
      return rpcError('REQUEST_TIMEOUT', { reason: 'voice' })
    case 'provider': {
      const { providerCode, retryable, retryAfterMs } = error.detail
      return rpcError('SEMANTIC_REJECTED', {
        reason: 'VOICE_PROVIDER',
        code: providerCode ?? 'TRANSPORT',
        retryable: retryable ?? false,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    }
  }
}

export type VoiceAccount = Readonly<{ route: string; label: string; transcribe?: string; speech?: string }>
export type VoiceAccountChoice =
  | Readonly<{ state: 'available' | 'credential-missing'; account: VoiceAccount }>
  | Readonly<{ state: 'unconfigured' | 'ambiguous' }>

/**
 * The voice account: the selected route, or with none selected the only enabled voice account.
 * Its transcribe and speech models are the first model of the account with that role.
 */
export function chooseVoiceAccount(accounts: readonly ConfigAccount[], selected: string): VoiceAccountChoice {
  // The voice provider entry is named after its wire api.
  const candidates = accounts.filter((a) => a.providerId === OPENAI_AUDIO_WIRE_API && a.enabled)
  const chosen = selected === '' ? candidates : candidates.filter((a) => a.route === selected)
  if (chosen.length > 1 && selected === '') return { state: 'ambiguous' }
  const [found] = chosen
  if (!found) return { state: 'unconfigured' }
  const role = (audioRole: 'transcribe' | 'speech') => found.models.find((m) => m.audioRole === audioRole)?.id
  const transcribe = role('transcribe')
  const speech = role('speech')
  const account: VoiceAccount = {
    route: found.route,
    label: found.label,
    ...(transcribe === undefined ? {} : { transcribe }),
    ...(speech === undefined ? {} : { speech }),
  }
  return { state: found.credentialConfigured ? 'available' : 'credential-missing', account }
}

/** What the voice buttons can do now. A usable account without a model for a role gives `no-model`. */
export function voiceStatus(input: {
  accounts: readonly ConfigAccount[]
  settings: VoiceSettings
}): VoiceStatusResult {
  const choice = chooseVoiceAccount(input.accounts, input.settings.account)
  const { settings } = input
  if (choice.state === 'available') {
    const { route, label, transcribe, speech } = choice.account
    return {
      transcribe: transcribe === undefined ? 'no-model' : 'available',
      speech: speech === undefined ? 'no-model' : 'available',
      account: { route, label },
      settings,
    }
  }
  if (choice.state === 'credential-missing') {
    const { route, label } = choice.account
    const state = 'credential-missing'
    return { transcribe: state, speech: state, account: { route, label }, reason: state, settings }
  }
  const reason = choice.state === 'ambiguous' ? 'ambiguous' : 'no-account'
  return { transcribe: choice.state, speech: choice.state, reason, settings }
}

/** The format and length of a base64 PCM WAV, or undefined when it is not one. */
export function wavInfo(
  base64: string,
): { sampleRate: number; channels: number; bitsPerSample: number; seconds: number } | undefined {
  const header = wavHeader(base64)
  if (!header) return undefined
  const { sampleRate, channels, bits, byteRate, dataBytes } = header
  return { sampleRate, channels, bitsPerSample: bits, seconds: dataBytes / byteRate }
}

export type VoiceCallOptions = { route: string; signal?: AbortSignal; timeoutMs?: number }

/**
 * Speech to text for one recording: 16 kHz mono 16-bit WAV of at most the segment length. Every
 * refusal happens before the provider is called and writes nothing; once it was called, one
 * `voice.transcribe` side-call cost row is written in audio seconds, whatever the outcome.
 */
export async function voiceTranscribe(
  s: HostSession,
  input: { audio: string; language?: string },
  options: VoiceCallOptions,
): Promise<{ text: string }> {
  if (s.closingOrClosed) throw unavailable()
  const { audio, language } = input
  if (audio.length > VOICE_AUDIO_MAX_BASE64) throw new VoiceError('too-large', 'the recording is too large')
  const info = wavInfo(audio)
  if (info?.sampleRate !== 16_000 || info.channels !== 1 || info.bitsPerSample !== 16)
    throw new VoiceError('invalid-audio', 'the recording is not 16 kHz mono 16-bit WAV')
  if (info.seconds > VOICE_SEGMENT_MAX_SECONDS + VOICE_SEGMENT_SLACK_SECONDS)
    throw new VoiceError('too-large', 'the recording is too long')
  const payload: VoicePayload = {
    op: 'transcribe',
    audio: { type: 'audio', data: audio, mimeType: 'audio/wav' },
    ...(language ? { language } : {}),
  }
  const text = await voiceCall(s, 'transcribe', payload, VOICE_TRANSCRIPT_MAX_CHARS, options)
  return { text }
}

/**
 * Text to speech for one segment of 1 to 120 UTF-16 units, as base64 mp3. Accounted like
 * `voiceTranscribe`, in UTF-8 bytes of the text, under the label `voice.speak`.
 */
export async function voiceSpeak(
  s: HostSession,
  input: { text: string; voice?: string; speed?: number },
  options: VoiceCallOptions,
): Promise<{ audio: string; mimeType: 'audio/mpeg' }> {
  if (s.closingOrClosed) throw unavailable()
  const { text, voice, speed } = input
  if (text.length < 1 || text.length > VOICE_SPEAK_MAX_CHARS)
    throw new VoiceError('too-large', 'the speech text is empty or too long')
  const payload: VoicePayload = {
    op: 'speech',
    text,
    ...(voice ? { voice } : {}),
    ...(speed === undefined ? {} : { speed }),
  }
  const audio = await voiceCall(s, 'speech', payload, VOICE_SPEECH_MAX_BASE64, options)
  if (audio === '') throw providerFormat()
  return { audio, mimeType: 'audio/mpeg' }
}

type VoicePayload = { [key: string]: JsonValue }

const unavailable = () => new VoiceError('unavailable', 'voice is unavailable on this route')
const providerFormat = () =>
  new VoiceError('provider', 'the voice provider gave no usable answer', {
    providerCode: 'FORMAT',
    retryable: false,
  })

/** One accounted payload call on the voice route's model with the role; returns the joined text. */
function voiceCall(
  s: HostSession,
  role: 'transcribe' | 'speech',
  payload: VoicePayload,
  maxText: number,
  options: VoiceCallOptions,
): Promise<string> {
  const work = async () => {
    const { route } = options
    const record = s.d.provider
      .models()
      .find((m) => m.route === route && m.api === OPENAI_AUDIO_WIRE_API && m.audioRole === role)
    if (!record) throw unavailable()
    const units = openAiAudioUnits(payload)
    if (units === undefined) throw new VoiceError('invalid-audio', 'the voice payload has no size')
    const label = role === 'speech' ? 'voice.speak' : 'voice.transcribe'
    const t = options.timeoutMs ?? VOICE_CALL_TIMEOUT_MS
    const wire: RequestBody = {
      kind: 'inference',
      sessionKey: `${label}:${randomUUID()}`,
      slot: 'primary',
      route,
      model: record.id,
      contractId: record.contract_id,
      derivedHash: createHash('sha256')
        .update(JSON.stringify({ label, route, model: record.id, payload }))
        .digest('hex'),
      system: '',
      messages: [],
      tools: [],
      payload,
      timeoutMs: { firstToken: t, total: t },
    }
    const abort = new AbortController()
    const cancel = () => abort.abort()
    options.signal?.addEventListener('abort', cancel, { once: true })
    // A plain timer, so the deadline follows the clock tests and callers control.
    const timer = setTimeout(cancel, t)
    const refuse = (code: 'budget' | 'timeout', message: string) => new VoiceError(code, message)
    try {
      if (options.signal?.aborted) abort.abort()
      const [start] = await s.scan({ type: 'turn/start', lane: s.lane, order: 'desc', limit: 1 })
      const result = await accountedSideCall(
        s,
        {
          label,
          route,
          modelId: record.id,
          model: record,
          tokensEstimate: units,
          outputEstimate: 0,
          cap: s.preset.budget.perRequestCap,
          requestHash: wire.derivedHash,
          start,
          withoutTurn: 'unbudgeted',
          estimatedTokens: () => ({ input: units, output: 0, cacheRead: 0, cacheWrite: 0 }),
          run: (signal) =>
            collect(s, wire, maxText, signal, () =>
              refuse('timeout', 'the voice call was cancelled or timed out'),
            ),
        },
        abort.signal,
        refuse,
      )
      return result.text
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      abort.abort()
    }
  }
  return s.d.withModelSnapshot ? s.d.withModelSnapshot(work) : work()
}

/** The provider's text, never cut: over `maxText` it is a FORMAT failure. */
async function collect(
  s: HostSession,
  wire: RequestBody,
  maxText: number,
  signal: AbortSignal,
  stopped: () => Error,
): Promise<SideCallRun> {
  let usage: SideCallRun['usage']
  let text = ''
  let completed = false
  let failure: unknown
  try {
    const iterator = s.d.provider.infer(wire, { signal, toolNames: [], retry: false })[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await abortable(iterator.next(), signal, stopped)
        if (next.done) break
        const event = next.value
        if (event.type === 'usage') usage = event
        else if (event.type === 'text_delta') {
          text += event.delta
          if (text.length > maxText) {
            failure = providerFormat()
            break
          }
        } else if (event.type === 'done') {
          completed = event.reason === 'stop' || event.reason === 'length'
          break
        } else if (event.type === 'error') {
          // The adapter's own deadline races ours; either way the caller sees a timeout.
          const timedOut = event.code === 'TIMEOUT' || event.code === 'ABORTED'
          failure = new VoiceError(
            timedOut ? 'timeout' : 'provider',
            timedOut ? 'the voice call timed out' : 'the voice provider failed',
            {
              providerCode: event.code,
              retryable: event.retryable,
              ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
            },
          )
          break
        } else if (event.type === 'toolcall_end' || event.type === 'deviation') {
          failure = providerFormat()
          break
        }
      }
    } finally {
      // Early stream cancellation can reject return(); settlement remains owned by this request.
      void iterator.return?.().catch(() => undefined)
    }
  } catch (error) {
    failure = error instanceof VoiceError ? error : signal.aborted ? stopped() : providerFailure()
  }
  if (!failure && !completed && !signal.aborted) failure = providerFormat()
  return { text, ...(usage ? { usage } : {}), completed, ...(failure ? { failure } : {}) }
}

const providerFailure = () =>
  new VoiceError('provider', 'the voice provider failed', { providerCode: 'TRANSPORT', retryable: false })
