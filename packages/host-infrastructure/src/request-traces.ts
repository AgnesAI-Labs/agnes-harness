import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ModelAdapterAttemptObservation,
  ModelRequestTrace,
  ModelRequestTraceHandle,
} from '@agnes/extension-api'
import { withConfigurationLock } from '@agnes/host-common/configuration-lock'
import type { JsonValue, ModelRequestAttempt, ModelRequestSnapshot, RequestBody } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  ModelRequestAttempt as AttemptSchema,
  ModelRequestSnapshot as SnapshotSchema,
} from '@agnes/protocol/gen/agnes-v1'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const secretKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|headers|credentials?|(?:x[-_]?)?api[-_]?key|password|secret|client[-_]?secret|private[-_]?key|token|access[-_]?token|refresh[-_]?token)$/i
const queues = new Map<string, Promise<unknown>>()
// Do not release the process lock while a rejected sibling still writes files or updates the index.
async function settled<T>(tasks: Promise<T>[]): Promise<T[]> {
  return (await Promise.allSettled(tasks)).map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}
/** Redact values, preserve tool-schema property declarations, and never retain binary contents. */
export function redactRequest(value: unknown, depth = 0, key = ''): JsonValue {
  if (depth > 64) return '[OMITTED:depth]'
  if (value === null || value === undefined) return null
  const schemaProperty = value && typeof value === 'object' && !Array.isArray(value) && 'type' in value
  if (
    secretKey.test(key) &&
    !schemaProperty &&
    (typeof value !== 'object' || /headers|credentials/i.test(key))
  )
    return '[REDACTED]'
  if (typeof value === 'string')
    return value
      .replace(/\bdata:[^,\s]*;base64,[A-Za-z0-9+/_=-]+/gi, '[OMITTED:binary]')
      .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})/g, '[REDACTED]')
      .replace(
        /\b((?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*)["']?[^\s,"'<>]+/gi,
        '$1[REDACTED]',
      )
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength}]`
  if (Array.isArray(value)) return value.map((item) => redactRequest(item, depth + 1))
  if (typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(obj).map(([name, child]) => [
      name,
      name === 'data' && ['image', 'audio', 'file', 'base64'].includes(String(obj.type))
        ? '[OMITTED:binary]'
        : redactRequest(child, depth + 1, name),
    ]),
  )
}
type StoredAttempt = Omit<ModelRequestAttempt, 'wire'> & { wireHash?: string; wireRefs?: string[] }
type CallRecord = Omit<ModelRequestSnapshot, 'system' | 'sections' | 'tools' | 'wire' | 'attempts'> & {
  attempts: StoredAttempt[]
  sessionHash: string
  wireHash?: string
  wireRefs?: string[]
}
function validRecord(value: unknown, id: string): value is CallRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CallRecord
  const hash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const refs = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(hash))
  if (
    row.id !== id ||
    typeof row.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    ![row.sessionHash, row.systemHash, row.sectionsHash, row.toolsHash].every(hash) ||
    (row.wireHash !== undefined && !hash(row.wireHash)) ||
    !refs(row.wireRefs) ||
    !Array.isArray(row.attempts)
  )
    return false
  const attempts = []
  for (const attempt of row.attempts) {
    if (
      !attempt ||
      typeof attempt !== 'object' ||
      (attempt.wireHash !== undefined && !hash(attempt.wireHash)) ||
      !refs(attempt.wireRefs)
    )
      return false
    const { wireHash: _hash, wireRefs: _refs, ...metadata } = attempt
    attempts.push({ ...metadata, wire: null })
  }
  const { sessionHash: _owner, wireHash: _hash, wireRefs: _refs, attempts: _attempts, ...metadata } = row
  return validateAgainst(SnapshotSchema, {
    ...metadata,
    system: '',
    sections: [],
    tools: [],
    wire: null,
    attempts,
  }).ok
}
type IndexedCall = Pick<CallRecord, 'id' | 'createdAt' | 'sessionHash'> & {
  params: { kind: string; model: string }
  refs: string[]
}
const references = (rows: IndexedCall[]) => new Set(rows.flatMap((row) => row.refs))
function indexCall(row: CallRecord): IndexedCall {
  const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? row.params : {}
  return {
    id: row.id,
    createdAt: row.createdAt,
    sessionHash: row.sessionHash,
    params: { kind: String(params.kind ?? '').slice(0, 64), model: String(params.model ?? '').slice(0, 512) },
    refs: [
      ...new Set([
        row.systemHash,
        row.toolsHash,
        row.sectionsHash,
        ...(row.wireHash ? [row.wireHash] : []),
        ...(row.wireRefs ?? []),
        ...row.attempts.flatMap((attempt) => [
          ...(attempt.wireHash ? [attempt.wireHash] : []),
          ...(attempt.wireRefs ?? []),
        ]),
      ]),
    ],
  }
}
/** Local private content store. Retention is scoped to a profile; no audit/telemetry integration. */
export class RequestTraceStore implements ModelRequestTrace {
  private readonly dir: string
  private reservedBytes = 0
  private admissionFailed = false
  private files = new Map<string, { signature: string; size: number; mtimeMs: number; row?: IndexedCall }>()
  constructor(
    dataDir: string,
    profile: string,
    private readonly limits = {
      callBytes: 2 * 1024 * 1024,
      totalBytes: 64 * 1024 * 1024,
      calls: 256,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    },
    private readonly clock = Date.now,
    private readonly context?: (sessionKey: string) => { generationId: string | null },
  ) {
    this.dir = join(dataDir, 'model-requests', digest(profile))
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.dir) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        // Sessions can live in different workers. Hold one crash-released process lock over blob,
        // record and GC mutations so a collector never removes another worker's pending blobs.
        return withConfigurationLock(`${this.dir}.lock.sqlite`, async () => {
          await this.reconcile()
          this.admissionFailed = false
          return action()
        })
      })
    queues.set(this.dir, next)
    try {
      return await next
    } finally {
      if (queues.get(this.dir) === next) queues.delete(this.dir)
    }
  }
  private async write(file: string, value: CallRecord): Promise<void> {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > this.limits.callBytes) throw new Error('CAPTURE_LIMIT')
    // The temporary replacement coexists with the old row until rename; charge its full size.
    this.admit(Buffer.byteLength(text))
    const tmp = `${file}.${randomUUID()}.tmp`
    this.reservedBytes += Buffer.byteLength(text)
    try {
      await writeFile(tmp, text, { flag: 'wx', mode: 0o600 })
      await rename(tmp, file)
      await this.track(file.slice(this.dir.length + 1), indexCall(value))
    } catch (error) {
      this.admissionFailed = true
      throw error
    } finally {
      this.reservedBytes -= Buffer.byteLength(text)
      await unlink(tmp).catch(() => undefined)
    }
  }
  private admit(bytes: number): void {
    // A failed write/stat may leave unindexed bytes. Refuse later sibling admissions until the
    // entire transaction settles and the next locked reconciliation measures those remnants.
    if (this.admissionFailed) throw new Error('CAPTURE_LIMIT')
    const total = [...this.files.values()].reduce((sum, file) => sum + file.size, 0)
    if (total + this.reservedBytes + Math.max(0, bytes) > this.limits.totalBytes)
      throw new Error('CAPTURE_LIMIT')
  }
  private async blob(value: unknown): Promise<string> {
    const text = JSON.stringify(value)
    const hash = digest(text)
    if (Buffer.byteLength(text) > this.limits.callBytes) throw new Error('CAPTURE_LIMIT')
    try {
      await stat(join(this.dir, `${hash}.blob.json`))
      return hash
    } catch {
      /* New content. */
    }
    this.admit(Buffer.byteLength(text))
    this.reservedBytes += Buffer.byteLength(text)
    try {
      await writeFile(join(this.dir, `${hash}.blob.json`), text, { flag: 'wx', mode: 0o600 })
      await this.track(`${hash}.blob.json`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.admissionFailed = true
        throw error
      }
    } finally {
      this.reservedBytes -= Buffer.byteLength(text)
    }
    return hash
  }
  private async readBlob(hash: string): Promise<JsonValue> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid blob')
    const file = join(this.dir, `${hash}.blob.json`)
    if ((await stat(file)).size > this.limits.callBytes) throw new Error('Oversized blob')
    const text = await readFile(file, 'utf8')
    if (digest(text) !== hash) throw new Error('Corrupt blob')
    return JSON.parse(text) as JsonValue
  }
  private async readRecord(id: string): Promise<CallRecord | undefined> {
    try {
      const file = join(this.dir, `${id}.call.json`)
      if ((await stat(file)).size > this.limits.callBytes) return
      const text = await readFile(file, 'utf8')
      if (Buffer.byteLength(text) > this.limits.callBytes) return
      const row: unknown = JSON.parse(text)
      if (validRecord(row, id)) return row
    } catch {
      /* Corrupt or concurrently replaced legacy content is unavailable. */
    }
  }
  private async track(name: string, row?: IndexedCall) {
    const info = await stat(join(this.dir, name))
    const entry = {
      signature: `${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}`,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ...(row ? { row } : {}),
    }
    this.files.set(name, entry)
    return entry
  }
  /** A derived cache only: old writers and collectors need not know it exists. */
  private async reconcile(): Promise<void> {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.json') || name.endsWith('.tmp'))
    const found = new Set(names)
    for (const name of this.files.keys()) if (!found.has(name)) this.files.delete(name)
    for (let offset = 0; offset < names.length; offset += 32)
      await settled(
        names.slice(offset, offset + 32).map(async (name) => {
          const previous = this.files.get(name)
          const current = await this.track(name)
          if (previous?.signature === current.signature && previous.row) {
            current.row = previous.row
          } else if (/^[a-f0-9-]{36}\.call\.json$/.test(name)) {
            const row = await this.readRecord(name.slice(0, -10))
            if (row) current.row = indexCall(row)
          }
        }),
      )
  }
  private async remove(name: string): Promise<void> {
    await unlink(join(this.dir, name))
    this.files.delete(name)
  }
  private records(): IndexedCall[] {
    return [...this.files.values()]
      .flatMap((file) => (file.row ? [file.row] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  private async gc(): Promise<void> {
    const records = this.records()
    let retained = records
      .filter((row) => this.clock() - Date.parse(row.createdAt) <= this.limits.ttlMs)
      .slice(-this.limits.calls)
    const sessionCounts = new Map<string, number>()
    retained = retained
      .slice()
      .reverse()
      .filter((row) => {
        const count = (sessionCounts.get(row.sessionHash) ?? 0) + 1
        sessionCounts.set(row.sessionHash, count)
        return count <= Math.min(128, this.limits.calls)
      })
      .reverse()
    for (const [name, info] of this.files)
      if (
        /^[a-f0-9-]{36}\.call\.json\.[a-f0-9-]{36}\.tmp$/.test(name) &&
        this.clock() - info.mtimeMs > this.limits.ttlMs
      )
        await this.remove(name)
    const sizes = new Map(
      [...this.files]
        .filter(([name]) => /^(?:[a-f0-9]{64}\.blob|[a-f0-9-]{36}\.call)\.json$/.test(name))
        .map(([name, info]) => [name, info.size]),
    )
    const size = (rows: IndexedCall[]) =>
      rows.reduce((sum, row) => sum + (sizes.get(`${row.id}.call.json`) ?? 0), 0) +
      [...references(rows)].reduce((sum, hash) => sum + (sizes.get(`${hash}.blob.json`) ?? 0), 0)
    // Shared content counts against each session that references it; no session can consume
    // more than 16 MiB (or half a smaller configured profile cap).
    const sessionBytes = Math.min(16 * 1024 * 1024, this.limits.totalBytes / 2)
    for (const sessionHash of new Set(retained.map((row) => row.sessionHash))) {
      let owned = retained.filter((row) => row.sessionHash === sessionHash)
      while (owned.length && size(owned) > sessionBytes) owned = owned.slice(1)
      const keep = new Set(owned.map((row) => row.id))
      retained = retained.filter((row) => row.sessionHash !== sessionHash || keep.has(row.id))
    }
    while (retained.length && size(retained) > this.limits.totalBytes) retained = retained.slice(1)
    const calls = new Set(retained.map((row) => row.id))
    const blobs = references(retained)
    for (const [name, info] of this.files) {
      if (!sizes.has(name)) continue
      const keep = name.endsWith('.call.json') ? calls.has(name.slice(0, -10)) : blobs.has(name.slice(0, -10))
      // Expired rows release references; young unreferenced blobs survive until retention expires.
      // Admission refuses new captures rather than deleting another recent call's shared body.
      if (!keep && (name.endsWith('.call.json') || this.clock() - info.mtimeMs > this.limits.ttlMs))
        await this.remove(name)
    }
  }
  /** Worker-owned retention lifecycle; daemon reads never start a collector. */
  start(): () => void {
    let stopped = false
    let pending = false
    const collect = () => {
      if (stopped || pending) return
      pending = true
      void this.serial(async () => {
        if (!stopped) await this.gc()
      })
        .catch(() => undefined)
        .finally(() => {
          pending = false
        })
    }
    collect()
    const timer = setInterval(collect, 5 * 60 * 1000)
    timer.unref()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }
  async begin(
    request: RequestBody,
    adapter: ModelRequestAttempt['adapter'] = {
      id: 'unknown',
      version: null,
      api: 'unknown',
      endpoint: null,
    },
  ): Promise<ModelRequestTraceHandle> {
    const id = randomUUID()
    const safe = redactRequest(request) as unknown as RequestBody
    const initialText = JSON.stringify(safe)
    let row: CallRecord | undefined
    const fallbackId = randomUUID()
    const makeAttempt = (event: ModelAdapterAttemptObservation): StoredAttempt => ({
      attemptId: event.attemptId,
      parentCallId: id,
      index: event.index,
      adapter: { ...event.adapter, endpoint: safeEndpoint(event.adapter.endpoint) },
      status: event.status,
      wireUnavailable: 'adapter-no-tap',
      promptHash: null,
      toolSchemaHash: null,
      providerActualTokens: event.providerActualTokens ?? null,
      estimatedTokens: null,
      response: event.response ?? {},
    })
    const persist = async (value: CallRecord) => {
      const { sessionHash: _owner, wireHash: _wire, wireRefs: _refs, attempts, ...record } = value
      const snapshot = {
        ...record,
        system: safe.system,
        sections: safe.sections ?? [],
        tools: safe.tools,
        wire: null,
        attempts: attempts.map(({ wireHash: _wire, wireRefs: _refs, ...attempt }) => ({
          ...attempt,
          wire: null,
        })),
      }
      if (!validateAgainst(SnapshotSchema, snapshot).ok) throw new Error('CAPTURE_LIMIT')
      await this.write(join(this.dir, `${id}.call.json`), value)
    }
    const captureBytes = Buffer.byteLength(initialText)
    let capturedWireBytes = 0
    if (captureBytes + 1024 <= this.limits.callBytes)
      try {
        await this.serial(async () => {
          await mkdir(this.dir, { recursive: true, mode: 0o700 })
          await this.gc()
          const memory = (safe.sections ?? []).filter(
            (section) => /memory/i.test(section.id) || /memory/i.test(section.source),
          )
          row = {
            id,
            generationId: this.context?.(request.sessionKey).generationId ?? null,
            promptHash: digest(JSON.stringify(safe.system)),
            toolSchemaHash: digest(JSON.stringify(safe.tools)),
            memoryRevision: safe.traceContext?.memoryRevision ?? null,
            memoryHash: memory.length ? digest(JSON.stringify(memory)) : null,
            compactionBoundary: safe.traceContext?.compactionBoundary ?? null,
            messagesHash: digest(JSON.stringify(safe.messages)),
            sourceHashes: (safe.sections ?? []).map((section) => ({
              id: section.id,
              source: section.source,
              hash: digest(JSON.stringify(section.text)),
            })),
            hashBasis: 'redacted-json',
            incomplete: initialText.includes('[OMITTED:'),
            wireUnavailable: 'adapter-no-tap',
            tokens: {
              providerActual: null,
              estimated: { input: Math.ceil(captureBytes / 4), method: 'serialized-utf8-bytes/4' },
            },
            attempts: [makeAttempt({ attemptId: fallbackId, index: 0, adapter, status: 'unknown' })],
            createdAt: new Date(this.clock()).toISOString(),
            sessionHash: digest(request.sessionKey),
            derivedHash: request.derivedHash,
            systemHash: await this.blob(safe.system),
            toolsHash: await this.blob(safe.tools),
            sectionsHash: await this.blob(safe.sections ?? []),
            messages: safe.messages as unknown as JsonValue,
            params: redactRequest({
              kind: safe.slot === 'compaction' ? 'compaction' : safe.kind,
              slot: safe.slot,
              route: safe.route,
              model: safe.model,
              sampling: safe.sampling,
              timeoutMs: safe.timeoutMs,
            }),
            response: {},
            capture: 'logical-request',
            redacted: initialText !== JSON.stringify(request),
          }
          await persist(row)
          await this.gc()
        })
      } catch (error) {
        if ((error as Error).message !== 'CAPTURE_LIMIT') throw error
        row = undefined
      }
    const flush = async () => {
      const current = row
      if (!current) return
      try {
        await this.serial(async () => {
          // Retention may evict an in-flight record; a late response must not resurrect it.
          try {
            await stat(join(this.dir, `${id}.call.json`))
          } catch {
            return
          }
          await persist(current)
          await this.gc()
        })
      } catch (error) {
        if ((error as Error).message !== 'CAPTURE_LIMIT') throw error
        await this.serial(() => this.remove(`${id}.call.json`).catch(() => undefined))
        row = undefined
      }
    }
    const metadataBytes = Math.max(0, Math.min(64 * 1024, this.limits.callBytes - captureBytes - 1024))
    return {
      id,
      attempt: async (event) => {
        if (!row) return
        const safeEvent = redactRequest(event) as unknown as ModelAdapterAttemptObservation
        const candidate = makeAttempt(safeEvent)
        if (
          Buffer.byteLength(JSON.stringify(safeEvent)) > metadataBytes ||
          !validateAgainst(AttemptSchema, { ...candidate, wire: null }).ok
        ) {
          row.incomplete = true
          return
        }
        row.redacted ||= JSON.stringify(safeEvent) !== JSON.stringify(event)
        let current = row.attempts.find((attempt) => attempt.attemptId === safeEvent.attemptId)
        if (!current) {
          if (
            row.attempts.length === 1 &&
            row.attempts[0]?.attemptId === fallbackId &&
            row.attempts[0]?.status === 'unknown'
          )
            row.attempts = []
          if (row.attempts.length >= 32) {
            row.incomplete = true
            return
          }
          current = makeAttempt(safeEvent)
          row.attempts.push(current)
        }
        current.status = safeEvent.status
        current.adapter = { ...safeEvent.adapter, endpoint: safeEndpoint(safeEvent.adapter.endpoint) }
        if (safeEvent.providerActualTokens) {
          current.providerActualTokens = safeEvent.providerActualTokens
          row.tokens.providerActual = row.attempts
            .filter((attempt) => attempt.providerActualTokens !== null)
            .map((attempt) => ({ attemptId: attempt.attemptId, tokens: attempt.providerActualTokens }))
        }
        if (safeEvent.response) current.response = safeEvent.response
        await flush()
      },
      wire: async (body, attemptId) => {
        if (!row) return
        const safeBody = redactRequest(body)
        const wireBytes = Buffer.byteLength(JSON.stringify(safeBody))
        if (captureBytes + capturedWireBytes + wireBytes + 64 * 1024 > this.limits.callBytes) {
          row.incomplete = true
          row.wireUnavailable = 'capture-limit'
          const attempt = row.attempts.find((value) => value.attemptId === (attemptId ?? fallbackId))
          if (attempt) attempt.wireUnavailable = 'capture-limit'
          await flush()
          return
        }
        try {
          await this.serial(async () => {
            if (!row) return
            try {
              await stat(join(this.dir, `${id}.call.json`))
            } catch {
              return
            }
            const refs = new Set<string>()
            const pack = async (value: JsonValue, key = ''): Promise<JsonValue> => {
              if (
                key === 'tools' ||
                key === 'system' ||
                (typeof value === 'string' && value === safe.system)
              ) {
                const hash = await this.blob(value)
                refs.add(hash)
                return ['ref', hash]
              }
              if (Array.isArray(value)) return ['array', await settled(value.map((item) => pack(item)))]
              if (value && typeof value === 'object')
                return [
                  'object',
                  await settled(
                    Object.entries(value).map(async ([name, child]) => [name, await pack(child, name)]),
                  ),
                ]
              return ['value', value]
            }
            const current = row.attempts.find((attempt) => attempt.attemptId === (attemptId ?? fallbackId))
            if (!current) {
              row.incomplete = true
              return
            }
            current.wireHash = await this.blob(await pack(safeBody))
            current.wireRefs = [...refs]
            current.status = 'sent'
            capturedWireBytes += wireBytes
            current.estimatedTokens = { input: Math.ceil(wireBytes / 4), method: 'serialized-utf8-bytes/4' }
            current.wireUnavailable = null
            const object =
              safeBody && typeof safeBody === 'object' && !Array.isArray(safeBody) ? safeBody : {}
            const prompt =
              object.instructions ??
              object.system ??
              (Array.isArray(object.messages)
                ? object.messages.filter(
                    (message) =>
                      message &&
                      typeof message === 'object' &&
                      !Array.isArray(message) &&
                      (message.role === 'system' || message.role === 'developer'),
                  )
                : null)
            current.promptHash = prompt === null ? null : digest(JSON.stringify(prompt))
            current.toolSchemaHash = digest(JSON.stringify(object.tools ?? null))
            row.wireHash = current.wireHash
            row.wireRefs = [...refs]
            row.capture = 'final-provider-body'
            row.wireUnavailable = null
            row.incomplete ||= JSON.stringify(safeBody).includes('[OMITTED:')
            row.redacted ||= JSON.stringify(safeBody) !== JSON.stringify(body)
            await persist(row)
            await this.gc()
          })
        } catch (error) {
          if ((error as Error).message !== 'CAPTURE_LIMIT') throw error
          // A profile cap must not leave a retained logical row claiming its adapter has no tap.
          // Recent orphan blobs remain subject to TTL; no late attempt may resurrect this call.
          await this.serial(() => this.remove(`${id}.call.json`).catch(() => undefined))
          row = undefined
        }
      },
      event(event) {
        if (!row || !event || typeof event !== 'object') return
        if (Buffer.byteLength(JSON.stringify(redactRequest(event))) > metadataBytes) {
          row.incomplete = true
          return
        }
        const ev = event as {
          type?: string
          tokens?: unknown
          response?: unknown
          code?: unknown
          reason?: unknown
        }
        if (ev.type === 'usage')
          row.response = redactRequest({
            ...(row.response as object),
            tokens: ev.tokens,
            metadata: ev.response,
          })
        if (ev.type === 'done' || ev.type === 'error') {
          const fallback = row.attempts.find((attempt) => attempt.attemptId === fallbackId)
          if (fallback && (fallback.status === 'sent' || ev.type === 'error'))
            fallback.status =
              ev.type === 'done' ? 'completed' : ev.reason === 'aborted' ? 'cancelled' : 'failed'
          row.response = redactRequest({
            ...(row.response as object),
            status: ev.type,
            code: ev.code,
            reason: ev.reason,
          })
        }
      },
      finish: flush,
    }
  }
  async clear(sessionKey: string, callId: string): Promise<boolean> {
    if (!/^[a-f0-9-]{36}$/.test(callId)) return false
    return this.serial(async () => {
      const records = this.records()
      const row = records.find((value) => value.id === callId && value.sessionHash === digest(sessionKey))
      if (!row) return false
      await this.remove(`${row.id}.call.json`)
      const retained = references(records.filter((value) => value.id !== callId))
      for (const hash of row.refs)
        if (!retained.has(hash)) await this.remove(`${hash}.blob.json`).catch(() => undefined)
      return true
    })
  }
  /** Metadata only: no prompt, response, wire body or blob hydration for graph navigation. */
  async metadata(
    sessionKey: string,
    callId: string,
  ): Promise<{
    request: Extract<import('@agnes/protocol').FactChainNode, { kind: 'request' }>
    attempts: Extract<import('@agnes/protocol').FactChainNode, { kind: 'attempt' }>[]
  } | null> {
    if (!/^[a-f0-9-]{36}$/.test(callId)) return null
    return this.serial(async () => {
      const indexed = this.records().find(
        (value) =>
          value.id === callId &&
          value.sessionHash === digest(sessionKey) &&
          this.clock() - Date.parse(value.createdAt) <= this.limits.ttlMs,
      )
      if (!indexed) return null
      const row = await this.readRecord(indexed.id)
      if (!row || row.sessionHash !== digest(sessionKey)) return null
      const params =
        row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? row.params : {}
      return {
        request: {
          id: `request:${row.id}`,
          kind: 'request',
          callId: row.id,
          seq: null,
          model: String(params.model ?? '').slice(0, 512),
          generationId: row.generationId,
          derivedHash: row.derivedHash,
          promptHash: row.promptHash,
          toolSchemaHash: row.toolSchemaHash,
          messagesHash: row.messagesHash,
          memoryRevision: row.memoryRevision,
          memoryHash: row.memoryHash,
          hashBasis: 'redacted-json',
          incomplete: row.incomplete,
        },
        attempts: (row.attempts ?? []).slice(0, 32).map((attempt) => ({
          id: `attempt:${attempt.attemptId}`,
          kind: 'attempt',
          attemptId: attempt.attemptId,
          parentCallId: attempt.parentCallId,
          index: attempt.index,
          adapterId: attempt.adapter.id,
          status: attempt.status,
          wireUnavailable: attempt.wireUnavailable,
        })),
      }
    })
  }
  async get(sessionKey: string, callId?: string): Promise<import('@agnes/protocol').ModelRequestResult> {
    if (callId && !/^[a-f0-9-]{36}$/.test(callId))
      return { snapshot: null, previous: null, unavailable: 'not-retained' }
    return this.serial(async () => {
      // Reads never collect: the daemon reader may race the worker writer in another process.
      const records = this.records().filter(
        (row) =>
          row.sessionHash === digest(sessionKey) &&
          this.clock() - Date.parse(row.createdAt) <= this.limits.ttlMs,
      )
      if (!callId)
        return {
          snapshot: null,
          previous: null,
          calls: records.slice(-256).map((row) => ({
            id: row.id,
            createdAt: row.createdAt,
            ...row.params,
          })),
        }
      const index = records.findIndex((row) => row.id === callId)
      if (index < 0) return { snapshot: null, previous: null, unavailable: 'not-retained' }
      const hydrate = async (entry: IndexedCall | undefined): Promise<ModelRequestSnapshot> => {
        const row = entry && (await this.readRecord(entry.id))
        if (!row || row.sessionHash !== digest(sessionKey)) throw new Error('Invalid record')
        const { sessionHash: _owner, wireHash, wireRefs: _refs, attempts, ...record } = row
        const unpack = async (encoded: JsonValue, depth = 0): Promise<JsonValue> => {
          if (depth > 64 || !Array.isArray(encoded)) throw new Error('Invalid wire content')
          const [tag, content] = encoded
          if (tag === 'ref' && typeof content === 'string') return this.readBlob(content)
          if (tag === 'value') return content ?? null
          if (tag === 'array' && Array.isArray(content))
            return Promise.all(content.map((item) => unpack(item, depth + 1)))
          if (tag === 'object' && Array.isArray(content))
            return Object.fromEntries(
              await settled(
                content.map(async (item) => {
                  if (!Array.isArray(item) || typeof item[0] !== 'string' || item.length !== 2)
                    throw new Error('Invalid wire entry')
                  return [item[0], await unpack(item[1]!, depth + 1)]
                }),
              ),
            )
          throw new Error('Invalid wire tag')
        }
        const value = {
          ...record,
          system: await this.readBlob(row.systemHash),
          tools: await this.readBlob(row.toolsHash),
          sections: await this.readBlob(row.sectionsHash),
          wire: wireHash ? await unpack(await this.readBlob(wireHash)) : null,
          attempts: await settled(
            attempts.map(async ({ wireHash, wireRefs: _refs, ...attempt }) => ({
              ...attempt,
              wire: wireHash ? await unpack(await this.readBlob(wireHash)) : null,
            })),
          ),
        }
        if (!validateAgainst(SnapshotSchema, value).ok) throw new Error('Invalid snapshot')
        return value as ModelRequestSnapshot
      }
      try {
        return {
          snapshot: await hydrate(records[index]),
          previous: index ? await hydrate(records[index - 1]) : null,
        }
      } catch {
        return { snapshot: null, previous: null, unavailable: 'capture-failed' }
      }
    })
  }
}

function safeEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null
  try {
    const url = new URL(endpoint)
    return String(redactRequest(`${url.origin}${url.pathname}`)).slice(0, 1024)
  } catch {
    return null
  }
}
