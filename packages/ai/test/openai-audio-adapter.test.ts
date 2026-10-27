import { createHash } from 'node:crypto'
import type { InferenceEvent, ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { readStepfunTranscript, stepfunAsrBody } from '../src/adapters/openai-audio/stepfun.js'
import {
  multipartBody,
  readAudioPayload,
  speechBody,
  speechVoice,
} from '../src/adapters/openai-audio/wire.js'
import type { AdapterStreamOptions, WireEvent } from '../src/index.js'
import {
  AiSetupError,
  createProvider,
  MAX_SPEECH_BYTES,
  NullContractStore,
  OPENAI_AUDIO_WIRE_API,
  OpenAiAudioAdapter,
  openAiAudioUnits,
  probeOpenAiAudioEndpoint,
  validateModelBaseUrl,
  wavHeader,
} from '../src/index.js'
import { fakeModel } from '../testkit/index.js'

// Every case runs against a scripted `fetch`, so nothing opens a socket.

const KEY = 'TEST-KEY-0123456789'
const SENTINEL = 'SENTINEL-BODY-TEXT'
const SENSE = 'FunAudioLLM/SenseVoiceSmall'
const COSY = 'FunAudioLLM/CosyVoice2-0.5B'
const BASE = 'https://audio.example.invalid/v1'
const NOW = Date.parse('2026-10-27T12:00:00Z')
const MODELS = [SENSE, COSY, 'gpt-4o-mini-tts', 'stepaudio-3-tts', 'stepaudio-3-asr-max']

type AudioRoute = RouteDecl & { models: ModelRecord[]; keyless?: boolean }
type Call = { url: string; init: RequestInit }
type Reply = Response | Error | ((call: Call) => Response | Promise<Response>)

const routeDecl = (over: Partial<AudioRoute> = {}): AudioRoute => ({
  route: 'audio',
  api: OPENAI_AUDIO_WIRE_API,
  baseUrl: BASE,
  credentialRef: 'secret://audio/key',
  models: MODELS.map((id) => fakeModel({ id, route: 'audio', api: OPENAI_AUDIO_WIRE_API, baseUrl: BASE })),
  ...over,
})

/** A 16 kHz mono 16-bit PCM WAV of `seconds`, as base64. */
function wav16k(seconds: number, over: { sampleRate?: number; channels?: number } = {}): string {
  const dataBytes = Math.round(seconds * 32_000)
  const { sampleRate = 16_000, channels = 1 } = over
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataBytes, 40)
  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < dataBytes; i += 1) body[i] = (i * 7) & 0xff
  return Buffer.concat([header, body]).toString('base64')
}
const transcribe = (data: string, language?: string) =>
  ({
    op: 'transcribe',
    audio: { type: 'audio', data, mimeType: 'audio/wav' },
    ...(language === undefined ? {} : { language }),
  }) as const

type RequestOver = { [K in keyof RequestBody]?: RequestBody[K] | undefined }
const request = (over: RequestOver = {}): RequestBody => {
  const { payload, ...rest } = {
    kind: 'inference',
    sessionKey: 'agnes:t:a:cli:dm:x',
    slot: 'primary',
    route: 'audio',
    model: SENSE,
    contractId: null,
    derivedHash: 'a'.repeat(64),
    system: '',
    messages: [],
    tools: [],
    payload: transcribe(wav16k(2.4)),
    ...over,
  }
  return (payload === undefined ? rest : { ...rest, payload }) as RequestBody
}

const options = (over: Partial<AdapterStreamOptions> = {}): AdapterStreamOptions => ({
  signal: new AbortController().signal,
  toolNames: [],
  sessionKey: 'agnes:t:a:cli:dm:x',
  timeoutMs: { firstToken: 5_000, total: 5_000 },
  ...over,
})

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const audio = (bytes: Uint8Array<ArrayBuffer>, type = 'audio/mpeg') =>
  new Response(bytes, { status: 200, headers: { 'content-type': type } })
const sse = (events: unknown[], status = 200) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
const failed = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: `quoted ${SENTINEL} ${KEY}` } }), { status, headers })

function harness(replies: Reply[] = [], over: { routes?: AudioRoute[] } = {}) {
  const calls: Call[] = []
  const closed: string[] = []
  const log: string[] = []
  const queue = [...replies]
  const network = (decl: RouteDecl) => ({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      log.push('fetch')
      const next = queue.shift() ?? json({ text: '' })
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(call) : next
    }) as typeof fetch,
    close: async () => {
      closed.push(decl.route)
    },
  })
  const adapter = new OpenAiAudioAdapter({ routes: over.routes ?? [routeDecl()], network, clock: () => NOW })
  adapter.bindCredential('audio', KEY)
  return { adapter, calls, closed, log, queue }
}

async function run(
  adapter: OpenAiAudioAdapter,
  req: RequestBody = request(),
  opts: Partial<AdapterStreamOptions> = {},
  route = 'audio',
): Promise<WireEvent[]> {
  const out: WireEvent[] = []
  for await (const event of adapter.stream(route, req, options(opts))) out.push(event)
  return out
}

const types = (events: ReadonlyArray<{ type: string }>) => events.map((e) => e.type)
const errorOf = (events: WireEvent[]) =>
  events.find((e) => e.type === 'error') as Extract<WireEvent, { type: 'error' }>
const usageOf = (events: WireEvent[]) =>
  events.find((e) => e.type === 'usage') as Extract<WireEvent, { type: 'usage' }>
const textOf = (events: ReadonlyArray<{ type: string; delta?: string }>) =>
  events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('')
const sentBody = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>
const headersOf = (call: Call | undefined) => call?.init.headers as Record<string, string>
const hanging: Reply = (call) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal as AbortSignal
    const stop = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })

/** The text fields of a multipart body and the filename of its file part. */
function multipartFields(call: Call | undefined): Record<string, string> {
  const text = Buffer.from(call?.init.body as Uint8Array).toString('latin1')
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/name="(\w+)"\r\n\r\n([^\r]*)\r\n/g)) out[m[1] as string] = m[2] as string
  const file = /name="file"; filename="([^"]*)"/.exec(text)
  if (file) out.file = file[1] as string
  return out
}

const setupError = (make: () => unknown): AiSetupError => {
  try {
    make()
  } catch (error) {
    expect(error).toBeInstanceOf(AiSetupError)
    return error as AiSetupError
  }
  throw new Error('expected the constructor to throw')
}

describe('transcription', () => {
  it('posts a transcription as multipart file+model to <base>/audio/transcriptions and returns the text', async () => {
    const { adapter, calls } = harness([json({ text: '你好' })])
    const events = await run(adapter, request())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://audio.example.invalid/v1/audio/transcriptions')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.redirect).toBe('error')
    expect(headersOf(calls[0]).authorization).toBe(`Bearer ${KEY}`)
    expect(String(headersOf(calls[0])['content-type'])).toMatch(/^multipart\/form-data; boundary=agnes-/)
    expect(multipartFields(calls[0])).toEqual({ model: SENSE, file: 'audio.wav' })
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(textOf(events)).toBe('你好')
    expect(usageOf(events).tokens).toEqual({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('sends the recording itself as the file part, byte for byte', async () => {
    const data = wav16k(0.5)
    const { adapter, calls } = harness([json({ text: 'x' })])
    await run(adapter, request({ payload: transcribe(data) }))
    const body = Buffer.from(calls[0]?.init.body as Uint8Array)
    expect(body.includes(Buffer.from(data, 'base64'))).toBe(true)
  })

  it('uses a new boundary for every call', async () => {
    const { adapter, calls } = harness([json({ text: 'a' }), json({ text: 'b' })])
    await run(adapter)
    await run(adapter)
    expect(headersOf(calls[0])['content-type']).not.toBe(headersOf(calls[1])['content-type'])
  })

  it('sends language only when the payload carries one', async () => {
    const { adapter, calls } = harness([json({ text: 'a' }), json({ text: 'b' })])
    await run(adapter, request({ payload: transcribe(wav16k(1), 'zh') }))
    await run(adapter, request({ payload: transcribe(wav16k(1)) }))
    expect(multipartFields(calls[0])).toEqual({ model: SENSE, language: 'zh', file: 'audio.wav' })
    expect(multipartFields(calls[1])).toEqual({ model: SENSE, file: 'audio.wav' })
  })

  it('accepts an empty transcript as a finished call', async () => {
    const { adapter } = harness([json({ text: '' })])
    const events = await run(adapter)
    expect(types(events)).toEqual(['usage', 'done'])
    expect(textOf(events)).toBe('')
  })

  it.each([
    ['text of another type', json({ text: 5 })],
    ['no text', json({})],
    ['a JSON array', json([])],
    ['a body that is not JSON', new Response('not json', { status: 200 })],
  ])('is FORMAT for %s', async (_name, response) => {
    const { adapter } = harness([response])
    const events = await run(adapter)
    expect(errorOf(events)).toMatchObject({ code: 'FORMAT', retryable: false })
    expect(types(events)).not.toContain('text_delta')
  })

  it('is FORMAT for a transcript over the cap', async () => {
    const { adapter } = harness([json({ text: 'x'.repeat(256 * 1024) })])
    expect(errorOf(await run(adapter))).toMatchObject({ code: 'FORMAT' })
  })
})

describe('the StepFun transcription', () => {
  const p = transcribe(wav16k(2.4))
  const stepfunRequest = (payload: NonNullable<RequestBody['payload']> = { ...p, language: 'zh' }) =>
    request({ model: 'stepaudio-3-asr-max', payload })

  it('posts transcription JSON to <base>/audio/asr/sse and returns the done text', async () => {
    const { adapter, calls } = harness([
      sse([
        { type: 'transcript.text.delta', delta: '你' },
        { type: 'transcript.text.done', text: '你好', usage: { input_tokens: 10, output_tokens: 2 } },
      ]),
    ])
    const events = await run(adapter, stepfunRequest())
    expect(calls[0]?.url).toBe('https://audio.example.invalid/v1/audio/asr/sse')
    expect(headersOf(calls[0]).accept).toBe('text/event-stream')
    expect(headersOf(calls[0])['content-type']).toBe('application/json')
    expect(sentBody(calls[0])).toEqual({
      audio: {
        data: p.audio.data,
        input: {
          transcription: { model: 'stepaudio-3-asr-max', language: 'zh', enable_itn: true },
          format: { type: 'wav' },
        },
      },
    })
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(textOf(events)).toBe('你好')
    // Audio seconds, not the vendor's token count.
    expect(usageOf(events).tokens.input).toBe(3)
  })

  it('leaves language out of the body when the payload has none', () => {
    const body = JSON.parse(stepfunAsrBody('stepaudio-3-asr-max', p)) as {
      audio: { input: { transcription: Record<string, unknown> } }
    }
    expect(body.audio.input.transcription).toEqual({ model: 'stepaudio-3-asr-max', enable_itn: true })
  })

  it('fails on an error event (not retryable) and on a stream with no done event (retryable)', async () => {
    const errored = harness([sse([{ type: 'error', message: `quoted ${SENTINEL}` }])])
    const first = await run(errored.adapter, stepfunRequest())
    expect(errorOf(first)).toMatchObject({ code: 'FORMAT', retryable: false })
    expect(JSON.stringify(first)).not.toContain(SENTINEL)
    const cut = harness([sse([{ type: 'transcript.text.delta', delta: '你' }])])
    expect(errorOf(await run(cut.adapter, stepfunRequest()))).toMatchObject({
      code: 'TRANSPORT',
      retryable: true,
    })
  })

  it('maps an HTTP error as the OpenAI path does', async () => {
    const { adapter } = harness([failed(401)])
    const events = await run(adapter, stepfunRequest())
    expect(types(events)).toEqual(['usage', 'error'])
    expect(errorOf(events)).toMatchObject({ code: 'AUTH', retryable: false })
  })

  it('stops at a stream over the cap', async () => {
    const big = new Response(
      `data: ${JSON.stringify({ type: 'transcript.text.done', text: 'x'.repeat(300_000) })}\n\n`,
    )
    const { adapter } = harness([big])
    expect(errorOf(await run(adapter, stepfunRequest()))).toMatchObject({ code: 'FORMAT', retryable: false })
  })
})

describe('readStepfunTranscript', () => {
  const streamOf = (chunks: Array<string | Uint8Array>) => {
    const text = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? text.encode(chunk) : chunk)
        controller.close()
      },
    })
  }
  const done = (text: string) => `data: ${JSON.stringify({ type: 'transcript.text.done', text })}\n\n`

  it('reads events split across chunks, CRLF line ends and multi-byte characters', async () => {
    const line = new TextEncoder().encode(done('你好世界'))
    const cut = line.indexOf(0xe4) + 1 // inside the first character
    const result = await readStepfunTranscript(streamOf([line.slice(0, cut), line.slice(cut)]), 1024)
    expect(result).toEqual({ ok: true, text: '你好世界' })
    expect(await readStepfunTranscript(streamOf([done('ok').replaceAll('\n', '\r\n')]), 1024)).toEqual({
      ok: true,
      text: 'ok',
    })
  })

  it('reads a final event that has no line end', async () => {
    const text = done('tail').trimEnd()
    expect(await readStepfunTranscript(streamOf([text]), 1024)).toEqual({ ok: true, text: 'tail' })
  })

  it('returns the first done event and ignores comments, [DONE] and other event types', async () => {
    const chunks = [
      ': keep-alive\n',
      'event: x\n',
      'data: [DONE]\n',
      'data: {"type":"other"}\n',
      done('first'),
      done('second'),
    ]
    expect(await readStepfunTranscript(streamOf(chunks), 1024)).toEqual({ ok: true, text: 'first' })
  })

  it.each([
    ['an error event', 'data: {"type":"error"}\n', false],
    ['a done event without text', 'data: {"type":"transcript.text.done"}\n', false],
    ['a data line that is not JSON', 'data: {oops\n', false],
    ['no done event', 'data: {"type":"transcript.text.delta","delta":"a"}\n', true],
    ['an empty stream', '', true],
  ])('fails on %s', async (_name, text, retryable) => {
    expect(await readStepfunTranscript(streamOf([text]), 1024)).toEqual({ ok: false, retryable })
  })

  it('fails without retry when the stream is over the cap', async () => {
    expect(await readStepfunTranscript(streamOf([done('x'.repeat(100))]), 50)).toEqual({
      ok: false,
      retryable: false,
    })
  })

  it('treats a broken connection as retryable', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('reset'))
      },
    })
    expect(await readStepfunTranscript(broken, 1024)).toEqual({ ok: false, retryable: true })
  })

  it('stops reading when the signal aborts', async () => {
    const controller = new AbortController()
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })
    const pending = readStepfunTranscript(never, 1024, controller.signal)
    controller.abort()
    expect(await pending).toEqual({ ok: false, retryable: true })
  })
})

describe('speech', () => {
  it('posts speech JSON, pins mp3, and returns the audio as base64 with byte units', async () => {
    const { adapter, calls } = harness([audio(new Uint8Array([1, 2, 3]))])
    const events = await run(
      adapter,
      request({ model: COSY, payload: { op: 'speech', text: 'hi', speed: 1.2 } }),
    )
    expect(calls[0]?.url).toBe('https://audio.example.invalid/v1/audio/speech')
    expect(headersOf(calls[0])['content-type']).toBe('application/json')
    expect(sentBody(calls[0])).toEqual({
      model: COSY,
      input: 'hi',
      voice: `${COSY}:anna`,
      response_format: 'mp3',
      speed: 1.2,
      stream: false,
      sample_rate: 32000,
    })
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(textOf(events)).toBe('AQID')
    expect(usageOf(events).tokens).toEqual({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('counts the UTF-8 bytes of the text as units', async () => {
    const { adapter } = harness([audio(new Uint8Array([1]))])
    const events = await run(adapter, request({ model: COSY, payload: { op: 'speech', text: '你好' } }))
    expect(usageOf(events).tokens.input).toBe(6)
  })

  it('omits speed when it is 1 or absent', async () => {
    const { adapter, calls } = harness([audio(new Uint8Array([1])), audio(new Uint8Array([1]))])
    await run(adapter, request({ model: COSY, payload: { op: 'speech', text: 'hi', speed: 1 } }))
    await run(adapter, request({ model: COSY, payload: { op: 'speech', text: 'hi' } }))
    expect(sentBody(calls[0])).not.toHaveProperty('speed')
    expect(sentBody(calls[1])).not.toHaveProperty('speed')
  })

  it('sends no stream or sample_rate for a non-namespaced model', async () => {
    const { adapter, calls } = harness([audio(new Uint8Array([1]))])
    await run(adapter, request({ model: 'gpt-4o-mini-tts', payload: { op: 'speech', text: 'hi' } }))
    expect(sentBody(calls[0])).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'hi',
      voice: 'alloy',
      response_format: 'mp3',
    })
  })

  it.each([
    [COSY, 'anna', `${COSY}:anna`],
    [COSY, 'x:y', 'x:y'],
    [COSY, '', `${COSY}:anna`],
    [COSY, undefined, `${COSY}:anna`],
    ['gpt-4o-mini-tts', '', 'alloy'],
    ['gpt-4o-mini-tts', 'verse', 'verse'],
    ['gpt-4o-mini-tts', 'a:b', 'a:b'],
  ])('speechVoice(%s, %s) is %s', (model, voice, expected) => {
    expect(speechVoice(model, voice)).toBe(expected)
  })

  it.each([
    ['stepaudio-3-tts', '', 'cixingnansheng'],
    ['step-tts-mini', undefined, 'cixingnansheng'],
    ['stepaudio-3-tts', 'wenrounansheng', 'wenrounansheng'],
  ])('speechVoice(%s, %s) is %s', (model, voice, expected) => {
    expect(speechVoice(model, voice)).toBe(expected)
  })

  it('clamps speed to [0.5, 2] for StepFun models only', () => {
    const speed = (model: string, value: number) =>
      (JSON.parse(speechBody(model, { op: 'speech', text: 'x', speed: value })) as { speed?: number }).speed
    expect(speed('stepaudio-3-tts', 3)).toBe(2)
    expect(speed('stepaudio-3-tts', 0.25)).toBe(0.5)
    expect(speed('stepaudio-3-tts', 1.5)).toBe(1.5)
    expect(speed(COSY, 3)).toBe(3)
    expect(speed(COSY, 0.25)).toBe(0.25)
  })

  it.each([['audio/mpeg'], ['audio/mp3; charset=binary'], ['application/octet-stream']])(
    'accepts a reply of type %s',
    async (type) => {
      const { adapter } = harness([audio(new Uint8Array([1, 2, 3]), type)])
      const events = await run(adapter, request({ model: COSY, payload: { op: 'speech', text: 'hi' } }))
      expect(textOf(events)).toBe('AQID')
    },
  )

  it('is FORMAT for speech over MAX_SPEECH_BYTES or with a JSON content type', async () => {
    const speech = request({ model: COSY, payload: { op: 'speech', text: 'hi' } })
    const big = harness([audio(new Uint8Array(MAX_SPEECH_BYTES + 1))])
    expect(errorOf(await run(big.adapter, speech))).toMatchObject({ code: 'FORMAT', retryable: false })
    const sized = harness([
      new Response(new Uint8Array(4), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(MAX_SPEECH_BYTES + 1) },
      }),
    ])
    expect(errorOf(await run(sized.adapter, speech))).toMatchObject({ code: 'FORMAT' })
    const wrongType = harness([audio(new Uint8Array([1, 2, 3]), 'application/json')])
    const events = await run(wrongType.adapter, speech)
    expect(errorOf(events)).toMatchObject({ code: 'FORMAT', retryable: false })
    expect(types(events)).not.toContain('text_delta')
    const empty = harness([audio(new Uint8Array())])
    expect(errorOf(await run(empty.adapter, speech))).toMatchObject({ code: 'FORMAT' })
  })

  it('has a cap that equals the host schema cap in base64', () => {
    expect(Math.ceil(MAX_SPEECH_BYTES / 3) * 4).toBe(1_024_000)
  })
})

describe('HTTP statuses', () => {
  it.each([
    [400, 'CONTRACT_MISMATCH', false],
    [401, 'AUTH', false],
    [403, 'AUTH', false],
    [402, 'QUOTA', false],
    [404, 'NO_MODEL', false],
    [413, 'OVERFLOW', false],
    [422, 'CONTRACT_MISMATCH', false],
  ])('maps HTTP %i to %s with a zero-usage event', async (status, code, retryable) => {
    const { adapter } = harness([failed(status)])
    const events = await run(adapter)
    expect(types(events)).toEqual(['usage', 'error'])
    expect(usageOf(events).tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(errorOf(events)).toMatchObject({
      code,
      retryable,
      message: `openai-audio ${code} (HTTP ${status})`,
    })
  })

  it.each([[500], [502], [503]])('maps HTTP %i to a retryable TRANSPORT without usage', async (status) => {
    const { adapter } = harness([failed(status)])
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
  })

  it('maps 529 to a retryable RATE_LIMIT without usage', async () => {
    const { adapter } = harness([failed(529)])
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'RATE_LIMIT', retryable: true })
  })

  it('maps 429 to a retryable RATE_LIMIT with retryAfterMs and a zero-usage event', async () => {
    const { adapter } = harness([failed(429, { 'retry-after': '3' })])
    const events = await run(adapter)
    expect(types(events)).toEqual(['usage', 'error'])
    expect(errorOf(events)).toMatchObject({ code: 'RATE_LIMIT', retryable: true, retryAfterMs: 3000 })
  })

  it('reads an HTTP date in retry-after against the clock', async () => {
    const { adapter } = harness([failed(429, { 'retry-after': new Date(NOW + 5_000).toUTCString() })])
    expect(errorOf(await run(adapter))).toMatchObject({ retryAfterMs: 5000 })
  })

  it('never quotes the reply, the key or the audio in an error', async () => {
    const { adapter } = harness([failed(400)])
    const text = JSON.stringify(await run(adapter))
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('audio.example.invalid')
  })

  it('records the vendor request id when it is safe', async () => {
    const { adapter } = harness([json({ text: 'a' }, 200, { 'x-request-id': 'req-123' })])
    const events = await run(adapter)
    expect(usageOf(events).response).toEqual({ status: 200, id: 'req-123', model: SENSE })
    const unsafe = harness([failed(500, { 'x-request-id': 'bad id\twith space' })])
    expect(errorOf(await run(unsafe.adapter)).requestId).toBeUndefined()
  })
})

describe('transport', () => {
  it('times out as a retryable TIMEOUT and an abort as ABORTED', async () => {
    const slow = harness([hanging])
    const timedOut = await run(slow.adapter, request(), { timeoutMs: { firstToken: 20, total: 20 } })
    expect(errorOf(timedOut)).toMatchObject({ code: 'TIMEOUT', retryable: true })
    const controller = new AbortController()
    const stuck = harness([hanging])
    const pending = run(stuck.adapter, request(), { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(errorOf(await pending)).toMatchObject({ code: 'ABORTED', retryable: false })
  })

  it('is a retryable TRANSPORT when the connection fails', async () => {
    const { adapter } = harness([new Error(`reset ${SENTINEL}`)])
    const events = await run(adapter)
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
    expect(JSON.stringify(events)).not.toContain(SENTINEL)
  })

  it('does not dispatch a call that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter, calls } = harness()
    expect(errorOf(await run(adapter, request(), { signal: controller.signal }))).toMatchObject({
      code: 'ABORTED',
    })
    expect(calls).toHaveLength(0)
  })

  it('ends a read of the body when the call is aborted', async () => {
    const controller = new AbortController()
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })
    const { adapter } = harness([
      new Response(never, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    ])
    const pending = run(adapter, request({ model: COSY, payload: { op: 'speech', text: 'hi' } }), {
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(errorOf(await pending)).toMatchObject({ code: 'ABORTED' })
  })
})

describe('what is reported', () => {
  it('reports only metadata to reportRequest, never the audio', async () => {
    const { adapter } = harness([json({ text: 'a' })])
    const payload = transcribe(wav16k(1), 'zh')
    const seen: unknown[] = []
    await run(adapter, request({ payload }), { reportRequest: async (b) => void seen.push(b) })
    expect(JSON.stringify(seen)).not.toContain(payload.audio.data.slice(0, 32))
    expect(seen[0]).toEqual({
      model: SENSE,
      op: 'transcribe',
      language: 'zh',
      mimeType: 'audio/wav',
      audioBytes: 32_044,
      audioSeconds: 1,
    })
  })

  it('reports only metadata for speech, never the text', async () => {
    const { adapter } = harness([audio(new Uint8Array([1]))])
    const seen: unknown[] = []
    await run(
      adapter,
      request({ model: COSY, payload: { op: 'speech', text: 'SECRET-SPEECH-TEXT', speed: 1.2 } }),
      {
        reportRequest: async (b) => void seen.push(b),
      },
    )
    expect(JSON.stringify(seen)).not.toContain('SECRET-SPEECH-TEXT')
    expect(seen[0]).toEqual({
      model: COSY,
      op: 'speech',
      voice: `${COSY}:anna`,
      speed: 1.2,
      response_format: 'mp3',
      inputBytes: 18,
    })
  })

  it('reports the sent digest of the body bytes, then the body, then the dispatch, and only then calls fetch', async () => {
    const { adapter, calls, log } = harness([json({ text: 'a' })])
    const seen: { sent?: unknown } = {}
    await run(adapter, request(), {
      reportSent: (report) => {
        log.push('sent')
        seen.sent = report
      },
      reportRequest: async () => void log.push('request'),
      reportDispatch: () => void log.push('dispatch'),
    })
    expect(log).toEqual(['sent', 'request', 'dispatch', 'fetch'])
    expect(seen.sent).toEqual({
      sentHash: createHash('sha256')
        .update(calls[0]?.init.body as Uint8Array)
        .digest('hex'),
      transforms: [{ event: 'payload_body', ext: 'openai-audio' }],
    })
    expect(JSON.stringify(seen)).not.toContain(KEY)
  })

  it('still sends when the request capture hook throws', async () => {
    const { adapter, calls } = harness([json({ text: 'a' })])
    const events = await run(adapter, request(), {
      reportRequest: async () => {
        throw new Error('capture failed')
      },
    })
    expect(calls).toHaveLength(1)
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
  })
})

describe('requests refused before any network call', () => {
  const good = transcribe(wav16k(1))
  const cases: Array<[string, RequestOver]> = [
    ['no payload', { payload: undefined }],
    ['a null payload', { payload: null }],
    ['an array payload', { payload: [] }],
    ['a string payload', { payload: 'text' }],
    ['an unknown op', { payload: { op: 'translate', text: 'x' } }],
    ['no op', { payload: { text: 'x' } }],
    ['tools', { tools: [{ name: 't', description: 'd', parameters: {} }] as never }],
    ['messages', { messages: [{ role: 'user', content: 'hi' }] as never }],
    ['a system prompt', { system: 'be brief' }],
    ['an extra transcribe key', { payload: { ...good, extra: 1 } }],
    ['an extra speech key', { payload: { op: 'speech', text: 'x', pitch: 1 } }],
    [
      'audio of another mime type',
      { payload: { ...good, audio: { ...good.audio, mimeType: 'audio/mpeg' } } },
    ],
    ['audio of another type', { payload: { ...good, audio: { ...good.audio, type: 'image' } } }],
    ['audio with an extra key', { payload: { ...good, audio: { ...good.audio, name: 'x' } } }],
    [
      'non-WAV audio',
      {
        payload: transcribe(
          Buffer.from('this is not a wave file at all, but it is long enough').toString('base64'),
        ),
      },
    ],
    ['audio that is not base64', { payload: transcribe(`${'A'.repeat(70)}!!!!`) }],
    ['a truncated header', { payload: transcribe(wav16k(0.001).slice(0, 40)) }],
    ['a language that is not a code', { payload: { ...good, language: 'zh; rm' } }],
    ['a language of another type', { payload: { ...good, language: 5 } }],
    ['empty speech text', { payload: { op: 'speech', text: '' } }],
    ['speech text of another type', { payload: { op: 'speech', text: 5 } }],
    ['a speed below the range', { payload: { op: 'speech', text: 'x', speed: 0.1 } }],
    ['a speed above the range', { payload: { op: 'speech', text: 'x', speed: 5 } }],
    ['a speed that is not a number', { payload: { op: 'speech', text: 'x', speed: Number.NaN } }],
    ['a voice of another type', { payload: { op: 'speech', text: 'x', voice: 3 } }],
  ]
  it.each(cases)('refuses %s as CONTRACT_MISMATCH', async (_name, over) => {
    const { adapter, calls } = harness()
    const hooks: string[] = []
    const events = await run(adapter, request(over), {
      reportSent: () => void hooks.push('sent'),
      reportRequest: async () => void hooks.push('request'),
      reportDispatch: () => void hooks.push('dispatch'),
    })
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'CONTRACT_MISMATCH', retryable: false })
    expect(calls).toHaveLength(0)
    expect(hooks).toEqual([])
  })

  it('is AUTH without a credential and NO_ADAPTER for an unknown route, sending nothing', async () => {
    const built = harness()
    built.adapter.bindCredential('audio', undefined)
    expect(errorOf(await run(built.adapter))).toMatchObject({ code: 'AUTH', retryable: false })
    expect(errorOf(await run(built.adapter, request(), {}, 'nowhere'))).toMatchObject({ code: 'NO_ADAPTER' })
    expect(built.calls).toHaveLength(0)
  })

  it('accepts a speed at both ends of the range and a language with a region', () => {
    expect(readAudioPayload(request({ payload: { op: 'speech', text: 'x', speed: 0.25 } }))).toMatchObject({
      speed: 0.25,
    })
    expect(readAudioPayload(request({ payload: { op: 'speech', text: 'x', speed: 4 } }))).toMatchObject({
      speed: 4,
    })
    expect(readAudioPayload(request({ payload: transcribe(wav16k(1), 'zh-CN') }))).toMatchObject({
      language: 'zh-CN',
    })
  })
})

describe('the WAV header and the units', () => {
  it('reads the format and the size of a recording', () => {
    expect(wavHeader(wav16k(2.4))).toEqual({
      sampleRate: 16000,
      channels: 1,
      bits: 16,
      byteRate: 32000,
      dataBytes: 76_800,
    })
    expect(wavHeader(wav16k(1, { sampleRate: 44_100, channels: 2 }))).toMatchObject({
      sampleRate: 44_100,
      channels: 2,
      byteRate: 176_400,
    })
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'sizes a recording with %i extra data bytes exactly (padding)',
    (extra) => {
      const raw = Buffer.from(wav16k(0.1), 'base64')
      const bytes = Buffer.concat([raw, Buffer.alloc(extra)])
      expect(wavHeader(bytes.toString('base64'))?.dataBytes).toBe(raw.length - 44 + extra)
    },
  )

  it.each([
    ['text that is not base64', 'not base64 at all!'],
    ['a short string', 'AAAA'],
    ['non-WAV bytes', Buffer.alloc(100).toString('base64')],
    ['RIFF without WAVE', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100)]).toString('base64')],
    [
      'a non-PCM format',
      (() => {
        const raw = Buffer.from(wav16k(0.1), 'base64')
        raw.writeUInt16LE(3, 20)
        return raw.toString('base64')
      })(),
    ],
    [
      'a zero byte rate',
      (() => {
        const raw = Buffer.from(wav16k(0.1), 'base64')
        raw.writeUInt32LE(0, 28)
        return raw.toString('base64')
      })(),
    ],
  ])('rejects %s', (_name, data) => {
    expect(wavHeader(data)).toBeUndefined()
  })

  it('counts seconds rounded up for a recording and UTF-8 bytes for a speech', () => {
    expect(openAiAudioUnits(transcribe(wav16k(2.4)))).toBe(3)
    expect(openAiAudioUnits(transcribe(wav16k(1)))).toBe(1)
    expect(openAiAudioUnits(transcribe(wav16k(20)))).toBe(20)
    expect(openAiAudioUnits({ op: 'speech', text: 'hi' })).toBe(2)
    expect(openAiAudioUnits({ op: 'speech', text: '你好' })).toBe(6)
  })

  it.each([
    [null],
    [undefined],
    ['text'],
    [{}],
    [{ op: 'speech' }],
    [{ op: 'transcribe' }],
    [{ op: 'transcribe', audio: {} }],
    [{ op: 'transcribe', audio: { data: 'AAAA' } }],
  ])('has no units for %j', (payload) => {
    expect(openAiAudioUnits(payload)).toBeUndefined()
  })
})

describe('multipartBody', () => {
  it('lays out the fields, then the file, then the closing boundary', () => {
    const file = new Uint8Array([0, 255, 13, 10, 7])
    const body = Buffer.from(multipartBody({ model: 'm', language: 'zh' }, file, 'B'))
    const expected = Buffer.concat([
      Buffer.from(
        '--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n' +
          '--B\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n' +
          '--B\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n',
      ),
      Buffer.from(file),
      Buffer.from('\r\n--B--\r\n'),
    ])
    expect(body.equals(expected)).toBe(true)
  })
})

describe('the probe', () => {
  const probeWith = (reply: Response | Error, baseUrl = BASE, signal = new AbortController().signal) => {
    const calls: Call[] = []
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      if (reply instanceof Error) throw reply
      return reply
    }) as typeof fetch
    return { calls, result: probeOpenAiAudioEndpoint({ baseUrl, credential: KEY, request, signal }) }
  }

  it('probes with GET <base>/models and tells a rejected key apart', async () => {
    const ok = probeWith(json({ data: [] }))
    expect(await ok.result).toBe('ok')
    expect(ok.calls[0]?.url).toBe('https://audio.example.invalid/v1/models')
    expect(ok.calls[0]?.init.method).toBe('GET')
    expect(ok.calls[0]?.init.redirect).toBe('error')
    expect(new Headers(ok.calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(await probeWith(failed(401)).result).toBe('auth')
    expect(await probeWith(failed(403)).result).toBe('auth')
    expect(await probeWith(failed(429)).result).toBe('throttled')
    expect(await probeWith(failed(500)).result).toBe('failed')
    expect(await probeWith(failed(404)).result).toBe('failed')
  })

  it('is failed for a broken connection, an aborted call and a base URL it refuses', async () => {
    expect(await probeWith(new Error('reset')).result).toBe('failed')
    const aborted = new AbortController()
    aborted.abort()
    expect(await probeWith(new Error('aborted'), BASE, aborted.signal).result).toBe('failed')
    const refused = probeWith(json({}), 'http://example.com/v1')
    expect(await refused.result).toBe('failed')
    expect(refused.calls).toHaveLength(0)
  })

  it('handles a trailing slash and a loopback http address', async () => {
    const slash = probeWith(json({}), `${BASE}/`)
    await slash.result
    expect(slash.calls[0]?.url).toBe('https://audio.example.invalid/v1/models')
    const local = probeWith(json({}), 'http://127.0.0.1:8123/v1')
    expect(await local.result).toBe('ok')
    expect(local.calls[0]?.url).toBe('http://127.0.0.1:8123/v1/models')
  })
})

describe('routes', () => {
  it.each([
    ['https://host.invalid/v1/', 'https://host.invalid/v1/audio/speech'],
    ['https://host.invalid', 'https://host.invalid/audio/speech'],
    ['http://127.0.0.1:8123/v1', 'http://127.0.0.1:8123/v1/audio/speech'],
  ])('appends the path to %s', async (baseUrl, expected) => {
    const { adapter, calls } = harness([audio(new Uint8Array([1]))], { routes: [routeDecl({ baseUrl })] })
    await run(adapter, request({ model: COSY, payload: { op: 'speech', text: 'hi' } }))
    expect(calls[0]?.url).toBe(expected)
  })

  const rejected: Array<[string, () => AudioRoute[], string]> = [
    ['a route for another api', () => [routeDecl({ api: 'openai-completions' })], 'NO_ADAPTER'],
    ['a base URL in plain http', () => [routeDecl({ baseUrl: 'http://example.com/v1' })], 'INVALID_BASE_URL'],
    [
      'a base URL with credentials',
      () => [routeDecl({ baseUrl: 'https://u:p@host.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'a base URL with a template',
      () => [routeDecl({ baseUrl: 'https://{host}.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'a base URL with a query',
      () => [routeDecl({ baseUrl: 'https://host.invalid/v1?a=1' })],
      'INVALID_BASE_URL',
    ],
    ['a relative base URL', () => [routeDecl({ baseUrl: '/v1' })], 'INVALID_BASE_URL'],
    ['a route declared twice', () => [routeDecl(), routeDecl()], 'DUPLICATE_ROUTE'],
    [
      'a model recorded for another api',
      () => [routeDecl({ models: [fakeModel({ id: SENSE, route: 'audio', api: 'openai-completions' })] })],
      'CONTRACT_MISMATCH',
    ],
    [
      'a model with a contract',
      () => [
        routeDecl({
          models: [fakeModel({ id: SENSE, route: 'audio', api: OPENAI_AUDIO_WIRE_API, contract_id: 'c1' })],
        }),
      ],
      'CONTRACT_MISMATCH',
    ],
  ]
  it.each(rejected)('refuses %s', (_name, routes, code) => {
    const error = setupError(() => harness([], { routes: routes() }))
    expect(error.code).toBe(code)
    expect(error.message).not.toContain('host.invalid')
  })

  it('validates a base URL like the constructor does', () => {
    const decl = (baseUrl: string) => ({ api: OPENAI_AUDIO_WIRE_API, route: 'r', baseUrl })
    expect(() => validateModelBaseUrl(decl('http://example.com/v1'))).toThrow(/INVALID_BASE_URL/)
    expect(() => validateModelBaseUrl(decl('http://127.0.0.1:9/v1'))).not.toThrow()
    expect(() => validateModelBaseUrl(decl('http://localhost:9/v1'))).not.toThrow()
    expect(() => validateModelBaseUrl(decl('https://api.siliconflow.cn/v1'))).not.toThrow()
  })

  it('serves each route through its own pool and closes every pool once on dispose', async () => {
    const built = harness([audio(new Uint8Array([1]))])
    expect(built.adapter.routes().map((r) => r.route)).toEqual(['audio'])
    expect(built.adapter.models('audio').map((m) => m.id)).toEqual(MODELS)
    expect(built.adapter.models('nowhere')).toEqual([])
    expect(built.adapter.acceptsPayload).toBe(true)
    expect(built.adapter.id).toBe('openai-audio')
    await Promise.all([built.adapter.dispose(), built.adapter.dispose()])
    expect(built.closed).toEqual(['audio'])
    expect(errorOf(await run(built.adapter))).toMatchObject({ code: 'NO_ADAPTER' })
  })
})

describe('through the provider facade', () => {
  const facade = (replies: Reply[], model: string) => {
    const built = harness(replies)
    const provider = createProvider({
      adapters: [built.adapter],
      routes: { primary: { route: 'audio', model } },
      contract: new NullContractStore(),
      secrets: () => KEY,
      clock: () => 1000,
      pricing: { creditsPerUsd: 100 },
    })
    return { ...built, provider }
  }
  const infer = async (provider: ReturnType<typeof facade>['provider'], req: RequestBody) => {
    const out: InferenceEvent[] = []
    for await (const e of provider.infer(req, { signal: new AbortController().signal, toolNames: [] }))
      out.push(e)
    return out
  }
  const speak = (model = COSY) => request({ model, payload: { op: 'speech', text: 'hi' } })

  it('passes the payload gate and yields sent, text_delta, usage, done', async () => {
    const { provider, calls } = facade([json({ text: '你好' })], SENSE)
    const events = await infer(provider, request())
    expect(types(events)).toEqual(['sent', 'text_delta', 'usage', 'done'])
    const stamp = (events[0] as Extract<InferenceEvent, { type: 'sent' }>).stamp
    expect(stamp.sent_hash).toBe(
      createHash('sha256')
        .update(calls[0]?.init.body as Uint8Array)
        .digest('hex'),
    )
    expect(stamp.transforms).toEqual([{ event: 'payload_body', ext: 'openai-audio' }])
  })

  it('carries a speech of exactly MAX_SPEECH_BYTES through intact, and refuses one byte more', async () => {
    const bytes = new Uint8Array(MAX_SPEECH_BYTES)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff
    const { provider } = facade([audio(bytes)], COSY)
    const events = await infer(provider, speak())
    const text = textOf(events)
    expect(text).toHaveLength(1_024_000)
    expect(Buffer.from(text, 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(usageOf(events as WireEvent[]).tokens.input).toBe(2)

    const over = facade([audio(new Uint8Array(MAX_SPEECH_BYTES + 1))], COSY)
    const failedEvents = await infer(over.provider, speak())
    expect(failedEvents.find((e) => e.type === 'error')).toMatchObject({ code: 'FORMAT' })
    expect(types(failedEvents)).not.toContain('text_delta')
  })

  it('keeps tag-shaped transcript text as plain text', async () => {
    const { provider } = facade([json({ text: 'a < b and c > d' })], SENSE)
    expect(textOf(await infer(provider, request()))).toBe('a < b and c > d')
  })

  it('reports a rejected key as AUTH', async () => {
    const { provider } = facade([failed(401)], SENSE)
    const events = await infer(provider, request())
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'AUTH', retryable: false })
  })
})
