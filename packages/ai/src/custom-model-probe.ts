import type { ConfigCustomVerification, ModelRecord, RequestBody } from '@agnes/protocol'
import { PiAdapter } from './adapters/pi/index.js'

type Check = ConfigCustomVerification['checks'][number]
const TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const route = 'custom-model-probe'
const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

/** The SDK logs malformed SSE JSON verbatim; reject it before that parser can expose gateway data. */
function validateFrame(frame: string): void {
  const parts: string[] = []
  let hasEvent = false
  for (const raw of frame.split('\n')) {
    // OpenAI's line decoder removes a leading BOM on every line, not just at stream start.
    const line = raw.replace(/^\uFEFF/u, '')
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    if (field === 'data') parts.push(value)
    if (field === 'event') hasEvent = true
  }
  const data = parts.join('\n')
  if ((parts.length || hasEvent) && data !== '[DONE]') JSON.parse(data)
}

/** Connectivity and request acceptance only: a successful answer cannot establish gateway ordering. */
export async function probeCustomModel(options: {
  baseUrl: string
  model: string
  record: ModelRecord
  apiKey: string
  request: typeof fetch
}): Promise<ConfigCustomVerification> {
  const api = options.record.api
  if (api !== 'openai-completions' && api !== 'openai-responses')
    throw new Error('Custom model probe API is unsupported')
  const checks: Check[] = []
  for (const id of ['inference', 'mid-conversation-system'] as const) {
    if (id === 'mid-conversation-system' && api !== 'openai-completions') {
      checks.push({ id, status: 'skipped', reason: 'unsupported-api' })
      continue
    }
    if (id === 'mid-conversation-system' && checks[0]?.reason === 'authentication') {
      checks.push({ id, status: 'skipped', reason: 'authentication' })
      continue
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    let failure: Check['reason']
    let releaseResponse: (() => void) | undefined
    // The probe opts into ordered serialization without changing the caller's saved declaration.
    const record: ModelRecord = {
      ...structuredClone(options.record),
      id: options.model,
      route,
      baseUrl: options.baseUrl,
      compat: {
        ...(options.record.compat &&
        typeof options.record.compat === 'object' &&
        !Array.isArray(options.record.compat)
          ? options.record.compat
          : {}),
        supportsMidConvoSystemMessages: id === 'mid-conversation-system',
        supportsDeveloperRole: false,
      },
    }
    const fetchImpl: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, { ...init, redirect: 'error' })
      const signal = outgoing.signal
      let interrupt: (() => void) | undefined
      let response: Response
      try {
        const pending = options.request(outgoing).then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => undefined)
            throw new Error('Custom model probe interrupted')
          }
          return value
        })
        const stopped = new Promise<never>((_resolve, reject) => {
          interrupt = () => reject(new Error('Custom model probe interrupted'))
          if (signal.aborted) interrupt()
          else signal.addEventListener('abort', interrupt, { once: true })
        })
        response = await Promise.race([pending, stopped])
      } catch {
        failure = signal.aborted ? 'timeout' : 'network'
        throw new Error('Custom model probe transport failed')
      } finally {
        if (interrupt) signal.removeEventListener('abort', interrupt)
      }
      if (!response.ok) {
        failure = response.status === 401 || response.status === 403 ? 'authentication' : 'endpoint'
        void response.body?.cancel().catch(() => undefined)
        throw new Error('Custom model probe endpoint rejected the request')
      }
      if (
        !response.body ||
        !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
      ) {
        failure = 'invalid-response'
        void response.body?.cancel().catch(() => undefined)
        throw new Error('Custom model probe response is invalid')
      }
      const reader = response.body.getReader()
      let bytes = 0
      let buffered = ''
      let pendingCR = false
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const encoder = new TextEncoder()
      const append = (value: string, final: boolean) => {
        if (!value && !final) return
        if (pendingCR) {
          if (value.startsWith('\n')) value = value.slice(1)
          buffered += '\n'
          pendingCR = false
        }
        if (!final && value.endsWith('\r')) {
          pendingCR = true
          value = value.slice(0, -1)
        }
        buffered += value.replace(/\r\n|\r/gu, '\n')
      }
      const frames = (final: boolean): string => {
        let ready = ''
        for (;;) {
          const separator = buffered.indexOf('\n\n')
          if (separator < 0) break
          const end = separator + 2
          const frame = buffered.slice(0, end)
          validateFrame(frame)
          ready += frame
          buffered = buffered.slice(end)
        }
        if (final && buffered) {
          validateFrame(buffered)
          ready += buffered
          buffered = ''
        }
        return ready
      }
      let released = false
      const cancel = () => {
        if (released) return
        released = true
        void reader
          .cancel()
          .catch(() => undefined)
          .finally(() => reader.releaseLock())
      }
      signal.addEventListener('abort', cancel, { once: true })
      releaseResponse = () => {
        signal.removeEventListener('abort', cancel)
        cancel()
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) {
                append(decoder.decode(), true)
                const ready = frames(true)
                if (ready) controller.enqueue(encoder.encode(ready))
                signal.removeEventListener('abort', cancel)
                controller.close()
                return
              }
              bytes += next.value.byteLength
              if (bytes > MAX_RESPONSE_BYTES) throw new Error('Response limit exceeded')
              append(decoder.decode(next.value, { stream: true }), false)
              const ready = frames(false)
              if (ready) {
                controller.enqueue(encoder.encode(ready))
                return
              }
            }
          } catch {
            failure ??= abort.signal.aborted ? 'timeout' : 'invalid-response'
            cancel()
            controller.error(new Error('Custom model probe response failed'))
          }
        },
        cancel() {
          signal.removeEventListener('abort', cancel)
          cancel()
        },
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    try {
      const adapter = new PiAdapter({
        manualRoutes: [{ route, api, baseUrl: options.baseUrl, models: [record] }],
        fetchImpl,
        maxRetries: 0,
      })
      adapter.bindCredential(route, options.apiKey)
      const request: RequestBody = {
        kind: 'inference',
        sessionKey: 'agnes:config:custom-model-probe',
        slot: 'primary',
        route,
        model: options.model,
        contractId: null,
        derivedHash: '0'.repeat(64),
        system: 'This is a synthetic connectivity test. Reply briefly.',
        messages: [
          { role: 'user', content: text('Reply briefly to this synthetic connectivity test.') },
          ...(id === 'mid-conversation-system'
            ? [
                { role: 'assistant' as const, content: text('Acknowledged the earlier synthetic test.') },
                {
                  role: 'system' as const,
                  content: text('Additional synthetic test instruction: reply briefly.'),
                },
                { role: 'user' as const, content: text('Reply briefly to the current synthetic test.') },
              ]
            : []),
        ],
        tools: [],
        sampling: { maxTokens: Math.min(record.maxTokens, 64) },
      }
      let usefulText = false
      let stopped = false
      for await (const event of adapter.stream(route, request, {
        signal: abort.signal,
        toolNames: [],
        sessionKey: request.sessionKey,
        retry: false,
        timeoutMs: { firstToken: TIMEOUT_MS, total: TIMEOUT_MS },
      })) {
        if (event.type === 'text_delta' && event.delta.trim()) usefulText = true
        if (event.type === 'error')
          failure ??=
            event.code === 'TIMEOUT' || abort.signal.aborted
              ? 'timeout'
              : event.code === 'AUTH'
                ? 'authentication'
                : 'invalid-response'
        if (event.type === 'done') stopped = event.reason === 'stop'
      }
      if (abort.signal.aborted) failure = 'timeout'
      if (!usefulText || !stopped) failure ??= 'invalid-response'
    } catch {
      failure ??= abort.signal.aborted ? 'timeout' : 'invalid-response'
    } finally {
      clearTimeout(timer)
      releaseResponse?.()
      abort.abort()
    }
    checks.push(failure ? { id, status: 'failed', reason: failure } : { id, status: 'passed' })
  }
  return { baseUrl: options.baseUrl, model: options.model, api, ordering: 'unverified', checks }
}
