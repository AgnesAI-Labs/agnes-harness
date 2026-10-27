import {
  type ConfigSnapshot,
  DEFAULT_VOICE_SETTINGS,
  type UINode,
  type UITurn,
  VOICE_LINK_TIMEOUT_MS,
  type VoiceFeatureState,
  type VoiceSettingsSnapshot,
  type VoiceStatusResult,
} from '@agnes/protocol'
import type {
  SessionService,
  VoiceComposer,
  VoiceLevel,
  VoiceNoticeKey,
  VoicePort,
  VoiceSettingsApi,
  VoiceUnavailable,
  VoiceViewState,
} from '@agnes/web-client'
import { chunkPlan, downmixResample, encodeWav16, joinTranscripts, levelOf, toBase64 } from './audio.js'
import { createConversation, type HeardAudio, type ReadOutcome } from './conversation.js'
import { createEndpointDetector } from './endpoint.js'
import { SpeechPlayer } from './player.js'
import { browserMedia, type VoiceInput, type VoiceMedia } from './recorder.js'
import { speechSegments, speechText } from './speech-text.js'
import { VoiceTabLock } from './tab-lock.js'
import { type TurnOutcome, TurnWatch } from './turn-watch.js'

export type { VoiceInput, VoiceMedia }

const TICK_MS = 50
const NOTICE_MS = 4_000
/** A recording shorter than this is never sent (the schema also rejects a near-empty WAV). */
const MIN_SECONDS = 0.3
/** The endpoint detector's onset, and how much audio before it a conversation keeps. */
const ONSET_MS = 200
const LEAD_MS = 300
const BUSY_BACKOFF_MS = [500, 1_000, 2_000] as const
const RATE = 16_000
/** The side-model adapter voice accounts use (the host's `VOICE_WIRE_API`). */
const VOICE_PROVIDER = 'openai-audio'

type CallOptions = { signal?: AbortSignal; timeoutMs?: number }
type BoundSession = Pick<SessionService, 'subscribe' | 'getSnapshot' | 'readiness'>
type Dictation = VoiceViewState['dictation']
type Recording = {
  readonly target: VoiceComposer | undefined
  readonly detector: ReturnType<typeof createEndpointDetector>
  input?: VoiceInput
  timer?: ReturnType<typeof setInterval>
  start: number
  heard: boolean
}

export type VoiceControllerDeps = {
  call<T>(method: string, params: unknown, options?: CallOptions): Promise<T>
  config(): Promise<ConfigSnapshot>
  openSettings(section: string): void
  media?: VoiceMedia
  channel?: BroadcastChannel
  createAudio?(url: string): HTMLAudioElement
  secure?: () => boolean
  now?: () => number
  tabId?: string
}
export type VoiceController = VoicePort & {
  bindSession(session: BoundSession): () => void
  observeTranscript(nodes: readonly UINode[], turns: readonly UITurn[]): void
  refresh(): void
  readonly settingsApi: VoiceSettingsApi
  dispose(): void
}

class SessionFailed extends Error {}

const errorData = (error: unknown): Readonly<Record<string, unknown>> => {
  const data = (error as { data?: unknown } | null)?.data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}
const missingMethod = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === -32601 || errorData(error).code === 'METHOD_NOT_FOUND'
const micDenied = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === 'NotAllowedError'
const seconds = (audio: HeardAudio): number => (audio.channels[0]?.length ?? 0) / audio.sampleRate
const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
const IDLE_DICTATION = { phase: 'idle', seconds: 0, level: 0 } as const

/**
 * The host's voice function: button state from `voice.status`, dictation into the bound composer,
 * read-aloud and auto-read of the viewed session's final reply, and the voice conversation loop.
 */
export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const now = deps.now ?? (() => Date.now())
  const secure = deps.secure ?? (() => typeof window === 'undefined' || window.isSecureContext !== false)
  const media = deps.media ?? browserMedia()
  const lock = new VoiceTabLock({
    tabId: deps.tabId ?? crypto.randomUUID(),
    ...(deps.channel ? { channel: deps.channel } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  const listeners = new Set<() => void>()
  const watch = new TurnWatch()
  const waiters = new Set<(outcome: TurnOutcome) => void>()
  let status: VoiceStatusResult | undefined
  let failure: 'missing' | 'offline' | undefined
  let dictation: Pick<Dictation, 'phase' | 'seconds' | 'level'> = IDLE_DICTATION
  let recording: Recording | undefined
  let transcribing: AbortController | undefined
  let conversationLevel: VoiceLevel = 0
  let notice: VoiceViewState['notice']
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let composer: VoiceComposer | undefined
  let session: BoundSession | undefined
  let sessionId: string | undefined
  let speakSession: string | undefined
  let ensuring = 0
  let ensured: string | undefined
  let disposed = false
  let snapshot: VoiceViewState | undefined
  const settings = () => status?.settings ?? DEFAULT_VOICE_SETTINGS

  const emit = (): void => {
    if (disposed) return
    snapshot = compute()
    for (const listener of [...listeners]) listener()
  }
  const showNotice = (key: VoiceNoticeKey): void => {
    clearTimeout(noticeTimer)
    notice = { key, at: now() }
    noticeTimer = setTimeout(() => {
      notice = undefined
      emit()
    }, NOTICE_MS)
    emit()
  }
  const failed = (error: unknown): void =>
    showNotice(error instanceof SessionFailed ? 'session-failed' : micDenied(error) ? 'mic-denied' : 'failed')

  // Status: one call in flight; a request made meanwhile runs once more afterwards.
  let statusRunning = false
  let statusAgain = false
  const refresh = (): void => {
    if (disposed) return
    if (statusRunning) {
      statusAgain = true
      return
    }
    statusRunning = true
    void (async () => {
      try {
        status = await deps.call<VoiceStatusResult>('_agnes/v1/voice.status', {})
        failure = undefined
      } catch (error) {
        // An older daemon has no voice methods: show nothing rather than a broken button.
        if (missingMethod(error)) status = undefined
        failure = missingMethod(error) ? 'missing' : 'offline'
      }
      statusRunning = false
      emit()
      if (statusAgain) {
        statusAgain = false
        refresh()
      }
    })()
  }

  /** A voice call; a session still busy with an aborted call is retried with backoff. */
  const voiceCall = async <T>(method: string, params: unknown, signal: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.call<T>(method, params, { signal, timeoutMs: VOICE_LINK_TIMEOUT_MS })
      } catch (error) {
        const data = errorData(error)
        const delay = BUSY_BACKOFF_MS[attempt]
        const busy = data.code === 'SESSION_BUSY' && /^voice\.(transcribe|speak)$/.test(String(data.reason))
        if (busy && delay !== undefined && !signal.aborted) {
          await wait(delay, signal)
          continue
        }
        if (data.reason === 'VOICE_UNAVAILABLE') refresh()
        throw error
      }
    }
  }

  const player = new SpeechPlayer({
    synthesize: async (text, signal) =>
      (
        await voiceCall<{ audio: string }>(
          '_agnes/v1/session.voice.speak',
          { sessionId: speakSession, text },
          signal,
        )
      ).audio,
    createAudio: deps.createAudio ?? ((url) => new Audio(url)),
    onStart: () => lock.announcePlaying(),
  })
  const play = async (nodeId: string, text: string): Promise<ReadOutcome> => {
    const id = session?.getSnapshot()
    if (!id) return 'failed'
    speakSession = id
    const outcome = await player.play(nodeId, speechSegments(speechText(text)))
    if (outcome === 'failed') showNotice('failed')
    return outcome
  }
  /** Reads to the end; a blocked start waits for the click that resumes it. */
  const readToEnd = async (nodeId: string, text: string): Promise<ReadOutcome> => {
    const outcome = await play(nodeId, text)
    if (outcome !== 'blocked') return outcome
    await new Promise<void>((resolve) => {
      const stop = player.state.subscribe(() => {
        const current = player.state.getSnapshot()
        if (current.phase !== 'idle' && current.nodeId === nodeId) return
        stop()
        resolve()
      })
    })
    return 'ended'
  }

  const ensureSession = async (target: VoiceComposer): Promise<string> => {
    ensuring++
    try {
      ensured = await target.ensureSession()
      return ensured
    } catch {
      throw new SessionFailed()
    } finally {
      ensuring--
    }
  }
  const transcribeAll = async (heard: HeardAudio, target: VoiceComposer, signal: AbortSignal) => {
    const mono = downmixResample(heard.channels, heard.sampleRate)
    const chunks = chunkPlan(mono, RATE).map(([from, to]) =>
      toBase64(encodeWav16(mono.subarray(from, to), RATE)),
    )
    const id = await ensureSession(target)
    const texts: string[] = []
    for (const audio of chunks) {
      const params = { sessionId: id, audio }
      texts.push(
        (await voiceCall<{ text: string }>('_agnes/v1/session.voice.transcribe', params, signal)).text,
      )
    }
    return joinTranscripts(texts)
  }

  /** Listens for one utterance; keeps from shortly before the speech started. */
  const listen = async (signal: AbortSignal): Promise<HeardAudio | 'idle-timeout'> => {
    const input = await media.open()
    if (signal.aborted) {
      input.cancel()
      throw signal.reason
    }
    const s = settings()
    const detector = createEndpointDetector({
      pauseMs: s.conversation.pauseSeconds * 1000,
      maxMs: s.input.maxSeconds * 1000,
      frameMs: TICK_MS,
      onsetMs: ONSET_MS,
    })
    return new Promise((resolve, reject) => {
      let frames = 0
      let startFrame = 0
      const finish = () => {
        clearInterval(timer)
        signal.removeEventListener('abort', onAbort)
        conversationLevel = 0
        emit()
      }
      const onAbort = () => {
        finish()
        input.cancel()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setInterval(() => {
        const rms = input.level()
        frames++
        conversationLevel = levelOf(rms)
        emit()
        const event = detector.push(rms)
        if (event === 'speech-start') startFrame = frames
        if (event === 'idle-timeout') {
          finish()
          input.cancel()
          resolve('idle-timeout')
        }
        if (event !== 'speech-end' && event !== 'max-length') return
        finish()
        const from = Math.max(0, (startFrame * TICK_MS - ONSET_MS - LEAD_MS) / 1000)
        input.stop().then(
          (heard) =>
            resolve({
              ...heard,
              channels: heard.channels.map((c) => c.subarray(Math.round(from * heard.sampleRate))),
            }),
          reject,
        )
      }, TICK_MS)
    })
  }

  const conversation = createConversation({
    listen,
    transcribe: async (heard, signal) => {
      if (!composer) throw new Error('no composer')
      return seconds(heard) < MIN_SECONDS ? '' : transcribeAll(heard, composer, signal)
    },
    send: (text) => {
      if (!composer) return false
      composer.insertText(text)
      return composer.submit()
    },
    nextTurn: (signal) =>
      new Promise((resolve, reject) => {
        const take = (outcome: TurnOutcome) => {
          waiters.delete(take)
          resolve(outcome)
        }
        waiters.add(take)
        signal.addEventListener(
          'abort',
          () => {
            waiters.delete(take)
            reject(signal.reason)
          },
          { once: true },
        )
      }),
    read: readToEnd,
    stopReading: () => player.stop(),
    notice: showNotice,
    fail: failed,
    lock,
  })

  // Esc cancels a recording or leaves the conversation; the shell's own Esc then sees defaultPrevented.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing) return
    if (recording) {
      event.preventDefault()
      cancelDictation()
    } else if (conversation.phase.getSnapshot() !== 'idle') {
      event.preventDefault()
      conversation.exit()
    }
  }
  let escapeBound = false
  const bindEscape = (): void => {
    const want = !disposed && (recording !== undefined || conversation.phase.getSnapshot() !== 'idle')
    if (want === escapeBound || typeof window === 'undefined') return
    escapeBound = want
    if (want) window.addEventListener('keydown', onKeyDown, true)
    else window.removeEventListener('keydown', onKeyDown, true)
  }

  const setDictation = (next: Partial<typeof dictation>): void => {
    dictation = { ...dictation, ...next }
    bindEscape()
    emit()
  }
  const startDictation = (): void => {
    const state = snapshot?.dictation
    if (!state?.visible || state.disabled) return
    player.stop()
    const maxMs = settings().input.maxSeconds * 1000
    const current: Recording = {
      // Captured now: the composer may remount while the session opens.
      target: composer,
      // A fixed threshold, so speech from the first frame counts; only "was anything said" matters.
      detector: createEndpointDetector({ pauseMs: maxMs, maxMs, floorMs: 0, idleMs: 2 * maxMs }),
      start: now(),
      heard: false,
    }
    recording = current
    setDictation({ phase: 'recording', seconds: 0, level: 0 })
    media.open().then(
      (input) => {
        if (recording !== current) return input.cancel()
        current.input = input
        current.start = now()
        current.timer = setInterval(() => {
          const rms = input.level()
          if (current.detector.push(rms) === 'speech-start') current.heard = true
          const elapsed = now() - current.start
          setDictation({ seconds: Math.floor(elapsed / 1000), level: levelOf(rms) })
          if (elapsed >= maxMs) void finishDictation()
        }, TICK_MS)
      },
      (error: unknown) => {
        if (recording !== current) return
        recording = undefined
        setDictation(IDLE_DICTATION)
        failed(error)
      },
    )
  }
  const cancelDictation = (): void => {
    const current = recording
    if (!current) return
    recording = undefined
    clearInterval(current.timer)
    current.input?.cancel()
    setDictation(IDLE_DICTATION)
  }
  const finishDictation = async (): Promise<void> => {
    const current = recording
    const input = current?.input
    if (!current || !input) return cancelDictation()
    recording = undefined
    clearInterval(current.timer)
    const abort = new AbortController()
    transcribing = abort
    setDictation({ phase: 'transcribing', level: 0 })
    try {
      const heard = await input.stop()
      const target = current.target
      if (!current.heard || seconds(heard) < MIN_SECONDS) return showNotice('empty')
      if (!target) throw new Error('no composer')
      const text = await transcribeAll(heard, target, abort.signal)
      if (abort.signal.aborted) return
      if (!text) return showNotice('empty')
      target.insertText(text)
      if (!settings().input.autoSend) target.focus()
      else if (!target.submit()) showNotice('failed')
    } catch (error) {
      if (!abort.signal.aborted) failed(error)
    } finally {
      if (transcribing === abort) {
        transcribing = undefined
        setDictation(IDLE_DICTATION)
      }
    }
  }

  const autoRead = async (id: string, outcome: Extract<TurnOutcome, { kind: 'reply' }>): Promise<void> => {
    const reading = settings().reading
    if (!reading.enabled || !reading.autoRead || status?.speech !== 'available' || failure) return
    if (lock.conversationElsewhere() || !(await lock.claimAuto(`${id}:${outcome.turnId}`))) return
    if (session?.getSnapshot() !== id || conversation.phase.getSnapshot() !== 'idle' || recording) return
    void play(outcome.nodeId, outcome.text)
  }
  const onSessionChange = (): void => {
    const next = session?.getSnapshot()
    const previous = sessionId
    sessionId = next
    if (next === previous) return
    watch.reset()
    // The session this voice input opened on the new-chat page is not a switch away.
    if (previous === undefined && next !== undefined && (ensuring > 0 || next === ensured)) return
    player.stop()
    conversation.exit()
  }

  const featureReason = (state: VoiceFeatureState): VoiceUnavailable | undefined => {
    if (state === 'available') return undefined
    if (status?.reason) return status.reason
    return state === 'unconfigured' ? 'no-account' : state
  }
  function compute(): VoiceViewState {
    const s = settings()
    const known = status !== undefined || failure === 'offline'
    const insecure = secure() ? undefined : 'insecure-context'
    const offline = failure === 'offline' ? 'offline' : undefined
    const transcribe = status && !offline ? featureReason(status.transcribe) : undefined
    const speech = status && !offline ? featureReason(status.speech) : undefined
    const phase = conversation.phase.getSnapshot()
    const elsewhere = phase === 'idle' && lock.conversationElsewhere() ? 'other-tab' : undefined
    const dictationDisabled = insecure ?? transcribe ?? offline
    const conversationDisabled = insecure ?? transcribe ?? speech ?? elsewhere ?? offline
    const played = player.state.getSnapshot()
    return {
      dictation: {
        visible: known && s.input.enabled,
        ...(dictationDisabled ? { disabled: dictationDisabled } : {}),
        ...dictation,
      },
      conversation: {
        visible: known && s.input.enabled && s.reading.enabled,
        ...(conversationDisabled ? { disabled: conversationDisabled } : {}),
        phase,
        level: conversationLevel,
      },
      reading: {
        visible: !offline && status?.speech === 'available' && s.reading.enabled,
        ...(played.nodeId ? { nodeId: played.nodeId } : {}),
        phase: played.phase,
      },
      ...(notice ? { notice } : {}),
    }
  }

  const settingsApi: VoiceSettingsApi = {
    read: () => deps.call<VoiceSettingsSnapshot>('_agnes/v1/voice.settings.get', {}),
    async save(next, expectedRevision) {
      const saved = await deps.call<VoiceSettingsSnapshot>('_agnes/v1/voice.settings.save', {
        settings: next,
        expectedRevision,
      })
      refresh()
      lock.announceStatusChanged()
      return saved
    },
    async accounts() {
      const { accounts = [] } = await deps.config()
      return accounts
        .filter((account) => account.providerId === VOICE_PROVIDER && account.enabled)
        .map(({ route, label }) => ({ route, label }))
    },
    openSideModels: () => deps.openSettings('side-models'),
  }

  player.state.subscribe(emit)
  conversation.phase.subscribe(() => {
    bindEscape()
    emit()
  })
  lock.subscribe(emit)
  lock.onPeerPlaying(() => player.stop())
  lock.onStatusChanged(refresh)
  snapshot = compute()
  refresh()

  return {
    state: {
      getSnapshot: () => snapshot ?? compute(),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    bindComposer(next) {
      composer = next
      return () => {
        if (composer === next) composer = undefined
      }
    },
    bindSession(next) {
      session = next
      sessionId = next.getSnapshot()
      watch.reset()
      const stop = next.subscribe(onSessionChange)
      return () => {
        stop()
        if (session === next) session = undefined
      }
    },
    observeTranscript(nodes, turns) {
      const readiness = session?.readiness.getSnapshot()
      const id = readiness?.sessionId ?? session?.getSnapshot()
      // History loads before `ready`, and an empty view is not a baseline: neither is ever read.
      if (readiness?.status !== 'ready' || !id || turns.length === 0) return
      const outcome = watch.observe({ sessionId: id, epoch: readiness.epoch }, nodes, turns)
      if (!outcome) return
      if (conversation.phase.getSnapshot() !== 'idle') for (const take of [...waiters]) take(outcome)
      else if (outcome.kind === 'reply') void autoRead(id, outcome)
    },
    toggleDictation() {
      if (conversation.phase.getSnapshot() !== 'idle') return conversation.interrupt()
      if (recording) return void finishDictation()
      if (dictation.phase === 'idle') startDictation()
    },
    toggleConversation() {
      if (conversation.phase.getSnapshot() !== 'idle') return conversation.exit()
      const state = snapshot?.conversation
      if (!state?.visible || state.disabled) return
      cancelDictation()
      player.stop()
      conversation.start()
    },
    toggleReading(nodeId, text) {
      const current = player.state.getSnapshot()
      if (current.nodeId === nodeId && current.phase !== 'idle') return player.stop()
      // A conversation reads its own replies; another one now would play into the open microphone.
      if (conversation.phase.getSnapshot() !== 'idle') return
      void play(nodeId, text)
    },
    resumePlayback() {
      void player.resume()
    },
    openSettings: () => deps.openSettings('side-models'),
    refresh,
    settingsApi,
    dispose() {
      if (disposed) return
      conversation.exit()
      cancelDictation()
      transcribing?.abort()
      player.stop()
      disposed = true
      bindEscape()
      clearTimeout(noticeTimer)
      lock.dispose()
      listeners.clear()
    },
  }
}
