import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_AUDIO_WIRE_API } from '@agnes/ai'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { VoiceError, VoiceSettingsStore, voiceSettingsRevision } from '@agnes/host'
import {
  type ConfigAccount,
  DEFAULT_VOICE_SETTINGS,
  rpcError,
  VOICE_CALL_TIMEOUT_MS,
  type VoiceSettings,
} from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transcribe = vi.hoisted(() => vi.fn())
const speak = vi.hoisted(() => vi.fn())
vi.mock('@agnes/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/host')>()),
  voiceTranscribe: transcribe,
  voiceSpeak: speak,
}))
const { registerVoice, VOICE_LIMITS } = await import('../src/local/methods/session-voice.js')

const WAV = 'UklGR'.padEnd(64, 'A')
const account = (route: string, label: string): ConfigAccount => ({
  accountId: route.replace(/^account-/, ''),
  label,
  providerId: OPENAI_AUDIO_WIRE_API,
  route,
  baseUrl: 'https://api.example.test/v1',
  model: 'stt',
  models: [
    { id: 'stt', name: 'stt', audioRole: 'transcribe' },
    { id: 'tts', name: 'tts', audioRole: 'speech' },
  ],
  enabled: true,
  credentialConfigured: true,
})
const A = account('account-a', 'SiliconFlow')
const B = account('account-b', 'OpenAI')
const defaults = (): VoiceSettings => structuredClone(DEFAULT_VOICE_SETTINGS)
const snapshot = (settings: VoiceSettings) => ({ settings, revision: voiceSettingsRevision(settings) })

type Handler = (params: unknown, c: CallContext) => Promise<unknown>
const session = { name: 'mine' }
const other = { name: 'other' }

function setup(
  o: {
    accounts?: ConfigAccount[]
    settings?: VoiceSettings
    store?: { read(): Promise<never>; save(): Promise<never> } | VoiceSettingsStore
    sessions?: Record<string, object>
    clock?: () => number
    configured?: boolean
    configuration?: { get(): Promise<never> }
  } = {},
) {
  const handlers = new Map<string, Handler>()
  const ep = { register: (name: string, fn: Handler) => handlers.set(name, fn) }
  const owner = vi.fn((_m: string, id: string, _c: CallContext) => {
    if (id === 'foreign') throw rpcError('CAPABILITY_DENIED', {})
  })
  const sessions: Record<string, object> = { mine: session, other, foreign: {}, ...o.sessions }
  const settings = o.store ?? {
    read: async () => snapshot(o.settings ?? defaults()),
    save: async () => snapshot(o.settings ?? defaults()),
  }
  const accounts = o.accounts ?? [A]
  registerVoice(ep as never, {
    registry: { get: (id) => (sessions[id] ? ({ session: sessions[id] } as never) : undefined) },
    requireOwner: owner,
    ...(o.configured === false
      ? {}
      : { configuration: o.configuration ?? { get: async () => ({ accounts }) as never } }),
    settings,
    ...(o.clock ? { clock: o.clock } : {}),
  })
  const connection = new AbortController()
  const context = (authKind = 'local'): CallContext =>
    ({
      conn: { authKind, credentialKind: authKind, principalId: 'me' },
      clock: Date.now,
      signal: connection.signal,
    }) as unknown as CallContext
  const call = (method: string, params: unknown, authKind?: string) => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler ${method}`)
    return handler(params, context(authKind))
  }
  return { call, owner, connection }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const TRANSCRIBE = '_agnes/v1/session.voice.transcribe'
const SPEAK = '_agnes/v1/session.voice.speak'

beforeEach(() => {
  transcribe.mockReset().mockResolvedValue({ text: 'ok' })
  speak.mockReset().mockResolvedValue({ audio: 'AAAA', mimeType: 'audio/mpeg' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('_agnes/v1/session.voice.*', () => {
  it('refuses a non-owner and an unknown session before calling the host', async () => {
    const { call, owner } = setup()
    for (const method of [TRANSCRIBE, SPEAK]) {
      const params = method === TRANSCRIBE ? { audio: WAV } : { text: 'hi' }
      await expect(call(method, { sessionId: 'foreign', ...params })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      await expect(call(method, { sessionId: 'gone', ...params })).rejects.toMatchObject({
        data: { code: 'SESSION_NOT_FOUND', sessionId: 'gone' },
      })
    }
    expect(owner.mock.calls.map(([m, id]) => [m, id])).toEqual([
      ['session.voice.transcribe', 'foreign'],
      ['session.voice.transcribe', 'gone'],
      ['session.voice.speak', 'foreign'],
      ['session.voice.speak', 'gone'],
    ])
    expect(transcribe).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })

  it('passes the chosen route and fills language, voice and speed from the settings', async () => {
    const settings = defaults()
    settings.input.language = 'zh'
    settings.reading.voice = 'anna'
    settings.reading.speed = 1.5
    const { call } = setup({ accounts: [A], settings })
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).resolves.toEqual({ text: 'ok' })
    expect(transcribe).toHaveBeenCalledWith(
      session,
      { audio: WAV, language: 'zh' },
      { route: 'account-a', signal: expect.any(AbortSignal) },
    )
    await call(SPEAK, { sessionId: 'mine', text: '你好' })
    expect(speak).toHaveBeenCalledWith(
      session,
      { text: '你好', voice: 'anna', speed: 1.5 },
      { route: 'account-a', signal: expect.any(AbortSignal) },
    )
    // A call's own values win; empty settings values leave the field out.
    await call(TRANSCRIBE, { sessionId: 'mine', audio: WAV, language: 'en' })
    expect(transcribe).toHaveBeenLastCalledWith(session, { audio: WAV, language: 'en' }, expect.anything())
    await call(SPEAK, { sessionId: 'mine', text: 'hi', voice: 'alex', speed: 2 })
    expect(speak).toHaveBeenLastCalledWith(
      session,
      { text: 'hi', voice: 'alex', speed: 2 },
      expect.anything(),
    )
    const plain = setup({ accounts: [A] })
    await plain.call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })
    expect(transcribe).toHaveBeenLastCalledWith(session, { audio: WAV }, expect.anything())
    await plain.call(SPEAK, { sessionId: 'mine', text: 'hi' })
    expect(speak).toHaveBeenLastCalledWith(session, { text: 'hi', speed: 1 }, expect.anything())
  })

  it('refuses when no voice account is usable without calling the host', async () => {
    const { call } = setup({ accounts: [A, B] })
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'VOICE_UNAVAILABLE', state: 'ambiguous' },
    })
    const missing = setup({ accounts: [{ ...A, credentialConfigured: false }] })
    await expect(missing.call(SPEAK, { sessionId: 'mine', text: 'hi' })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'VOICE_UNAVAILABLE', state: 'credential-missing' },
    })
    const none = setup({ configured: false })
    await expect(none.call(SPEAK, { sessionId: 'mine', text: 'hi' })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'VOICE_UNAVAILABLE', state: 'unconfigured' },
    })
    expect(transcribe).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })

  it('allows one transcription and two speeches per session at a time', async () => {
    const { call } = setup()
    const heard = deferred<{ text: string }>()
    const spoken = [deferred<unknown>(), deferred<unknown>()]
    transcribe.mockImplementationOnce(() => heard.promise)
    speak.mockImplementationOnce(() => spoken[0]?.promise).mockImplementationOnce(() => spoken[1]?.promise)
    const first = call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })
    const speeches = [
      call(SPEAK, { sessionId: 'mine', text: 'a' }),
      call(SPEAK, { sessionId: 'mine', text: 'b' }),
    ]
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2))
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).rejects.toMatchObject({
      data: { code: 'SESSION_BUSY', sessionId: 'mine', reason: 'voice.transcribe' },
    })
    await expect(call(SPEAK, { sessionId: 'mine', text: 'c' })).rejects.toMatchObject({
      data: { code: 'SESSION_BUSY', sessionId: 'mine', reason: 'voice.speak' },
    })
    await expect(call(TRANSCRIBE, { sessionId: 'other', audio: WAV })).resolves.toEqual({ text: 'ok' })
    await expect(call(SPEAK, { sessionId: 'other', text: 'c' })).resolves.toMatchObject({ audio: 'AAAA' })
    heard.resolve({ text: 'first' })
    spoken[0]?.resolve({ audio: 'BBBB', mimeType: 'audio/mpeg' })
    await expect(first).resolves.toEqual({ text: 'first' })
    await expect(speeches[0]).resolves.toMatchObject({ audio: 'BBBB' })
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).resolves.toEqual({ text: 'ok' })
    await expect(call(SPEAK, { sessionId: 'mine', text: 'd' })).resolves.toMatchObject({ audio: 'AAAA' })
    spoken[1]?.resolve({ audio: 'CCCC', mimeType: 'audio/mpeg' })
    await expect(speeches[1]).resolves.toMatchObject({ audio: 'CCCC' })
  })

  it('caps a session at 30 calls a minute', async () => {
    let now = 1_000_000
    const { call } = setup({ clock: () => now })
    expect(VOICE_LIMITS.perMinute).toBe(30)
    for (let i = 0; i < VOICE_LIMITS.perMinute; i++)
      await (i % 2 === 0
        ? call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })
        : call(SPEAK, { sessionId: 'mine', text: 'a' }))
    await expect(call(SPEAK, { sessionId: 'mine', text: 'a' })).rejects.toMatchObject({
      data: { code: 'OVERLOADED', reason: 'VOICE_RATE', retryAfterMs: 60_000 },
    })
    now += 20_000
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).rejects.toMatchObject({
      data: { code: 'OVERLOADED', reason: 'VOICE_RATE', retryAfterMs: 40_000 },
    })
    await expect(call(SPEAK, { sessionId: 'other', text: 'a' })).resolves.toMatchObject({ audio: 'AAAA' })
    now += 40_001
    await expect(call(SPEAK, { sessionId: 'mine', text: 'a' })).resolves.toMatchObject({ audio: 'AAAA' })
    expect(transcribe.mock.calls.length + speak.mock.calls.length).toBe(32)
  })

  it('forwards to the worker when the session is remote', async () => {
    const voice = vi.fn(async (method: string) =>
      method === 'voice.speak' ? { audio: 'DDDD' } : { text: 'w' },
    )
    const { call } = setup({ sessions: { remote: { voice } } })
    await expect(call(TRANSCRIBE, { sessionId: 'remote', audio: WAV })).resolves.toEqual({ text: 'w' })
    expect(voice).toHaveBeenCalledWith(
      'voice.transcribe',
      { audio: WAV, route: 'account-a' },
      expect.any(AbortSignal),
    )
    await expect(call(SPEAK, { sessionId: 'remote', text: 'hi' })).resolves.toEqual({ audio: 'DDDD' })
    expect(voice).toHaveBeenLastCalledWith(
      'voice.speak',
      { text: 'hi', speed: 1, route: 'account-a' },
      expect.any(AbortSignal),
    )
    expect(transcribe).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })

  it('aborts the host call after 30 s', async () => {
    vi.useFakeTimers()
    const { call, connection } = setup()
    const signals: AbortSignal[] = []
    const stopsOnAbort = (_s: unknown, _i: unknown, o: { signal: AbortSignal }) => {
      signals.push(o.signal)
      return new Promise((_r, reject) =>
        o.signal.addEventListener('abort', () => reject(new VoiceError('timeout', 'stopped'))),
      )
    }
    transcribe.mockImplementation(stopsOnAbort)
    const running = call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })
    void running.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(VOICE_CALL_TIMEOUT_MS - 1)
    expect(signals[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]?.aborted).toBe(true)
    await expect(running).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
    // The slot is free again; a closed connection stops the next call as well.
    const next = call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })
    void next.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[1]?.aborted).toBe(false)
    connection.abort()
    expect(signals[1]?.aborted).toBe(true)
    await expect(next).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps host failures through voiceRpcError', async () => {
    const { call } = setup()
    transcribe.mockRejectedValueOnce(new VoiceError('budget', 'over the request cap'))
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'BUDGET' },
    })
    speak.mockRejectedValueOnce(
      new VoiceError('provider', 'the voice provider failed', {
        providerCode: 'RATE_LIMIT',
        retryable: true,
        retryAfterMs: 5_000,
      }),
    )
    await expect(call(SPEAK, { sessionId: 'mine', text: 'a' })).rejects.toMatchObject({
      data: { code: 'RATE_LIMIT', reason: 'VOICE_PROVIDER', retryable: true, retryAfterMs: 5_000 },
    })
    // The limiter slots were released.
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).resolves.toEqual({ text: 'ok' })
  })

  it('answers voice.status without a session', async () => {
    const { call, owner } = setup({ accounts: [A] })
    await expect(call('_agnes/v1/voice.status', {})).resolves.toEqual({
      transcribe: 'available',
      speech: 'available',
      account: { route: 'account-a', label: 'SiliconFlow' },
      settings: DEFAULT_VOICE_SETTINGS,
    })
    await expect(setup({ configured: false }).call('_agnes/v1/voice.status', {})).resolves.toEqual({
      transcribe: 'unconfigured',
      speech: 'unconfigured',
      reason: 'no-account',
      settings: DEFAULT_VOICE_SETTINGS,
    })
    expect(owner).not.toHaveBeenCalled()
  })

  it('keeps voice settings local-only and compare-and-swap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-voice-rpc-'))
    try {
      const { call } = setup({ store: new VoiceSettingsStore(dir, 'local-dev') })
      for (const method of ['_agnes/v1/voice.settings.get', '_agnes/v1/voice.settings.save'])
        await expect(call(method, {}, 'jwt')).rejects.toMatchObject({
          data: { code: 'CAPABILITY_DENIED', method: 'voice.settings', reason: 'local configuration only' },
        })
      const first = (await call('_agnes/v1/voice.settings.get', {})) as { revision: string }
      expect(first).toEqual(snapshot(defaults()))
      const changed = defaults()
      changed.reading.autoRead = true
      const saved = await call('_agnes/v1/voice.settings.save', {
        settings: changed,
        expectedRevision: first.revision,
      })
      expect(saved).toEqual(snapshot(changed))
      await expect(call('_agnes/v1/voice.settings.get', {})).resolves.toEqual(saved)
      await expect(
        call('_agnes/v1/voice.settings.save', { settings: defaults(), expectedRevision: first.revision }),
      ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' } })
      const invalid = { ...changed, input: { ...changed.input, maxSeconds: 1 } }
      await expect(
        call('_agnes/v1/voice.settings.save', {
          settings: invalid,
          expectedRevision: voiceSettingsRevision(changed),
        }),
      ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_INVALID_INPUT' } })
      await expect(call('_agnes/v1/voice.settings.get', {})).resolves.toEqual(saved)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an unreadable settings file with a fixed error and no path', async () => {
    const denied = () =>
      Promise.reject(
        Object.assign(new Error("EACCES: permission denied, open '/secret/voice/abc.json'"), {
          code: 'EACCES',
          path: '/secret/voice/abc.json',
        }),
      ) as Promise<never>
    const { call } = setup({ store: { read: denied, save: denied } })
    const calls = [
      call('_agnes/v1/voice.status', {}),
      call('_agnes/v1/voice.settings.get', {}),
      call('_agnes/v1/voice.settings.save', {
        settings: defaults(),
        expectedRevision: voiceSettingsRevision(defaults()),
      }),
      call(TRANSCRIBE, { sessionId: 'mine', audio: WAV }),
      call(SPEAK, { sessionId: 'mine', text: 'a' }),
    ]
    for (const pending of calls) {
      const error = await pending.then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(error).toEqual(rpcError('INTERNAL_ERROR', { reason: 'VOICE_SETTINGS_UNAVAILABLE' }))
      expect(JSON.stringify(error)).not.toContain('secret')
    }
    expect(transcribe).not.toHaveBeenCalled()
    // The refused call released its slot: the next one fails the same way, not as busy.
    await expect(call(TRANSCRIBE, { sessionId: 'mine', audio: WAV })).rejects.toEqual(
      rpcError('INTERNAL_ERROR', { reason: 'VOICE_SETTINGS_UNAVAILABLE' }),
    )
    // An unreadable account list is reported the same way.
    const accounts = setup({ configuration: { get: denied } })
    for (const [method, params] of [
      ['_agnes/v1/voice.status', {}],
      [SPEAK, { sessionId: 'mine', text: 'a' }],
    ] as const)
      await expect(accounts.call(method, params)).rejects.toEqual(
        rpcError('INTERNAL_ERROR', { reason: 'VOICE_SETTINGS_UNAVAILABLE' }),
      )
    expect(speak).not.toHaveBeenCalled()
  })
})
