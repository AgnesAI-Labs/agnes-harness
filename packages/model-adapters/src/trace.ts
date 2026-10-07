import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { ModelAdapterEvent, ModelAdapterInstance, ModelAdapterStreamOptions } from '@agnes/extension-api'
import { validateAgainst, type RequestBody } from '@agnes/protocol'
import { InferenceEvent as EventSchema, RequestBody as RequestSchema } from '@agnes/protocol/gen/model'

/** One complete wire invocation. No credential or request headers are recorded. */
export type ModelResponseRecord = {
  schemaVersion: 1
  sessionKey: string
  index: number
  request: RequestBody
  events: ModelAdapterEvent[]
  complete: boolean
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function compat(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!object(value)) throw new Error('adapter compat must be an object')
  return value
}
export function absoluteFile(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new Error('adapter file must be an absolute path')
  return value
}
export async function readBoundedFile(file: string): Promise<string> {
  const handle = await open(absoluteFile(file), 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error('adapter file exceeds 64 MiB or is not a file')
    // One extra byte detects growth between stat and read, without unbounded allocation.
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > stat.size) throw new Error('adapter file changed while reading')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    await handle.close()
  }
}
export function validateReply(value: unknown): ModelAdapterEvent[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('reply must contain wire events')
  const events: ModelAdapterEvent[] = []
  for (const event of value) {
    if (!object(event) || event.type === 'sent' || event.type === 'deviation')
      throw new Error('invalid wire event')
    const validated = validateAgainst(
      EventSchema,
      event.type === 'toolcall_end' ? { ...event, via: 'native' } : event,
    )
    if (!validated.ok) throw new Error('invalid wire event schema')
    events.push(structuredClone(event) as ModelAdapterEvent)
  }
  const terminals = events.filter((event) => event.type === 'done' || event.type === 'error')
  if (terminals.length !== 1 || terminals[0] !== events.at(-1))
    throw new Error('reply must end with one terminal event')
  return events
}
export async function readModelResponses(
  file: string,
  recordedSession?: string,
): Promise<ModelResponseRecord[]> {
  const rows = (await readBoundedFile(file))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const row: unknown = JSON.parse(line)
      if (
        !object(row) ||
        row.schemaVersion !== 1 ||
        typeof row.sessionKey !== 'string' ||
        !Number.isSafeInteger(row.index) ||
        (row.index as number) < 0 ||
        row.complete !== true ||
        !validateAgainst(RequestSchema, row.request).ok
      )
        throw new Error('invalid or incomplete model response record')
      if ((row.request as RequestBody).sessionKey !== row.sessionKey)
        throw new Error('trace session identity mismatch')
      return { ...row, events: validateReply(row.events) } as ModelResponseRecord
    })
  const sessions = new Set(rows.map((row) => row.sessionKey))
  if (recordedSession === undefined && sessions.size !== 1)
    throw new Error('select recordedSession for a multi-session trace')
  const selected = rows
    .filter((row) => recordedSession === undefined || row.sessionKey === recordedSession)
    .sort((a, b) => a.index - b.index)
  if (!selected.length || selected.some((row, index) => row.index !== index))
    throw new Error('missing or duplicate trace invocation')
  return selected
}

/** Wrap any registered adapter instance; the file is exclusive, private, and never overwritten. */
export async function recordModelResponses(
  adapter: ModelAdapterInstance,
  file: string,
): Promise<ModelAdapterInstance> {
  const handle = await open(absoluteFile(file), 'wx', 0o600)
  const indexes = new Map<string, number>()
  let writes = Promise.resolve()
  let closed = false
  return {
    id: adapter.id,
    routes: () => adapter.routes(),
    models: (route) => adapter.models(route),
    ...(adapter.bindCredential
      ? {
          bindCredential: (route: string, value: string | undefined) => adapter.bindCredential!(route, value),
        }
      : {}),
    ...(adapter.count
      ? {
          count: (route: string, request: RequestBody, options: { signal: AbortSignal }) =>
            adapter.count!(route, request, options),
        }
      : {}),
    ...(adapter.probe
      ? { probe: (route: string, signal: AbortSignal) => adapter.probe!(route, signal) }
      : {}),
    ...(adapter.refresh
      ? { refresh: (route: string, signal: AbortSignal) => adapter.refresh!(route, signal) }
      : {}),
    async *stream(route: string, request: RequestBody, options: ModelAdapterStreamOptions) {
      if (closed) throw new Error('recording adapter is disposed')
      const sessionKey = options.sessionKey
      if (request.sessionKey !== sessionKey) throw new Error('recording session identity mismatch')
      const index = indexes.get(sessionKey) ?? 0
      indexes.set(sessionKey, index + 1)
      const snapshot = structuredClone(request)
      const events: ModelAdapterEvent[] = []
      let complete = false
      try {
        for await (const event of adapter.stream(route, request, options)) {
          events.push(structuredClone(event))
          // Commit before the terminal is handed to a consumer that may stop iteration.
          if (event.type === 'done' || event.type === 'error') {
            validateReply(events)
            const row: ModelResponseRecord = {
              schemaVersion: 1,
              sessionKey,
              index,
              request: snapshot,
              events,
              complete: true,
            }
            writes = writes.then(() => handle.appendFile(`${JSON.stringify(row)}\n`))
            await writes
            complete = true
          }
          yield event
        }
      } finally {
        if (!complete) {
          const row: ModelResponseRecord = {
            schemaVersion: 1,
            sessionKey,
            index,
            request: snapshot,
            events,
            complete: false,
          }
          writes = writes.then(() => handle.appendFile(`${JSON.stringify(row)}\n`))
          await writes
        }
      }
    },
    async dispose() {
      if (closed) return
      closed = true
      try {
        await writes
      } finally {
        try {
          await handle.close()
        } finally {
          await adapter.dispose?.()
        }
      }
    },
  }
}
