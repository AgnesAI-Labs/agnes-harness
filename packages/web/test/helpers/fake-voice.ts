import type { VoiceComposer, VoiceViewState } from '@agnes/web-client'
import { type Mock, vi } from 'vitest'
import type { VoiceController } from '../../src/voice/controller.js'

type Commands =
  | 'bindComposer'
  | 'toggleDictation'
  | 'toggleConversation'
  | 'toggleReading'
  | 'resumePlayback'
  | 'openSettings'
  | 'bindSession'
  | 'observeTranscript'
  | 'refresh'
  | 'dispose'
export type FakeVoice = VoiceController & { [K in Commands]: Mock<VoiceController[K]> }

/** A voice controller double with a fixed view state; it records the composer it is bound to. */
export function fakeVoice(state: Partial<VoiceViewState> = {}): {
  voice: FakeVoice
  bound(): VoiceComposer | null
} {
  const snapshot: VoiceViewState = {
    dictation: { visible: true, phase: 'idle', seconds: 0, level: 0 },
    conversation: { visible: true, phase: 'idle', level: 0 },
    reading: { visible: true, phase: 'idle' },
    ...state,
  }
  let composer: VoiceComposer | undefined
  const voice: FakeVoice = {
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    bindComposer: vi.fn((next: VoiceComposer) => {
      composer = next
      return () => {}
    }),
    toggleDictation: vi.fn(),
    toggleConversation: vi.fn(),
    toggleReading: vi.fn(),
    resumePlayback: vi.fn(),
    openSettings: vi.fn(),
    bindSession: vi.fn(() => () => {}),
    observeTranscript: vi.fn(),
    refresh: vi.fn(),
    settingsApi: {} as VoiceController['settingsApi'],
    dispose: vi.fn(),
  }
  return { voice, bound: () => composer ?? null }
}
