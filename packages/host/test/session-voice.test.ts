import { JEV_WIRE_API, MAX_SPEECH_BYTES, OPENAI_AUDIO_WIRE_API } from '@agnes/ai'
import type { Event } from '@agnes/core'
import { redactRequest } from '@agnes/host-infrastructure/request-traces'
import {
  type ConfigAccount,
  DEFAULT_VOICE_SETTINGS,
  type InferenceEvent,
  type ModelRecord,
  type RequestBody,
  VOICE_SPEECH_MAX_BASE64,
  VOICE_TRANSCRIPT_MAX_CHARS,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import {
  chooseVoiceAccount,
  VoiceError,
  voiceRpcError,
  voiceSpeak,
  voiceStatus,
  voiceTranscribe,
  wavInfo,
} from '../src/runtime/sessions/session-voice.js'

const SENSE = 'FunAudioLLM/SenseVoiceSmall'
const COSY = 'FunAudioLLM/CosyVoice2-0.5B'

const account = (route: string, label: string, models: ConfigAccount['models']): ConfigAccount => ({
  accountId: route.replace(/^account-/, ''),
  label,
  providerId: OPENAI_AUDIO_WIRE_API,
  route,
  baseUrl: 'https://api.example.test/v1',
  model: models[0]?.id ?? SENSE,
  models,
  enabled: true,
  credentialConfigured: true,
})
const A = account('account-a', 'SiliconFlow', [
  { id: SENSE, name: SENSE, audioRole: 'transcribe' },
  { id: COSY, name: COSY, audioRole: 'speech' },
])
const B = account('account-b', 'OpenAI', [{ id: 'whisper-1', name: 'whisper-1', audioRole: 'transcribe' }])
const JEV: ConfigAccount = {
  ...account('jev', 'Jev', [{ id: 'jev', name: 'jev' }]),
  providerId: JEV_WIRE_API,
}

const record = (route: string, id: string, api: string, audioRole?: 'transcribe' | 'speech') =>
  ({
    route,
    id,
    api,
    contract_id: null,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(audioRole ? { audioRole } : {}),
  }) as unknown as ModelRecord
const MODELS = [
  record('account-a', SENSE, OPENAI_AUDIO_WIRE_API, 'transcribe'),
  record('account-a', COSY, OPENAI_AUDIO_WIRE_API, 'speech'),
  record('chat', 'gpt', 'openai-responses'),
  record('jev', 'jev', JEV_WIRE_API),
  record('account-c', 'plain', OPENAI_AUDIO_WIRE_API),
]

/** A WAV of `seconds` of silence: 16 kHz mono 16-bit unless told otherwise. */
function wav(seconds: number, o: { sampleRate?: number; channels?: number; bits?: number } = {}): string {
  const sampleRate = o.sampleRate ?? 16_000
  const channels = o.channels ?? 1
  const bits = o.bits ?? 16
  const byteRate = (sampleRate * channels * bits) / 8
  const data = Math.round(seconds * byteRate)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(byteRate, 28)
  head.writeUInt16LE((channels * bits) / 8, 32)
  head.writeUInt16LE(bits, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data, 40)
  return Buffer.concat([head, Buffer.alloc(data)]).toString('base64')
}
const wav16k = (seconds: number) => wav(seconds)

const delta = (text: string): InferenceEvent => ({ type: 'text_delta', delta: text })
const usage = (tokens: { input: number }): InferenceEvent => ({
  type: 'usage',
  tokens: { input: tokens.input, output: 0, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
})
const done = (): InferenceEvent => ({ type: 'done', reason: 'stop' })

function fixture(
  o: {
    events?: InferenceEvent[]
    infer?: () => AsyncGenerator<InferenceEvent>
    cap?: number | null
    credits?: (tokensEstimate: number) => number
    closed?: boolean
    turns?: boolean
    treeBudgetCredits?: number | null
  } = {},
) {
  const rows: Event[] = (o.turns === false
    ? []
    : [{ seq: 1, lane: 'main', type: 'turn/start', data: { turn: 1 } }]) as unknown as Event[]
  const infer = vi.fn(
    (_request: RequestBody) =>
      o.infer?.() ??
      (async function* () {
        for (const event of o.events ?? []) yield event
      })(),
  )
  const billingProjected = vi.fn(async (q: { tokensEstimate: number; model: string }) => ({
    credits: o.credits?.(q.tokensEstimate) ?? 0,
  }))
  const billingRecord = vi.fn(async () => true)
  const session = {
    key: 'synthetic',
    lane: 'main',
    closingOrClosed: o.closed ?? false,
    get lastSeq() {
      return rows.at(-1)?.seq ?? 0
    },
    preset: {
      model: { route: { primary: 'chat' }, id: { primary: 'gpt' } },
      budget: { perRequestCap: o.cap ?? null },
      treeBudgetCredits: o.treeBudgetCredits ?? null,
    },
    scan: async (q: { type?: string | string[]; order?: string; limit?: number }) => {
      const hit = rows.filter((r) => [q.type].flat().includes(r.type))
      return (q.order === 'desc' ? hit.reverse() : hit).slice(0, q.limit)
    },
    locked: async (fn: () => Promise<unknown>) => fn(),
    ev: (type: string, data: unknown) => ({ type, data }),
    append: async (events: Array<{ type: string; data: unknown }>) => {
      const firstSeq = rows.length + 1
      for (const e of events) rows.push({ seq: rows.length + 1, lane: 'main', ...e } as Event)
      return { firstSeq }
    },
    d: {
      log: { storage: {} },
      provider: { models: () => MODELS, infer },
      runtime: { billingProjected, billingRecord },
    },
  } as unknown as HostSession
  return { session, rows, infer, billingProjected, billingRecord }
}
const costRows = (rows: Event[]) => rows.filter((r) => r.type === 'cost/ledger')

afterEach(() => {
  vi.useRealTimers()
})

it('ties the speech byte cap of the adapter to the base64 cap of the protocol', () => {
  expect(Math.ceil(MAX_SPEECH_BYTES / 3) * 4).toBe(VOICE_SPEECH_MAX_BASE64)
})

it.each([
  [
    [A],
    '',
    {
      state: 'available',
      account: { route: 'account-a', label: 'SiliconFlow', transcribe: SENSE, speech: COSY },
    },
  ],
  [[A, B], '', { state: 'ambiguous' }],
  [[A, B], 'account-b', { state: 'available', account: expect.objectContaining({ route: 'account-b' }) }],
  [[A], 'account-x', { state: 'unconfigured' }],
  [[], '', { state: 'unconfigured' }],
  [
    [{ ...A, credentialConfigured: false }],
    '',
    { state: 'credential-missing', account: expect.objectContaining({ route: 'account-a' }) },
  ],
  [[JEV], '', { state: 'unconfigured' }],
  [[JEV], 'jev', { state: 'unconfigured' }],
  [[{ ...A, enabled: false }], '', { state: 'unconfigured' }],
  [
    [{ ...A, enabled: false }, B],
    '',
    { state: 'available', account: expect.objectContaining({ route: 'account-b' }) },
  ],
] as const)('chooses a voice account from %j with %s', (accounts, selected, expected) =>
  expect(chooseVoiceAccount(accounts as readonly ConfigAccount[], selected)).toEqual(expected),
)

it('reports each feature by audioRole', () => {
  const settings = structuredClone(DEFAULT_VOICE_SETTINGS)
  const only = { ...A, models: [{ id: SENSE, name: SENSE, audioRole: 'transcribe' as const }] }
  expect(voiceStatus({ accounts: [only], settings })).toEqual({
    transcribe: 'available',
    speech: 'no-model',
    account: { route: 'account-a', label: 'SiliconFlow' },
    settings: DEFAULT_VOICE_SETTINGS,
  })
  expect(voiceStatus({ accounts: [A], settings })).toMatchObject({
    transcribe: 'available',
    speech: 'available',
  })
  expect(voiceStatus({ accounts: [], settings })).toEqual({
    transcribe: 'unconfigured',
    speech: 'unconfigured',
    reason: 'no-account',
    settings,
  })
  expect(voiceStatus({ accounts: [A, B], settings })).toEqual({
    transcribe: 'ambiguous',
    speech: 'ambiguous',
    reason: 'ambiguous',
    settings,
  })
  expect(voiceStatus({ accounts: [{ ...A, credentialConfigured: false }], settings })).toEqual({
    transcribe: 'credential-missing',
    speech: 'credential-missing',
    reason: 'credential-missing',
    account: { route: 'account-a', label: 'SiliconFlow' },
    settings,
  })
})

it('reads the format and length of a recording', () => {
  expect(wavInfo(wav16k(2.4))).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, seconds: 2.4 })
  expect(wavInfo('not a wav')).toBeUndefined()
})

it('transcribes through the voice route and records one voice.transcribe cost row in seconds', async () => {
  const { session, rows, infer, billingRecord, billingProjected } = fixture({
    events: [delta('你好'), usage({ input: 3 }), done()],
  })
  const audio = wav16k(2.4)
  await expect(voiceTranscribe(session, { audio }, { route: 'account-a' })).resolves.toEqual({ text: '你好' })
  expect(infer.mock.calls[0]?.[0]).toMatchObject({
    route: 'account-a',
    model: SENSE,
    messages: [],
    tools: [],
    system: '',
    payload: { op: 'transcribe', audio: { type: 'audio', data: audio, mimeType: 'audio/wav' } },
    timeoutMs: { firstToken: 30_000, total: 30_000 },
  })
  expect(infer.mock.calls[0]?.[0].payload).not.toHaveProperty('language')
  expect(billingProjected).toHaveBeenCalledWith({ tokensEstimate: 3, model: SENSE })
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).toMatchObject({
    purpose: 'side-call',
    sourceTurn: 1,
    route: 'account-a',
    model: SENSE,
    effectId: expect.stringMatching(/^voice\.transcribe:/),
    tokens: { input: 3, output: 0 },
  })
  expect(rows.at(-1)?.data).not.toHaveProperty('interrupted')
  expect(rows.some((r) => r.type.endsWith('/message'))).toBe(false)
  expect(billingRecord).toHaveBeenCalledOnce()
})

it('passes the language and never lets the recording reach a request trace', async () => {
  const { session, infer } = fixture({ events: [delta('hi'), usage({ input: 3 }), done()] })
  const audio = wav16k(2.4)
  await voiceTranscribe(session, { audio, language: 'zh' }, { route: 'account-a' })
  const sent = infer.mock.calls[0]?.[0] as RequestBody
  expect(sent.payload).toMatchObject({ language: 'zh' })
  const traced = redactRequest(sent)
  expect(traced).toMatchObject({ payload: { audio: { data: '[OMITTED:binary]' } } })
  expect(JSON.stringify(traced)).not.toContain(audio.slice(0, 200))
})

it('keeps an empty transcript', async () => {
  const { session, rows } = fixture({ events: [usage({ input: 3 }), done()] })
  await expect(voiceTranscribe(session, { audio: wav16k(2.4) }, { route: 'account-a' })).resolves.toEqual({
    text: '',
  })
  expect(costRows(rows)).toHaveLength(1)
})

it('speaks with voice and speed and returns base64 mp3 billed in bytes', async () => {
  const { session, rows, infer, billingProjected } = fixture({
    events: [delta('AQID'), usage({ input: 6 }), done()],
  })
  await expect(
    voiceSpeak(session, { text: '你好', voice: 'anna', speed: 1.2 }, { route: 'account-a' }),
  ).resolves.toEqual({ audio: 'AQID', mimeType: 'audio/mpeg' })
  expect(infer.mock.calls[0]?.[0]).toMatchObject({
    model: COSY,
    payload: { op: 'speech', text: '你好', voice: 'anna', speed: 1.2 },
  })
  expect(billingProjected).toHaveBeenCalledWith({ tokensEstimate: 6, model: COSY })
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).toMatchObject({
    effectId: expect.stringMatching(/^voice\.speak:/),
    tokens: { input: 6 },
  })
})

it('refuses speech outside 1 to 120 UTF-16 units before calling the provider', async () => {
  const { session, rows, infer } = fixture({ events: [delta('AQID'), done()] })
  for (const text of ['', 'a'.repeat(121), '😀'.repeat(61)])
    await expect(voiceSpeak(session, { text }, { route: 'account-a' })).rejects.toMatchObject({
      code: 'too-large',
    })
  await expect(voiceSpeak(session, { text: 'a'.repeat(120) }, { route: 'account-a' })).resolves.toMatchObject(
    {
      audio: 'AQID',
    },
  )
  expect(infer).toHaveBeenCalledOnce()
  expect(costRows(rows)).toHaveLength(1)
})

it('refuses empty speech audio as a provider failure after recording the row', async () => {
  const { session, rows } = fixture({ events: [usage({ input: 2 }), done()] })
  await expect(voiceSpeak(session, { text: 'hi' }, { route: 'account-a' })).rejects.toMatchObject({
    code: 'provider',
    detail: { providerCode: 'FORMAT' },
  })
  expect(costRows(rows)).toHaveLength(1)
})

it('refuses a transcript over the cap instead of cutting it', async () => {
  const { session, rows } = fixture({
    events: [delta('x'.repeat(VOICE_TRANSCRIPT_MAX_CHARS + 1)), usage({ input: 3 }), done()],
  })
  await expect(
    voiceTranscribe(session, { audio: wav16k(2.4) }, { route: 'account-a' }),
  ).rejects.toMatchObject({
    code: 'provider',
    detail: { providerCode: 'FORMAT', retryable: false },
  })
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).toMatchObject({ interrupted: true })
})

it('refuses a chat route, a Jev route and a route without the role before calling the provider', async () => {
  const { session, rows, infer } = fixture({ events: [delta('x'), done()] })
  const before = rows.length
  for (const route of ['chat', 'jev', 'account-c', 'account-x']) {
    await expect(voiceTranscribe(session, { audio: wav16k(1) }, { route })).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(voiceSpeak(session, { text: 'hi' }, { route })).rejects.toMatchObject({
      code: 'unavailable',
    })
  }
  await expect(voiceTranscribe(session, { audio: wav16k(1) }, { route: 'account-a' })).resolves.toBeDefined()
  expect(infer).toHaveBeenCalledOnce()
  expect(rows.length).toBe(before + 1)
})

it('refuses a closed session before calling the provider', async () => {
  const { session, infer } = fixture({ closed: true, events: [done()] })
  await expect(voiceTranscribe(session, { audio: wav16k(1) }, { route: 'account-a' })).rejects.toBeInstanceOf(
    VoiceError,
  )
  await expect(voiceSpeak(session, { text: 'hi' }, { route: 'account-a' })).rejects.toMatchObject({
    code: 'unavailable',
  })
  expect(infer).not.toHaveBeenCalled()
})

it('refuses oversized or non-16 kHz mono audio before calling the provider', async () => {
  const { session, rows, infer } = fixture({ events: [done()] })
  const before = rows.length
  const cases = [
    ['A'.repeat(900_001), 'too-large'],
    [wav(1, { sampleRate: 44_100 }), 'invalid-audio'],
    [wav(1, { channels: 2 }), 'invalid-audio'],
    [wav(1, { bits: 8 }), 'invalid-audio'],
    ['A'.repeat(64), 'invalid-audio'],
    [wav16k(20.6), 'too-large'],
  ] as const
  for (const [audio, code] of cases)
    await expect(voiceTranscribe(session, { audio }, { route: 'account-a' })).rejects.toMatchObject({ code })
  expect(infer).not.toHaveBeenCalled()
  expect(rows.length).toBe(before)
  // The slack over the 20 s segment is tolerated.
  await expect(
    voiceTranscribe(session, { audio: wav16k(20.5) }, { route: 'account-a' }),
  ).resolves.toBeDefined()
})

it('refuses over the per-request cap in units, never request bytes', async () => {
  const { session, rows, infer } = fixture({
    cap: 0.002,
    credits: (tokens) => tokens * 0.001,
    events: [usage({ input: 2 }), done()],
  })
  const before = rows.length
  await expect(
    voiceTranscribe(session, { audio: wav16k(2.4) }, { route: 'account-a' }),
  ).rejects.toMatchObject({
    code: 'budget',
  })
  expect(infer).not.toHaveBeenCalled()
  expect(rows.length).toBe(before)
  // Two units fit: the request bytes (thousands) would not.
  await expect(
    voiceTranscribe(session, { audio: wav16k(1.5) }, { route: 'account-a' }),
  ).resolves.toBeDefined()
})

it('runs outside the tree budget on a chat that has no turn yet', async () => {
  const { session, rows } = fixture({
    turns: false,
    treeBudgetCredits: 5,
    events: [delta('hi'), usage({ input: 1 }), done()],
  })
  await expect(voiceTranscribe(session, { audio: wav16k(1) }, { route: 'account-a' })).resolves.toEqual({
    text: 'hi',
  })
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).not.toHaveProperty('sourceTurn')
})

it('maps a rate-limited adapter to a provider failure and still records the row', async () => {
  const { session, rows } = fixture({
    events: [
      {
        type: 'error',
        reason: 'error',
        code: 'RATE_LIMIT',
        message: 'openai-audio RATE_LIMIT (HTTP 429)',
        retryable: true,
        retryAfterMs: 3000,
      },
    ],
  })
  const failure = await voiceTranscribe(session, { audio: wav16k(2.4) }, { route: 'account-a' }).catch(
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(VoiceError)
  expect(failure).toMatchObject({
    code: 'provider',
    detail: { providerCode: 'RATE_LIMIT', retryable: true, retryAfterMs: 3000 },
  })
  expect(String((failure as Error).message)).not.toContain('HTTP')
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).toMatchObject({ interrupted: true, tokens: { input: 3 } })
})

it('maps an adapter timeout to the voice timeout', async () => {
  const { session } = fixture({
    events: [{ type: 'error', reason: 'error', code: 'TIMEOUT', message: 'timeout', retryable: true }],
  })
  await expect(voiceSpeak(session, { text: 'hi' }, { route: 'account-a' })).rejects.toMatchObject({
    code: 'timeout',
  })
})

it('times out after 30 s and records an interrupted row once the provider was called', async () => {
  vi.useFakeTimers()
  const { session, rows, infer } = fixture({
    infer: async function* () {
      await new Promise(() => undefined)
      yield done()
    },
  })
  const pending = voiceTranscribe(session, { audio: wav16k(2.4) }, { route: 'account-a' })
  const settled = pending.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(costRows(rows)).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(await settled).toMatchObject({ code: 'timeout' })
  expect(infer).toHaveBeenCalledOnce()
  expect(costRows(rows)).toHaveLength(1)
  expect(rows.at(-1)?.data).toMatchObject({ interrupted: true, tokens: { input: 3, output: 0 } })
})

it('stops when the caller aborts', async () => {
  const { session, rows } = fixture({
    infer: async function* () {
      await new Promise(() => undefined)
      yield done()
    },
  })
  const controller = new AbortController()
  const pending = voiceSpeak(session, { text: 'hi' }, { route: 'account-a', signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  expect(costRows(rows)).toHaveLength(1)
})

it.each([
  ['unavailable', 'SEMANTIC_REJECTED', 'VOICE_UNAVAILABLE'],
  ['too-large', 'INVALID_PARAMS', 'VOICE_TOO_LARGE'],
  ['invalid-audio', 'INVALID_PARAMS', 'VOICE_AUDIO_FORMAT'],
  ['budget', 'SEMANTIC_REJECTED', 'BUDGET'],
  ['timeout', 'REQUEST_TIMEOUT', 'voice'],
  ['provider', 'SEMANTIC_REJECTED', 'VOICE_PROVIDER'],
] as const)('voiceRpcError maps %s to %s', (code, name, reason) => {
  expect(voiceRpcError(new VoiceError(code, 'refused'))).toMatchObject({
    message: name,
    data: { reason },
  })
})

it('carries the provider code and retry hint, and passes other errors through', () => {
  expect(
    voiceRpcError(
      new VoiceError('provider', 'refused', {
        providerCode: 'RATE_LIMIT',
        retryable: true,
        retryAfterMs: 3000,
      }),
    ),
  ).toMatchObject({
    data: { reason: 'VOICE_PROVIDER', code: 'RATE_LIMIT', retryable: true, retryAfterMs: 3000 },
  })
  const plain = voiceRpcError(
    new VoiceError('provider', 'refused', { providerCode: 'FORMAT', retryable: false }),
  )
  expect((plain as { data: object }).data).not.toHaveProperty('retryAfterMs')
  const other = new Error('boom')
  expect(voiceRpcError(other)).toBe(other)
})
