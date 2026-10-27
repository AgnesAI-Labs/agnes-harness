import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  METHOD_TIERS,
  METHODS,
  VOICE_AUDIO_MAX_BASE64,
  VOICE_CALL_TIMEOUT_MS,
  VOICE_LINK_TIMEOUT_MS,
  VOICE_SEGMENT_MAX_SECONDS,
  VOICE_SEGMENT_SLACK_SECONDS,
  VOICE_SPEAK_MAX_CHARS,
  VOICE_SPEECH_MAX_BASE64,
  VOICE_TRANSCRIPT_MAX_CHARS,
  validateMethod,
} from '../src/index.js'

const ok = (method: Parameters<typeof validateMethod>[0], side: 'params' | 'result', value: unknown) =>
  validateMethod(method, side, value).ok

const WAV_HEADER_BYTES = 44
const WAV_BYTES_PER_SECOND = 16_000 * 2 // 16 kHz mono 16-bit
const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4

describe('voice protocol contract', () => {
  it('accepts a 20 s clip and refuses one character more', () => {
    const t = '_agnes/v1/session.voice.transcribe'
    expect(ok(t, 'params', { sessionId: 's', audio: 'A'.repeat(900_000) })).toBe(true)
    expect(ok(t, 'params', { sessionId: 's', audio: 'A'.repeat(900_001) })).toBe(false)
    expect(ok(t, 'params', { sessionId: 's', audio: `${'A'.repeat(64)}!` })).toBe(false)
    expect(ok(t, 'params', { sessionId: 's', audio: 'A'.repeat(63) })).toBe(false)
  })

  it('accepts at most three language subtags, the most the audio adapter takes', () => {
    const t = '_agnes/v1/session.voice.transcribe'
    const withLanguage = (language: string) => ({ sessionId: 's', audio: 'A'.repeat(64), language })
    for (const language of ['zh', 'zh-CN', 'de-ab-cd-ef'])
      expect(ok(t, 'params', withLanguage(language))).toBe(true)
    for (const language of ['de-ab-cd-ef-gh', 'zh_CN', 'z'])
      expect(ok(t, 'params', withLanguage(language))).toBe(false)
    const settings = (language: string) => ({
      ...DEFAULT_VOICE_SETTINGS,
      input: { ...DEFAULT_VOICE_SETTINGS.input, language },
    })
    const save = (language: string) => ({ settings: settings(language), expectedRevision: '0'.repeat(64) })
    expect(ok('_agnes/v1/voice.settings.save', 'params', save('de-ab-cd-ef'))).toBe(true)
    expect(ok('_agnes/v1/voice.settings.save', 'params', save('de-ab-cd-ef-gh'))).toBe(false)
  })

  it('bounds speech text to 120 UTF-16 units and speed to 0.25-4', () => {
    const s = '_agnes/v1/session.voice.speak'
    expect(ok(s, 'params', { sessionId: 's', text: '字'.repeat(120) })).toBe(true)
    expect(ok(s, 'params', { sessionId: 's', text: '字'.repeat(121) })).toBe(false)
    // The limit is 120 UTF-16 code units (TypeBox), so an emoji counts as two.
    expect(ok(s, 'params', { sessionId: 's', text: '😀'.repeat(60) })).toBe(true)
    expect(ok(s, 'params', { sessionId: 's', text: '😀'.repeat(61) })).toBe(false)
    expect(ok(s, 'params', { sessionId: 's', text: '' })).toBe(false)
    expect(ok(s, 'params', { sessionId: 's', text: 'hi', speed: 0.2 })).toBe(false)
    expect(ok(s, 'params', { sessionId: 's', text: 'hi', speed: 4 })).toBe(true)
    expect(ok(s, 'params', { sessionId: 's', text: 'hi', speed: 0.25 })).toBe(true)
  })

  it('keeps the speech result within 1,024,000 characters of mp3', () => {
    const s = '_agnes/v1/session.voice.speak'
    expect(ok(s, 'result', { audio: 'A'.repeat(1_024_000), mimeType: 'audio/mpeg' })).toBe(true)
    expect(ok(s, 'result', { audio: 'A'.repeat(1_024_001), mimeType: 'audio/mpeg' })).toBe(false)
    expect(ok(s, 'result', { audio: 'AAAA', mimeType: 'audio/wav' })).toBe(false)
  })

  it('validates the defaults and refuses settings out of range', () => {
    const save = '_agnes/v1/voice.settings.save'
    const revision = 'a'.repeat(64)
    const d = DEFAULT_VOICE_SETTINGS
    expect(ok(save, 'params', { settings: d, expectedRevision: revision })).toBe(true)
    const bad = (settings: unknown) => ok(save, 'params', { settings, expectedRevision: revision })
    expect(bad({ ...d, input: { ...d.input, maxSeconds: 121 } })).toBe(false)
    expect(bad({ ...d, conversation: { pauseSeconds: 0.4 } })).toBe(false)
    expect(bad({ ...d, account: 'a'.repeat(65) })).toBe(false)
    expect(bad({ ...d, extra: true })).toBe(false)
    expect(ok(save, 'params', { settings: d, expectedRevision: 'A'.repeat(64) })).toBe(false)
  })

  it('reports feature states and settings in voice.status', () => {
    const status = '_agnes/v1/voice.status'
    const base = { account: { route: 'account-a', label: 'A' }, settings: DEFAULT_VOICE_SETTINGS }
    expect(ok(status, 'result', { transcribe: 'available', speech: 'unconfigured', ...base })).toBe(true)
    expect(ok(status, 'result', { transcribe: 'available', speech: 'no-model', ...base })).toBe(true)
    expect(ok(status, 'result', { transcribe: 'off', speech: 'unconfigured', ...base })).toBe(false)
    expect(
      ok(status, 'result', {
        transcribe: 'unconfigured',
        speech: 'unconfigured',
        reason: 'no-account',
        settings: DEFAULT_VOICE_SETTINGS,
      }),
    ).toBe(true)
  })

  it('takes an empty object for voice.status and voice.settings.get', () => {
    expect(ok('_agnes/v1/voice.status', 'params', {})).toBe(true)
    expect(ok('_agnes/v1/voice.settings.get', 'params', {})).toBe(true)
    expect(ok('_agnes/v1/voice.settings.get', 'params', { x: 1 })).toBe(false)
  })

  it('classifies the voice methods', () => {
    expect(METHOD_TIERS['_agnes/v1/session.voice.transcribe']).toBe('client')
    expect(METHOD_TIERS['_agnes/v1/session.voice.speak']).toBe('client')
    expect(METHOD_TIERS['_agnes/v1/voice.status']).toBe('client')
    expect(METHOD_TIERS['_agnes/v1/voice.settings.get']).toBe('admin')
    expect(METHOD_TIERS['_agnes/v1/voice.settings.save']).toBe('admin')
    expect(METHODS['_agnes/v1/voice.status']).toMatchObject({ kind: 'request', direction: 'c2s' })
  })

  it('freezes the shared defaults deeply', () => {
    for (const v of [
      DEFAULT_VOICE_SETTINGS,
      DEFAULT_VOICE_SETTINGS.input,
      DEFAULT_VOICE_SETTINGS.reading,
      DEFAULT_VOICE_SETTINGS.conversation,
    ])
      expect(Object.isFrozen(v)).toBe(true)
    expect(structuredClone(DEFAULT_VOICE_SETTINGS)).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(Object.isFrozen(structuredClone(DEFAULT_VOICE_SETTINGS))).toBe(false)
  })

  it('derives the size constants from one another', () => {
    const wav = (seconds: number) => WAV_HEADER_BYTES + seconds * WAV_BYTES_PER_SECOND
    // A full segment fits the schema cap, with the schema leaving room for the 0.5 s slack.
    expect(base64Chars(wav(VOICE_SEGMENT_MAX_SECONDS))).toBe(853_392)
    expect(base64Chars(wav(VOICE_SEGMENT_MAX_SECONDS))).toBeLessThanOrEqual(VOICE_AUDIO_MAX_BASE64)
    expect(base64Chars(wav(VOICE_SEGMENT_MAX_SECONDS + VOICE_SEGMENT_SLACK_SECONDS))).toBeLessThanOrEqual(
      VOICE_AUDIO_MAX_BASE64,
    )
    // 768,000 mp3 bytes (the ai package MAX_SPEECH_BYTES) as base64.
    expect(base64Chars(768_000)).toBe(VOICE_SPEECH_MAX_BASE64)
    // The schema caps are the constants.
    expect(
      ok('_agnes/v1/session.voice.transcribe', 'params', {
        sessionId: 's',
        audio: 'A'.repeat(VOICE_AUDIO_MAX_BASE64),
      }),
    ).toBe(true)
    expect(
      ok('_agnes/v1/session.voice.speak', 'params', {
        sessionId: 's',
        text: 'a'.repeat(VOICE_SPEAK_MAX_CHARS),
      }),
    ).toBe(true)
    expect(
      ok('_agnes/v1/session.voice.speak', 'params', {
        sessionId: 's',
        text: 'a'.repeat(VOICE_SPEAK_MAX_CHARS + 1),
      }),
    ).toBe(false)
    expect(
      ok('_agnes/v1/session.voice.transcribe', 'result', { text: 'a'.repeat(VOICE_TRANSCRIPT_MAX_CHARS) }),
    ).toBe(true)
    expect(
      ok('_agnes/v1/session.voice.transcribe', 'result', {
        text: 'a'.repeat(VOICE_TRANSCRIPT_MAX_CHARS + 1),
      }),
    ).toBe(false)
    // The caller waits longer than the server deadline.
    expect(VOICE_LINK_TIMEOUT_MS).toBeGreaterThan(VOICE_CALL_TIMEOUT_MS)
  })
})
