import type { VoiceSettings, VoiceSettingsSnapshot } from '@agnes/protocol'

/**
 * The host's voice function as a dialog plugin sees it: button state to render and the commands the
 * buttons send. The host owns recording, transcription, playback and the tab lock; any dialog plugin
 * may render from this port.
 */
export type VoiceUnavailable =
  | 'no-account'
  | 'credential-missing'
  | 'ambiguous'
  | 'no-model'
  | 'insecure-context'
  | 'other-tab'
  | 'offline'
export type VoiceLevel = 0 | 1 | 2 | 3 | 4
export type ConversationPhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'reading'
export type VoiceNoticeKey = 'empty' | 'turn-ended' | 'failed' | 'mic-denied' | 'session-failed'
export type VoiceViewState = Readonly<{
  dictation: Readonly<{
    visible: boolean
    disabled?: VoiceUnavailable
    phase: 'idle' | 'recording' | 'transcribing'
    seconds: number
    level: VoiceLevel
  }>
  conversation: Readonly<{
    visible: boolean
    disabled?: VoiceUnavailable
    phase: ConversationPhase
    level: VoiceLevel
  }>
  reading: Readonly<{ visible: boolean; nodeId?: string; phase: 'idle' | 'loading' | 'playing' | 'blocked' }>
  notice?: Readonly<{ key: VoiceNoticeKey; at: number }>
}>
/** What the voice function needs from the composer it fills. */
export type VoiceComposer = Readonly<{
  insertText(text: string): void
  /** Sends the draft like the send button; false when the composer refused (empty, busy, read-only). */
  submit(): boolean
  focus(): void
  /** The session the text belongs to, opened on demand on the new-chat page. */
  ensureSession(): Promise<string>
}>
export interface VoicePort {
  readonly state: Readonly<{ getSnapshot(): VoiceViewState; subscribe(listener: () => void): () => void }>
  bindComposer(composer: VoiceComposer): () => void
  /** Idle: record. Recording: stop and transcribe. Reading in a conversation: interrupt and listen. */
  toggleDictation(): void
  toggleConversation(): void
  toggleReading(nodeId: string, text: string): void
  /** Continues playback the browser blocked; call it from the click. */
  resumePlayback(): void
  /** Opens the side-model settings, where voice accounts are configured. */
  openSettings(): void
}
/** The voice settings section's view of the settings and the accounts it can choose from. */
export type VoiceSettingsApi = {
  read(): Promise<VoiceSettingsSnapshot>
  /** Saves, then refreshes the button state here and in the other tabs. */
  save(settings: VoiceSettings, expectedRevision: string): Promise<VoiceSettingsSnapshot>
  accounts(): Promise<readonly { route: string; label: string }[]>
  openSideModels(): void
}
