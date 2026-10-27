/** @vitest-environment happy-dom */
import {
  DEFAULT_VOICE_SETTINGS,
  type UINode,
  type UITurn,
  VOICE_LINK_TIMEOUT_MS,
  type VoiceSettings,
  type VoiceStatusResult,
} from '@agnes/protocol'
import type { VoiceComposer, VoiceUnavailable } from '@agnes/web-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceController, type VoiceMedia } from '../src/voice/controller.js'
import { installVoice } from '../src/voice/install.js'
import { speechSegments, speechText } from '../src/voice/speech-text.js'
import { voiceLocaleCatalog } from '../src/voice/voice-locale.js'

const D = DEFAULT_VOICE_SETTINGS
const A = { route: 'account-a', label: '硅基流动' }
const settings = (patch: {
  input?: Partial<VoiceSettings['input']>
  reading?: Partial<VoiceSettings['reading']>
}) =>
  ({
    ...D,
    input: { ...D.input, ...patch.input },
    reading: { ...D.reading, ...patch.reading },
  }) as VoiceSettings
const ready = (over: Partial<VoiceStatusResult> = {}): VoiceStatusResult => ({
  transcribe: 'available',
  speech: 'available',
  account: A,
  settings: D,
  ...over,
})
const rpcError = (data: Record<string, unknown>, code = -32000) =>
  Object.assign(new Error(String(data.code)), { code, data })

class FakeAudio extends EventTarget {
  blockNext = false
  plays = 0
  constructor(readonly url: string) {
    super()
  }
  play(): Promise<void> {
    this.plays++
    if (this.blockNext) {
      this.blockNext = false
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    }
    return Promise.resolve()
  }
  pause(): void {}
  end(): void {
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeChannel {
  private readonly listeners = new Set<(event: MessageEvent) => void>()
  readonly peers: FakeChannel[] = []
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }
  postMessage(data: unknown): void {
    for (const peer of this.peers)
      for (const listener of [...peer.listeners]) listener({ data } as MessageEvent)
  }
  close(): void {}
}
function pair(): [BroadcastChannel, BroadcastChannel] {
  const a = new FakeChannel()
  const b = new FakeChannel()
  a.peers.push(b)
  b.peers.push(a)
  return [a as unknown as BroadcastChannel, b as unknown as BroadcastChannel]
}

/** Deterministic noise at 0.3 amplitude, with true silence in the given windows (seconds). */
function noise(seconds: number, silence: [number, number][] = [], rate = 16_000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  let seed = 7
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    const t = i / rate
    out[i] = silence.some(([from, to]) => t >= from && t < to) ? 0 : (seed / 2_147_483_648 - 0.5) * 0.6
  }
  return out
}

function fakeMedia(o: { samples?: Float32Array; levels?: number[]; level?: number; fail?: unknown } = {}) {
  const inputs: { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }[] = []
  const media: VoiceMedia = {
    open: vi.fn(async () => {
      if (o.fail) throw o.fail
      let tick = 0
      const input = {
        level: () => (o.levels ? (o.levels[tick++] ?? o.levels.at(-1) ?? 0) : (o.level ?? 0.2)),
        stop: vi.fn(async () => ({ channels: [o.samples ?? noise(2)], sampleRate: 16_000 })),
        cancel: vi.fn(),
      }
      inputs.push(input)
      return input
    }),
  }
  return { media, inputs }
}

function fakeSession(initial: string | undefined) {
  let id = initial
  let readiness: { status: 'no-session' | 'connecting' | 'ready'; sessionId?: string; epoch: number } = {
    status: initial ? 'ready' : 'no-session',
    ...(initial ? { sessionId: initial } : {}),
    epoch: 1,
  }
  const listeners = new Set<() => void>()
  const readinessListeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => id,
    readiness: {
      getSnapshot: () => readiness,
      subscribe: (listener: () => void) => {
        readinessListeners.add(listener)
        return () => readinessListeners.delete(listener)
      },
    },
    set(next: string | undefined, status: 'connecting' | 'ready' = 'ready') {
      const changed = next !== id
      id = next
      readiness = {
        status: next ? status : 'no-session',
        ...(next ? { sessionId: next } : {}),
        epoch: readiness.epoch + 1,
      }
      for (const listener of [...readinessListeners]) listener()
      if (changed) for (const listener of [...listeners]) listener()
    },
  }
}

const ZERO_USAGE: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}
const turn = (id: string, status: UITurn['status'], finalAssistantId?: string): UITurn => ({
  id,
  turn: 1,
  startSeq: 1,
  startedAt: '2026-10-27T00:00:00.000Z',
  status,
  nodeIds: finalAssistantId ? [finalAssistantId] : [],
  usage: ZERO_USAGE,
  inherited: false,
  forkable: true,
  ...(finalAssistantId ? { finalAssistantId } : {}),
})
const assistant = (id: string, text: string): UINode => ({ kind: 'assistant', id, seq: 2, text }) as UINode
const REPLY = '第一句话。第二句话！'

type Setup = {
  status?: VoiceStatusResult | Error
  secure?: boolean
  media?: VoiceMedia
  channel?: BroadcastChannel
  tabId?: string
  texts?: string[]
  transcribe?: (params: { sessionId: string; audio: string }) => Promise<{ text: string }>
  speak?: (params: { sessionId: string; text: string }) => Promise<{ audio: string; mimeType: 'audio/mpeg' }>
  session?: string | null
  submit?: boolean
  /** The first audio element refuses to play, as a browser blocking autoplay does. */
  block?: boolean
}
function setup(o: Setup = {}) {
  const log: string[] = []
  const texts = [...(o.texts ?? [])]
  const audios: FakeAudio[] = []
  const call = vi.fn(async (method: string, params: unknown, _options?: unknown): Promise<unknown> => {
    if (method === '_agnes/v1/voice.status') {
      if (o.status instanceof Error) throw o.status
      return o.status ?? ready()
    }
    if (method === '_agnes/v1/session.voice.transcribe') {
      log.push('transcribe')
      if (o.transcribe) return o.transcribe(params as { sessionId: string; audio: string })
      return { text: texts.shift() ?? '' }
    }
    if (method === '_agnes/v1/session.voice.speak') {
      log.push(`speak:${(params as { text: string }).text}`)
      if (o.speak) return o.speak(params as { sessionId: string; text: string })
      return { audio: 'AAAA', mimeType: 'audio/mpeg' }
    }
    if (method === '_agnes/v1/voice.settings.save')
      return { revision: 'b'.repeat(64), settings: (params as { settings: VoiceSettings }).settings }
    throw new Error(`unexpected ${method}`)
  })
  const openSettings = vi.fn()
  const { media, inputs } = o.media ? { media: o.media, inputs: [] } : fakeMedia()
  const controller = createVoiceController({
    call: call as never,
    config: async () =>
      ({
        accounts: [
          { providerId: 'openai-audio', route: 'account-a', label: '硅基流动', enabled: true },
          { providerId: 'openai-audio', route: 'account-b', label: 'Off', enabled: false },
          { providerId: 'openai', route: 'account-c', label: 'Chat', enabled: true },
        ],
      }) as never,
    openSettings,
    media,
    // An isolated channel by default: the real BroadcastChannel would join every controller in the file.
    channel: o.channel ?? (new FakeChannel() as unknown as BroadcastChannel),
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      if (o.block && audios.length === 0) audio.blockNext = true
      audios.push(audio)
      return audio as unknown as HTMLAudioElement
    },
    secure: () => o.secure ?? true,
    tabId: o.tabId ?? 'tab-a',
  })
  const composer = {
    insertText: vi.fn(),
    submit: vi.fn(() => o.submit ?? true),
    focus: vi.fn(),
    ensureSession: vi.fn(async () => {
      log.push('ensure')
      return session.getSnapshot() ?? 'created'
    }),
  } satisfies VoiceComposer
  const unbindComposer = controller.bindComposer(composer)
  const session = fakeSession(o.session === null ? undefined : (o.session ?? 's1'))
  const unbindSession = controller.bindSession(session as never)
  controllers.push(controller)
  const snapshot = () => controller.state.getSnapshot()
  const speaks = () => log.filter((entry) => entry.startsWith('speak:')).map((entry) => entry.slice(6))
  return {
    controller,
    call,
    log,
    audios,
    composer,
    session,
    inputs,
    openSettings,
    snapshot,
    speaks,
    unbindComposer,
    unbindSession,
  }
}
const statusCalls = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.filter(([method]) => method === '_agnes/v1/voice.status').length

const controllers: { dispose(): void }[] = []
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:x' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
})
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

/** Lets pending promise chains run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('voice button state', () => {
  type Button = [visible: boolean, disabled?: VoiceUnavailable | undefined]
  type Expect = { dictation?: Button; conversation?: Button; reading?: boolean }
  it.each<[string, VoiceStatusResult, Expect]>([
    [
      'no account',
      { transcribe: 'unconfigured', speech: 'unconfigured', reason: 'no-account', settings: D },
      { dictation: [true, 'no-account'], conversation: [true, 'no-account'], reading: false },
    ],
    [
      'voice input off',
      ready({ settings: settings({ input: { enabled: false } }) }),
      { dictation: [false], conversation: [false], reading: true },
    ],
    [
      'reading off',
      ready({ settings: settings({ reading: { enabled: false } }) }),
      { dictation: [true, undefined], conversation: [false], reading: false },
    ],
    [
      'no speech model',
      ready({ speech: 'no-model' }),
      { dictation: [true, undefined], conversation: [true, 'no-model'], reading: false },
    ],
    [
      'no recognition model',
      ready({ transcribe: 'no-model' }),
      { dictation: [true, 'no-model'], conversation: [true, 'no-model'], reading: true },
    ],
    [
      'a credential missing',
      {
        transcribe: 'credential-missing',
        speech: 'credential-missing',
        account: A,
        reason: 'credential-missing',
        settings: D,
      },
      { dictation: [true, 'credential-missing'], conversation: [true, 'credential-missing'], reading: false },
    ],
    [
      'several accounts',
      { transcribe: 'ambiguous', speech: 'ambiguous', reason: 'ambiguous', settings: D },
      { dictation: [true, 'ambiguous'], conversation: [true, 'ambiguous'], reading: false },
    ],
  ])('derives buttons for %s', async (_name, status, expected) => {
    const { snapshot } = setup({ status })
    await flush()
    const state = snapshot()
    if (expected.dictation) {
      expect(state.dictation.visible).toBe(expected.dictation[0])
      if (expected.dictation[0]) expect(state.dictation.disabled).toBe(expected.dictation[1])
    }
    if (expected.conversation) {
      expect(state.conversation.visible).toBe(expected.conversation[0])
      if (expected.conversation[0]) expect(state.conversation.disabled).toBe(expected.conversation[1])
    }
    if (expected.reading !== undefined) expect(state.reading.visible).toBe(expected.reading)
  })

  it('greys dictation but keeps reading on an insecure page', async () => {
    const { snapshot } = setup({ secure: false })
    await flush()
    expect(snapshot().dictation).toMatchObject({ visible: true, disabled: 'insecure-context' })
    expect(snapshot().conversation).toMatchObject({ visible: true, disabled: 'insecure-context' })
    expect(snapshot().reading.visible).toBe(true)
  })

  it('shows nothing before the first status and on a daemon without voice, offline on other failures', async () => {
    const missing = setup({ status: rpcError({ code: 'METHOD_NOT_FOUND' }, -32601) })
    expect(missing.snapshot().dictation.visible).toBe(false)
    await flush()
    expect(missing.snapshot().dictation.visible).toBe(false)
    expect(missing.snapshot().conversation.visible).toBe(false)
    expect(missing.snapshot().reading.visible).toBe(false)
    const offline = setup({ status: new Error('socket closed') })
    await flush()
    expect(offline.snapshot().dictation).toMatchObject({ visible: true, disabled: 'offline' })
    expect(offline.snapshot().conversation).toMatchObject({ visible: true, disabled: 'offline' })
    expect(offline.snapshot().reading.visible).toBe(false)
  })

  it('refreshes status on settings-route, configuration changes, a settings save and a peer notice', async () => {
    const [mine, peer] = pair()
    const call = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (method === '_agnes/v1/voice.settings.save')
        return { revision: 'b'.repeat(64), settings: (params as { settings: VoiceSettings }).settings }
      return ready()
    })
    const voice = installVoice({ call: call as never, config: { get: async () => ({}) as never } } as never, {
      channel: mine,
      tabId: 'tab-a',
    })
    controllers.push(voice)
    await flush()
    expect(statusCalls(call)).toBe(1)
    window.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'voice' }))
    await flush()
    expect(statusCalls(call)).toBe(2)
    window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
    await flush()
    expect(statusCalls(call)).toBe(3)
    await voice.settingsApi.save(D, 'a'.repeat(64))
    await flush()
    expect(statusCalls(call)).toBe(4)
    peer.postMessage({ type: 'status-changed', tab: 'tab-b' })
    await flush()
    expect(statusCalls(call)).toBe(5)
  })

  it('tells the other tabs after a settings save', async () => {
    const [mine, peer] = pair()
    const seen: unknown[] = []
    peer.addEventListener('message', (event) => seen.push(event.data))
    const { controller, call } = setup({ channel: mine })
    await controller.settingsApi.save(D, 'a'.repeat(64))
    expect(call).toHaveBeenCalledWith('_agnes/v1/voice.settings.save', {
      settings: D,
      expectedRevision: 'a'.repeat(64),
    })
    expect(seen).toContainEqual({ type: 'status-changed', tab: 'tab-a' })
  })

  it('keeps one status call in flight and runs one more for requests made meanwhile', async () => {
    let release: (() => void) | undefined
    const { controller, call } = setup()
    await flush()
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ready())
        }),
    )
    controller.refresh()
    controller.refresh()
    controller.refresh()
    await flush()
    expect(statusCalls(call)).toBe(2)
    release?.()
    await flush()
    expect(statusCalls(call)).toBe(3)
  })

  it('lists the enabled voice accounts and opens the side-model settings from the configure link', async () => {
    const { controller, openSettings } = setup()
    expect(await controller.settingsApi.accounts()).toEqual([{ route: 'account-a', label: '硅基流动' }])
    controller.openSettings()
    expect(openSettings).toHaveBeenCalledWith('side-models')
    controller.settingsApi.openSideModels()
    expect(openSettings).toHaveBeenLastCalledWith('side-models')
  })

  it('disables the conversation in this tab while another tab holds one', async () => {
    const [mine, theirs] = pair()
    const a = setup({ channel: mine, tabId: 'tab-a', media: fakeMedia({ level: 0.001 }).media })
    const b = setup({ channel: theirs, tabId: 'tab-b' })
    await flush()
    a.controller.toggleConversation()
    await flush()
    expect(a.snapshot().conversation.phase).toBe('listening')
    expect(b.snapshot().conversation.disabled).toBe('other-tab')
    a.controller.toggleConversation()
    await flush()
    expect(b.snapshot().conversation.disabled).toBeUndefined()
  })
})

describe('dictation', () => {
  it('opens the session, transcribes each chunk in order and inserts the joined text', async () => {
    let inFlight = 0
    let most = 0
    const texts = ['你好', '世界', 'hello']
    const { controller, composer, log, call } = setup({
      media: fakeMedia({ samples: noise(45, [[17.3, 17.5]]) }).media,
      transcribe: async () => {
        most = Math.max(most, ++inFlight)
        await Promise.resolve()
        inFlight--
        return { text: texts.shift() ?? '' }
      },
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    expect(controller.state.getSnapshot().dictation.phase).toBe('recording')
    controller.toggleDictation()
    await vi.waitFor(() => expect(composer.insertText).toHaveBeenCalled())
    expect(log).toEqual(['ensure', 'transcribe', 'transcribe', 'transcribe'])
    expect(most).toBe(1)
    expect(composer.ensureSession).toHaveBeenCalledTimes(1)
    expect(composer.insertText).toHaveBeenCalledWith('你好世界hello')
    expect(composer.focus).toHaveBeenCalled()
    expect(composer.submit).not.toHaveBeenCalled()
    const transcribes = call.mock.calls.filter(([method]) => method === '_agnes/v1/session.voice.transcribe')
    for (const [, params, options] of transcribes) {
      expect(params).toMatchObject({ sessionId: 's1' })
      expect(Object.keys(params as object).sort()).toEqual(['audio', 'sessionId'])
      expect(options).toMatchObject({ timeoutMs: VOICE_LINK_TIMEOUT_MS })
    }
    // The first cut sits in the silence at 17.35 s: 44 header bytes plus 16-bit samples, as base64.
    const first = (transcribes[0]?.[1] as { audio: string } | undefined)?.audio ?? ''
    expect(first.length).toBe(Math.ceil((44 + 2 * Math.round(17.35 * 16_000)) / 3) * 4)
    expect(controller.state.getSnapshot().dictation.phase).toBe('idle')
  })

  it('sends after dictation when autoSend is on', async () => {
    const { controller, composer } = setup({
      status: ready({ settings: settings({ input: { autoSend: true } }) }),
      texts: ['发送吧'],
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(composer.submit).toHaveBeenCalledTimes(1))
    expect(composer.insertText).toHaveBeenCalledWith('发送吧')
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('says it failed when the composer refuses the automatic send', async () => {
    const { controller, composer, snapshot } = setup({
      status: ready({ settings: settings({ input: { autoSend: true } }) }),
      texts: ['发送吧'],
      submit: false,
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(snapshot().notice?.key).toBe('failed'))
    expect(composer.insertText).toHaveBeenCalledWith('发送吧')
  })

  it('says it did not catch anything for an empty transcript', async () => {
    const { controller, composer, snapshot } = setup({ texts: ['  '] })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(snapshot().notice?.key).toBe('empty'))
    expect(composer.insertText).not.toHaveBeenCalled()
    // The notice shows for four seconds.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(snapshot().notice).toBeUndefined()
  })

  it.each([
    ['silent', { level: 0.001, samples: noise(3) }],
    ['too short', { level: 0.2, samples: noise(0.2) }],
  ])('sends nothing for a %s recording', async (_name, media) => {
    const { controller, call, composer, snapshot } = setup({ media: fakeMedia(media).media })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(snapshot().notice?.key).toBe('empty'))
    expect(call.mock.calls.some(([method]) => method === '_agnes/v1/session.voice.transcribe')).toBe(false)
    expect(composer.ensureSession).not.toHaveBeenCalled()
  })

  it('cancels recording on Escape and prevents the default', async () => {
    const { media, inputs } = fakeMedia()
    const { controller, call, snapshot } = setup({ media })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(snapshot().dictation.phase).toBe('idle')
    expect(inputs[0]?.cancel).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(call.mock.calls.some(([method]) => method === '_agnes/v1/session.voice.transcribe')).toBe(false)
    // Idle again, Escape belongs to the page.
    const later = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })

  it('stops at the maximum recording length', async () => {
    const { controller, snapshot } = setup({
      status: ready({ settings: settings({ input: { maxSeconds: 5 } }) }),
      transcribe: () => new Promise(() => {}),
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(snapshot().dictation).toMatchObject({ phase: 'recording', seconds: 4 })
    await vi.advanceTimersByTimeAsync(100)
    expect(snapshot().dictation.phase).toBe('transcribing')
  })

  it('reports a denied microphone and a session that would not open', async () => {
    const denied = setup({ media: fakeMedia({ fail: new DOMException('no', 'NotAllowedError') }).media })
    await flush()
    denied.controller.toggleDictation()
    await flush()
    expect(denied.snapshot().notice?.key).toBe('mic-denied')
    expect(denied.snapshot().dictation.phase).toBe('idle')

    const { controller, composer, snapshot, call } = setup({ texts: ['你好'] })
    composer.ensureSession.mockRejectedValueOnce(new Error('offline'))
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(snapshot().notice?.key).toBe('session-failed'))
    expect(composer.insertText).not.toHaveBeenCalled()
    expect(call.mock.calls.some(([method]) => method === '_agnes/v1/session.voice.transcribe')).toBe(false)
  })

  it('retries a busy session with backoff, and gives up on the rate limit', async () => {
    let busy = 2
    const { controller, composer, log } = setup({
      transcribe: async () => {
        if (busy-- > 0) throw rpcError({ code: 'SESSION_BUSY', reason: 'voice.transcribe' })
        return { text: '好了' }
      },
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    expect(log.filter((entry) => entry === 'transcribe')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(log.filter((entry) => entry === 'transcribe')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log.filter((entry) => entry === 'transcribe')).toHaveLength(3)
    await vi.waitFor(() => expect(composer.insertText).toHaveBeenCalledWith('好了'))

    const limited = setup({
      transcribe: async () => {
        throw rpcError({ code: 'OVERLOADED', reason: 'VOICE_RATE', retryAfterMs: 1_000 })
      },
    })
    await flush()
    limited.controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    limited.controller.toggleDictation()
    await vi.waitFor(() => expect(limited.snapshot().notice?.key).toBe('failed'))
    expect(limited.log.filter((entry) => entry === 'transcribe')).toHaveLength(1)
  })

  it('refreshes the status once when the daemon says voice is unavailable', async () => {
    const { controller, call, snapshot } = setup({
      transcribe: async () => {
        throw rpcError({ code: 'SEMANTIC_REJECTED', reason: 'VOICE_UNAVAILABLE', state: 'unconfigured' })
      },
    })
    await flush()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(400)
    controller.toggleDictation()
    await vi.waitFor(() => expect(snapshot().notice?.key).toBe('failed'))
    expect(statusCalls(call)).toBe(2)
  })

  it('stops playback when recording starts and when the session changes', async () => {
    const { controller, snapshot, session } = setup()
    await flush()
    controller.toggleReading('a1', REPLY)
    await flush()
    expect(snapshot().reading).toMatchObject({ nodeId: 'a1', phase: 'playing' })
    controller.toggleDictation()
    expect(snapshot().reading.phase).toBe('idle')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    controller.toggleReading('a1', REPLY)
    await flush()
    expect(snapshot().reading.phase).toBe('playing')
    session.set('s2')
    expect(snapshot().reading.phase).toBe('idle')
  })
})

describe('read-aloud', () => {
  it('reads the reply in protocol-sized segments and stops on a second click', async () => {
    const text = `${'很长的一句话'.repeat(30)}。结尾。`
    const { controller, snapshot, speaks, audios, call } = setup()
    await flush()
    controller.toggleReading('a1', text)
    await flush()
    const segments = speechSegments(speechText(text))
    expect(segments.length).toBeGreaterThan(1)
    expect(speaks()[0]).toBe(segments[0])
    const speak = call.mock.calls.find(([method]) => method === '_agnes/v1/session.voice.speak')
    expect(speak?.[1]).toEqual({ sessionId: 's1', text: segments[0] })
    expect(speak?.[2]).toMatchObject({ timeoutMs: VOICE_LINK_TIMEOUT_MS })
    controller.toggleReading('a1', text)
    expect(snapshot().reading.phase).toBe('idle')
    expect(audios).toHaveLength(1)
  })

  it('auto-reads only the viewed session’s new final reply when autoRead is on', async () => {
    const off = setup()
    await flush()
    off.controller.observeTranscript([], [turn('t1', 'running')])
    off.controller.observeTranscript([assistant('a1', REPLY)], [turn('t1', 'completed', 'a1')])
    await vi.advanceTimersByTimeAsync(500)
    expect(off.speaks()).toEqual([])

    const on = setup({ status: ready({ settings: settings({ reading: { autoRead: true } }) }) })
    await flush()
    // History loads as the first view of the epoch: never read.
    on.controller.observeTranscript([assistant('a0', '旧的回答。')], [turn('t0', 'completed', 'a0')])
    await vi.advanceTimersByTimeAsync(500)
    expect(on.speaks()).toEqual([])
    on.controller.observeTranscript(
      [assistant('a0', '旧的回答。')],
      [turn('t0', 'completed', 'a0'), turn('t1', 'running')],
    )
    on.controller.observeTranscript(
      [assistant('a0', '旧的回答。'), assistant('a1', REPLY)],
      [turn('t0', 'completed', 'a0'), turn('t1', 'completed', 'a1')],
    )
    await vi.advanceTimersByTimeAsync(500)
    const segments = speechSegments(speechText(REPLY))
    expect(on.speaks()).toEqual(segments.slice(0, 2))
    for (const audio of on.audios) audio.end()
    await flush()
    for (const audio of on.audios) audio.end()
    await flush()
    expect(on.speaks()).toEqual(segments)

    // Another session's view: its first render is a baseline, and a connecting session is not read.
    on.session.set('s2', 'connecting')
    on.controller.observeTranscript([], [turn('t5', 'running')])
    on.controller.observeTranscript([assistant('a5', '别的。')], [turn('t5', 'completed', 'a5')])
    await vi.advanceTimersByTimeAsync(500)
    expect(on.speaks()).toEqual(segments)
    on.session.set('s3')
    on.controller.observeTranscript([assistant('a6', '另一个。')], [turn('t6', 'completed', 'a6')])
    await vi.advanceTimersByTimeAsync(500)
    expect(on.speaks()).toEqual(segments)
  })

  it('does not read history that follows an empty view in the same epoch', async () => {
    const { controller, speaks } = setup({
      status: ready({ settings: settings({ reading: { autoRead: true } }) }),
    })
    await flush()
    controller.observeTranscript([], [])
    controller.observeTranscript([assistant('a1', REPLY)], [turn('t1', 'completed', 'a1')])
    await vi.advanceTimersByTimeAsync(500)
    expect(speaks()).toEqual([])
  })

  it('auto-reads in one tab only', async () => {
    const [left, right] = pair()
    const autoRead = ready({ settings: settings({ reading: { autoRead: true } }) })
    const a = setup({ channel: left, tabId: 'tab-a', status: autoRead })
    const b = setup({ channel: right, tabId: 'tab-b', status: autoRead })
    await flush()
    for (const tab of [a, b]) {
      tab.controller.observeTranscript([], [turn('t1', 'running')])
      tab.controller.observeTranscript([assistant('a1', REPLY)], [turn('t1', 'completed', 'a1')])
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(a.speaks().length).toBeGreaterThan(0)
    expect(b.speaks()).toEqual([])
  })

  it('shows click-to-play when autoplay is blocked', async () => {
    const { controller, snapshot, audios } = setup({ block: true })
    await flush()
    controller.toggleReading('a1', REPLY)
    await flush()
    expect(snapshot().reading).toMatchObject({ nodeId: 'a1', phase: 'blocked' })
    controller.resumePlayback()
    await flush()
    expect(snapshot().reading.phase).toBe('playing')
    expect(audios[0]?.plays).toBe(2)
  })

  it('stops when another tab starts playing', async () => {
    const [left, right] = pair()
    const a = setup({ channel: left, tabId: 'tab-a' })
    const b = setup({ channel: right, tabId: 'tab-b' })
    await flush()
    a.controller.toggleReading('a1', REPLY)
    await flush()
    expect(a.snapshot().reading.phase).toBe('playing')
    b.controller.toggleReading('b1', REPLY)
    await flush()
    expect(a.snapshot().reading.phase).toBe('idle')
    expect(b.snapshot().reading.phase).toBe('playing')
  })
})

describe('voice conversation in the controller', () => {
  // Calibration (6 quiet frames), speech (10 loud frames), then the 1.2 s pause (24 frames).
  const utterance = [...Array(6).fill(0.001), ...Array(10).fill(0.3), ...Array(60).fill(0.001)]

  it('keeps the conversation when its own first round opens the session', async () => {
    const { controller, composer, session, snapshot } = setup({
      session: null,
      media: fakeMedia({ levels: utterance, samples: noise(2) }).media,
      texts: ['你好'],
    })
    composer.ensureSession.mockImplementation(async () => {
      session.set('s-new')
      return 's-new'
    })
    await flush()
    controller.toggleConversation()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(composer.insertText).toHaveBeenCalledWith('你好')
    expect(composer.submit).toHaveBeenCalledTimes(1)
    expect(snapshot().conversation.phase).toBe('thinking')
    controller.observeTranscript([], [turn('t1', 'running')])
    controller.observeTranscript([assistant('a1', REPLY)], [turn('t1', 'completed', 'a1')])
    await flush()
    expect(snapshot().conversation.phase).toBe('reading')
    // A switch to another session ends it.
    session.set('s-other')
    expect(snapshot().conversation.phase).toBe('idle')
  })

  it('leaves the conversation on Escape and interrupts reading with the mic', async () => {
    const { controller, snapshot } = setup({
      media: fakeMedia({ levels: utterance, samples: noise(2) }).media,
      texts: ['讲个笑话'],
    })
    await flush()
    controller.toggleConversation()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(snapshot().conversation.phase).toBe('thinking')
    // The mic does nothing while the agent thinks.
    controller.toggleDictation()
    expect(snapshot().dictation.phase).toBe('idle')
    controller.observeTranscript([], [turn('t1', 'running')])
    controller.observeTranscript([assistant('a1', REPLY)], [turn('t1', 'completed', 'a1')])
    await flush()
    expect(snapshot().conversation.phase).toBe('reading')
    controller.toggleDictation()
    await flush()
    expect(snapshot().conversation.phase).toBe('listening')
    // An older reply's read button stays quiet while the microphone is open.
    controller.toggleReading('a0', '旧的回答。')
    await flush()
    expect(snapshot().reading.phase).toBe('idle')
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(snapshot().conversation.phase).toBe('idle')
  })

  it('drops the silence before the speech in a conversation', async () => {
    const quietFirst = [...Array(40).fill(0.001), ...Array(10).fill(0.3), ...Array(60).fill(0.001)]
    const { controller, call } = setup({
      media: fakeMedia({ levels: quietFirst, samples: noise(5) }).media,
      transcribe: () => new Promise(() => {}),
    })
    await flush()
    controller.toggleConversation()
    await vi.advanceTimersByTimeAsync(5_000)
    const transcribe = call.mock.calls.find(([method]) => method === '_agnes/v1/session.voice.transcribe')
    // The onset ends at frame 44 (2.2 s): keep from its 200 ms start plus 300 ms before it.
    const kept = 5 - (2.2 - 0.2 - 0.3)
    expect((transcribe?.[1] as { audio: string } | undefined)?.audio.length).toBe(
      Math.ceil((44 + 2 * Math.round(kept * 16_000)) / 3) * 4,
    )
  })
})

describe('voice copy', () => {
  it('pairs every English and Chinese string and covers each reason and notice', () => {
    const en = Object.keys(voiceLocaleCatalog.en).sort()
    expect(en).toEqual(Object.keys(voiceLocaleCatalog['zh-CN']).sort())
    for (const dictionary of Object.values(voiceLocaleCatalog))
      for (const value of Object.values(dictionary)) expect(value.trim()).not.toBe('')
    const reasons: VoiceUnavailable[] = [
      'no-account',
      'credential-missing',
      'ambiguous',
      'no-model',
      'insecure-context',
      'other-tab',
      'offline',
    ]
    const notices = ['empty', 'turn-ended', 'failed', 'mic-denied', 'session-failed']
    for (const key of [
      ...reasons.map((r) => `voice.reason.${r}`),
      ...notices.map((n) => `voice.notice.${n}`),
    ])
      expect(en).toContain(key)
    expect(Object.values(voiceLocaleCatalog.en).join(' ')).not.toMatch(/Preset|Bundle|FDE/)
    expect(voiceLocaleCatalog['zh-CN']['voice.reason.no-model']).toBe('语音账户没有识别（朗读）模型')
    expect(voiceLocaleCatalog['zh-CN']['voice.configure']).toBe('去配置')
  })
})
