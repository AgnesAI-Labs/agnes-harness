import type { VoiceSettings } from '../gen/ts/agnes-v1.js'

/** Longest dictation segment the web records and the daemon accepts. */
export const VOICE_SEGMENT_MAX_SECONDS = 20
/** Slack over the segment cap that the host tolerates for header and rounding (seconds). */
export const VOICE_SEGMENT_SLACK_SECONDS = 0.5
/** 20 s of 16 kHz mono 16-bit WAV = 853,392 base64 characters; the schema caps at this. */
export const VOICE_AUDIO_MAX_BASE64 = 900_000
/**
 * UTF-16 code units, not code points: the runtime gate is TypeBox `Value.Check`, which counts units, so a
 * character outside the BMP (an emoji) counts as 2. 60 emoji fit; 61 do not.
 */
export const VOICE_SPEAK_MAX_CHARS = 120
/** 768,000 mp3 bytes (the ai package `MAX_SPEECH_BYTES`) as base64: ceil(768000 / 3) * 4. */
export const VOICE_SPEECH_MAX_BASE64 = 1_024_000
export const VOICE_TRANSCRIPT_MAX_CHARS = 16_384
/** Server-side deadline for one voice call. */
export const VOICE_CALL_TIMEOUT_MS = 30_000
/** Client and daemon-to-worker wait for one voice call: the deadline plus transport slack. */
export const VOICE_LINK_TIMEOUT_MS = 35_000

/** Shared and deeply frozen: a store that hands settings out must clone it (`structuredClone`). */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = Object.freeze({
  account: '',
  input: Object.freeze({ enabled: true, language: '', autoSend: false, maxSeconds: 120 }),
  reading: Object.freeze({ enabled: true, voice: '', speed: 1, autoRead: false }),
  conversation: Object.freeze({ pauseSeconds: 1.2 }),
})
