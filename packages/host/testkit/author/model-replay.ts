import { open } from 'node:fs/promises'
import { stampFor } from '@agnes/ai/testkit'
import { replayRequestKey } from '@agnes/model-adapters'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  InferenceEvent as EventSchema,
  ModelRecord as ModelSchema,
  RequestBody as RequestSchema,
} from '@agnes/protocol/gen/model'

export interface RecordingOptions {
  /** Exact secret values to remove, including private business data in model text. */
  secrets?: readonly string[]
  /** Additional text redaction; applied both when recording and matching replay input. */
  redactText?: (text: string) => string
}
interface Exchange {
  session: string
  index: number
  request: RequestBody
  events: InferenceEvent[]
  accepted: boolean
  complete: boolean
  failure?: string
}
export interface ModelFixture {
  schemaVersion: 1
  models: ModelRecord[]
  exchanges: Exchange[]
}
const sensitive =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)$/i
const identities = /^(?:sessionKey|toolUseId|invocationId|effectId|parentEffectId|requestId|jobId)$/

/** One normalizer per session preserves tool-call/result links over multiple requests. */
function normalizer(options: RecordingOptions, normalizeIds = true, ids = new Map<string, string>()) {
  let identityNumber = 0
  const secrets = [...(options.secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
  const text = (source: string) => {
    let value = source
    for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]')
    value = value
      .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|pk)-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    return options.redactText?.(value) ?? value
  }
  const isIdentity = (key: string, parent: string, business: boolean) =>
    !business && (identities.test(key) || (key === 'id' && parent === 'response'))
  const isBusiness = (key: string) =>
    ['args', 'structured', 'parameters', 'schema', 'compat', 'metadata'].includes(key)
  function clean(value: unknown, key = '', parent = '', business = false): unknown {
    if (sensitive.test(key)) return '[REDACTED]'
    business ||= isBusiness(key)
    if (typeof value === 'string') {
      if (normalizeIds && isIdentity(key, parent, business)) {
        const identity = key === 'sessionKey' ? 'session' : 'id'
        const existing = ids.get(value)
        if (existing) return existing
        const normalized = `${identity}-${++identityNumber}`
        ids.set(value, normalized)
        return normalized
      }
      if (key === 'derivedHash') return '0'.repeat(64)
      if (key === 'baseUrl') return 'http://127.0.0.1:1'
      return text(value)
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, '', key, business))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => !sensitive.test(name) && !['headers', 'headerNames', 'timing'].includes(name))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, item]) => [
            name,
            name === 'data' &&
            !business &&
            ['image', 'file', 'media'].includes((value as { type?: string }).type ?? '')
              ? '[REDACTED]'
              : clean(item, name, key, business),
          ]),
      )
    return value
  }
  return Object.assign(clean, {
    /** Replay outputs already carry fixture aliases; subsequent requests must retain their links. */
    remember: function remember(value: unknown, key = '', parent = '', business = false): void {
      business ||= isBusiness(key)
      if (typeof value === 'string' && isIdentity(key, parent, business)) {
        ids.set(value, value)
        const ordinal = /^(?:id|session)-(\d+)$/.exec(value)
        if (ordinal) identityNumber = Math.max(identityNumber, Number(ordinal[1]))
      } else if (Array.isArray(value)) {
        for (const item of value) remember(item, '', key, business)
      } else if (value && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) remember(item, name, key, business)
      }
    },
  })
}
function validFixture(value: unknown): asserts value is ModelFixture {
  if (!value || typeof value !== 'object') throw new Error('Invalid model fixture')
  const fixture = value as Partial<ModelFixture>
  if (
    fixture.schemaVersion !== 1 ||
    !Array.isArray(fixture.models) ||
    !Array.isArray(fixture.exchanges) ||
    !fixture.exchanges.length
  )
    throw new Error('Invalid model fixture')
  for (const model of fixture.models)
    if (!validateAgainst(ModelSchema, model).ok) throw new Error('Invalid fixture model')
  const cursors = new Map<string, number>()
  for (const row of fixture.exchanges) {
    if (
      !row ||
      typeof row.session !== 'string' ||
      row.index !== (cursors.get(row.session) ?? 0) ||
      row.complete !== true ||
      typeof row.accepted !== 'boolean' ||
      !validateAgainst(RequestSchema, row.request).ok ||
      !Array.isArray(row.events) ||
      (row.failure !== undefined && typeof row.failure !== 'string')
    )
      throw new Error('Invalid or incomplete model exchange')
    if (row.events.some((event) => !validateAgainst(EventSchema, event).ok || event.type === 'sent'))
      throw new Error('Invalid recorded event')
    const terminal = row.events.findIndex((event) => event.type === 'done' || event.type === 'error')
    if (terminal >= 0 && terminal !== row.events.length - 1) throw new Error('Events after terminal')
    if (terminal < 0 && row.failure === undefined) throw new Error('Missing terminal event')
    cursors.set(row.session, row.index + 1)
  }
}

/** Wrap a real or scripted Provider. The exclusive fixture stores no headers, credentials or raw stamps. */
export async function recordModelFixture(inner: Provider, file: string, options: RecordingOptions = {}) {
  const handle = await open(file, 'wx', 0o600)
  const sessions = new Map<
    string,
    { name: string; cursor: number; clean: ReturnType<typeof normalizer>; busy: boolean }
  >()
  const exchanges: Exchange[] = []
  let closed = false
  let closing: Promise<void> | undefined
  let active = 0
  const provider: Provider = {
    models: () => inner.models(),
    async *infer(request, input) {
      if (closed) throw new Error('Model recorder closed')
      input.signal.throwIfAborted()
      let state = sessions.get(request.sessionKey)
      if (!state) {
        const name = `session-${sessions.size + 1}`
        state = {
          name,
          cursor: 0,
          clean: normalizer(options, true, new Map([[request.sessionKey, name]])),
          busy: false,
        }
        sessions.set(request.sessionKey, state)
      }
      if (state.busy) throw new Error('Concurrent model calls in one recorded session')
      const normalized = state.clean(request) as RequestBody
      state.busy = true
      active++
      const row: Exchange = {
        session: state.name,
        index: state.cursor++,
        request: normalized,
        events: [],
        accepted: false,
        complete: false,
      }
      exchanges.push(row)
      try {
        for await (const event of inner.infer(request, input)) {
          input.signal.throwIfAborted()
          if (event.type === 'sent') row.accepted = true
          else row.events.push(state.clean(event) as InferenceEvent)
          yield event
        }
        if (!row.events.some((event) => event.type === 'done' || event.type === 'error'))
          row.failure = 'Recorded stream ended without a terminal event'
        row.complete = true
      } catch (error) {
        row.failure = state.clean(error instanceof Error ? error.message : 'Recorded model failure') as string
        row.complete = !input.signal.aborted
        throw error
      } finally {
        state.busy = false
        active--
      }
    },
  }
  return {
    provider,
    async close() {
      if (closing) return closing
      if (active) throw new Error('Drain model streams before closing the recorder')
      closed = true
      closing = (async () => {
        try {
          const clean = normalizer(options, false)
          const fixture: ModelFixture = {
            schemaVersion: 1,
            models: clean(inner.models()) as ModelRecord[],
            exchanges,
          }
          await handle.writeFile(JSON.stringify(fixture, null, 2) + '\n')
        } finally {
          await handle.close()
        }
      })()
      return closing
    },
  }
}

/** Offline strict replay; bind each new session to the next recorded script and fail on drift/exhaustion. */
export async function replayModelFixture(file: string, options: RecordingOptions = {}) {
  const handle = await open(file, 'r')
  let value: unknown
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Model fixture exceeds 16 MiB')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > stat.size) throw new Error('Model fixture changed while reading')
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } finally {
    await handle.close()
  }
  validFixture(value)
  const fixture = value
  const scripts = [...new Set(fixture.exchanges.map((row) => row.session))].map((session) =>
    fixture.exchanges.filter((row) => row.session === session),
  )
  const bound = new Map<
    string,
    {
      script: Exchange[]
      cursor: number
      clean: ReturnType<typeof normalizer>
      busy: boolean
      abandoned: boolean
    }
  >()
  const provider: Provider = {
    models: () => structuredClone(fixture.models),
    async *infer(request, input) {
      input.signal.throwIfAborted()
      let state = bound.get(request.sessionKey)
      if (!state) {
        const script = scripts[bound.size]
        if (!script) throw new Error('Unrecorded model session')
        state = {
          script,
          cursor: 0,
          clean: normalizer(options, true, new Map([[request.sessionKey, script[0]!.session]])),
          busy: false,
          abandoned: false,
        }
        bound.set(request.sessionKey, state)
      }
      if (state.busy) throw new Error('Concurrent model replay in one session')
      if (state.abandoned) throw new Error('Model replay stream abandoned')
      const row = state.script[state.cursor]
      if (!row) throw new Error('Model fixture exhausted')
      const normalized = state.clean(request) as RequestBody
      if (replayRequestKey(normalized) !== replayRequestKey(row.request))
        throw new Error('Model replay request mismatch')
      state.clean.remember(row.events)
      state.cursor++
      state.busy = true
      let drained = false
      try {
        if (row.accepted) yield { type: 'sent', stamp: stampFor(request) }
        for (const event of row.events) {
          input.signal.throwIfAborted()
          yield structuredClone(event)
        }
        input.signal.throwIfAborted()
        drained = true
        if (row.failure !== undefined) throw new Error(row.failure)
      } finally {
        state.abandoned = !drained
        state.busy = false
      }
    },
  }
  return {
    provider,
    assertConsumed() {
      if (
        bound.size !== scripts.length ||
        [...bound.values()].some(
          (state) => state.busy || state.abandoned || state.cursor !== state.script.length,
        )
      )
        throw new Error('Model fixture not fully consumed')
    },
  }
}
