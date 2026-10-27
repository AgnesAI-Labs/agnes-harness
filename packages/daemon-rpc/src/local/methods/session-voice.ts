import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import {
  type ConfigurationService,
  chooseVoiceAccount,
  type HostSession,
  type VoiceSettingsStore,
  voiceRpcError,
  voiceSpeak,
  voiceStatus,
  voiceTranscribe,
} from '@agnes/host'
import {
  type ConfigAccount,
  rpcError,
  type SessionVoiceSpeakParams,
  type SessionVoiceTranscribeParams,
  VOICE_CALL_TIMEOUT_MS,
  type VoiceSettings,
  type VoiceSettingsSaveParams,
  type VoiceSettingsSnapshot,
  type VoiceStatusResult,
} from '@agnes/protocol'

/** Per session: voice calls in flight per operation, and admitted calls per window (both together). */
export const VOICE_LIMITS = { transcribe: 1, speak: 2, perMinute: 30, windowMs: 60_000 } as const

type VoiceOp = 'transcribe' | 'speak'
type VoiceMethod = 'voice.transcribe' | 'voice.speak'

/** A worker-hosted session is a wire proxy; it forwards the call to the worker that holds the session. */
type RemoteVoice = {
  voice?: (
    method: VoiceMethod,
    input: Readonly<Record<string, unknown>> & { route: string },
    signal: AbortSignal,
  ) => Promise<unknown>
}

/** Admission for voice calls: a refused call is neither queued nor counted against the rate. */
export class VoiceLimiter {
  private readonly sessions = new Map<string, { transcribe: number; speak: number; admitted: number[] }>()
  constructor(private readonly clock: () => number) {}

  /** Admits one call or throws `SESSION_BUSY` / `OVERLOADED`; the returned release frees its slot once. */
  admit(sessionId: string, op: VoiceOp): () => void {
    const now = this.clock()
    this.forget(now)
    const state = this.sessions.get(sessionId) ?? { transcribe: 0, speak: 0, admitted: [] }
    if (state[op] >= VOICE_LIMITS[op])
      throw rpcError('SESSION_BUSY', {
        sessionId,
        reason: op === 'speak' ? 'voice.speak' : 'voice.transcribe',
      })
    const oldest = state.admitted[0]
    if (oldest !== undefined && state.admitted.length >= VOICE_LIMITS.perMinute)
      throw rpcError('OVERLOADED', {
        reason: 'VOICE_RATE',
        retryAfterMs: oldest + VOICE_LIMITS.windowMs - now,
      })
    state[op]++
    state.admitted.push(now)
    this.sessions.set(sessionId, state)
    let released = false
    return () => {
      if (released) return
      released = true
      state[op]--
    }
  }

  /** Drops calls older than the window, and sessions with nothing left to track. */
  private forget(now: number): void {
    for (const [sessionId, state] of this.sessions) {
      while (state.admitted[0] !== undefined && state.admitted[0] <= now - VOICE_LIMITS.windowMs)
        state.admitted.shift()
      if (state.transcribe === 0 && state.speak === 0 && state.admitted.length === 0)
        this.sessions.delete(sessionId)
    }
  }
}

/** A settings or account read failed; the cause (an fs path, say) stays out of the reply. */
const settingsUnavailable = () => rpcError('INTERNAL_ERROR', { reason: 'VOICE_SETTINGS_UNAVAILABLE' })

/**
 * The voice methods: speech to text and text to speech for a session the caller owns, on the account
 * the voice settings choose, plus the session-free status and the local-only settings.
 */
export function registerVoice(
  ep: LocalEndpoint,
  deps: {
    registry: { get(sessionId: string): { session: HostSession } | undefined }
    requireOwner(method: string, sessionId: string, c: CallContext): void
    configuration?: Pick<ConfigurationService, 'get'>
    settings: Pick<VoiceSettingsStore, 'read' | 'save'>
    clock?: () => number
  },
): void {
  const limiter = new VoiceLimiter(deps.clock ?? Date.now)
  const context = async (): Promise<{ accounts: readonly ConfigAccount[]; settings: VoiceSettings }> => {
    try {
      const [{ settings }, configuration] = await Promise.all([
        deps.settings.read(),
        deps.configuration?.get(),
      ])
      return { accounts: configuration?.accounts ?? [], settings }
    } catch {
      throw settingsUnavailable()
    }
  }

  const call = async <I extends Readonly<Record<string, unknown>>>(
    method: VoiceMethod,
    sessionId: string,
    c: CallContext,
    input: (settings: VoiceSettings) => I,
    local: (
      session: HostSession,
      input: I,
      options: { route: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): Promise<unknown> => {
    deps.requireOwner(`session.${method}`, sessionId, c)
    const entry = deps.registry.get(sessionId)
    if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId })
    const release = limiter.admit(sessionId, method === 'voice.speak' ? 'speak' : 'transcribe')
    // A plain timer, so the deadline follows the clock tests control; cleared once the call settles.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), VOICE_CALL_TIMEOUT_MS)
    try {
      const { accounts, settings } = await context()
      const choice = chooseVoiceAccount(accounts, settings.account)
      if (choice.state !== 'available')
        throw rpcError('SEMANTIC_REJECTED', { reason: 'VOICE_UNAVAILABLE', state: choice.state })
      const { route } = choice.account
      const signal = AbortSignal.any([c.signal, deadline.signal])
      const values = input(settings)
      const remote = entry.session as unknown as RemoteVoice
      return remote.voice
        ? await remote.voice(method, { ...values, route }, signal)
        : await local(entry.session, values, { route, signal })
    } catch (error) {
      throw voiceRpcError(error)
    } finally {
      clearTimeout(timer)
      release()
    }
  }

  ep.register('_agnes/v1/session.voice.transcribe', async (params, c) => {
    const p = params as SessionVoiceTranscribeParams
    const input = (settings: VoiceSettings) => {
      const language = p.language ?? (settings.input.language || undefined)
      return { audio: p.audio, ...(language === undefined ? {} : { language }) }
    }
    return call('voice.transcribe', p.sessionId, c, input, voiceTranscribe)
  })
  ep.register('_agnes/v1/session.voice.speak', async (params, c) => {
    const p = params as SessionVoiceSpeakParams
    const input = (settings: VoiceSettings) => {
      const voice = p.voice ?? (settings.reading.voice || undefined)
      return {
        text: p.text,
        ...(voice === undefined ? {} : { voice }),
        speed: p.speed ?? settings.reading.speed,
      }
    }
    return call('voice.speak', p.sessionId, c, input, voiceSpeak)
  })
  ep.register('_agnes/v1/voice.status', async (): Promise<VoiceStatusResult> => voiceStatus(await context()))

  // The same guard as `config.*`: settings are local profile configuration.
  const local = (c: CallContext) => {
    if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { method: 'voice.settings', reason: 'local configuration only' })
  }
  const stored = async (action: () => Promise<VoiceSettingsSnapshot>): Promise<VoiceSettingsSnapshot> => {
    try {
      return await action()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'CONFIG_REVISION_CONFLICT' || code === 'CONFIG_INVALID_INPUT')
        throw rpcError('SEMANTIC_REJECTED', { reason: code })
      throw settingsUnavailable()
    }
  }
  ep.register('_agnes/v1/voice.settings.get', async (_params, c) => {
    local(c)
    return stored(() => deps.settings.read())
  })
  ep.register('_agnes/v1/voice.settings.save', async (params, c) => {
    local(c)
    const p = params as VoiceSettingsSaveParams
    return stored(() => deps.settings.save(p.settings, p.expectedRevision))
  })
}
