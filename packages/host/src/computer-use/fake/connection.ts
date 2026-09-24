import { randomUUID } from 'node:crypto'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import { baseEnvironment } from '../../adapters/exec.js'
import { type OwnedFakeProcess, startOwnedFakeProcess } from './owned-process.js'
import type {
  ComputerUseResetReason,
  DriverCallResult,
  DriverCloseEvent,
  DriverCloseReason,
  DriverContent,
  DriverToolContract,
  FakeComputerUseDriverConnection,
  FakeDriverCommand,
} from './types.js'

// A permitted 4 MiB decoded screenshot expands to about 5.34 MiB of base64 before JSON and the
// accessibility tree are added. One MiB made the real locked driver unusable despite passing every
// tiny fake fixture. Keep this transport ceiling above the product image cap; image decoding still
// enforces the tighter 4 MiB/1456px limits before artifact storage.
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_BUFFERED_BYTES = 2 * MAX_FRAME_BYTES
const DEFAULT_STARTUP_TIMEOUT_MS = 2_000
const DEFAULT_CLOSE_GRACE_MS = 100

type JsonObject = Record<string, unknown>
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

function record(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function protocol(message: string): Error {
  return new Error(`fake Computer Use protocol error: ${message}`)
}

function finiteTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('timeoutMs must be a positive integer')
  return value
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

class Catalog implements ReadonlyMap<string, DriverToolContract> {
  readonly #entries: Map<string, DriverToolContract>

  constructor(entries: Iterable<readonly [string, DriverToolContract]>) {
    this.#entries = new Map(entries)
    Object.freeze(this)
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: string): DriverToolContract | undefined {
    return this.#entries.get(key)
  }

  has(key: string): boolean {
    return this.#entries.has(key)
  }

  entries(): MapIterator<[string, DriverToolContract]> {
    return this.#entries.entries()
  }

  keys(): MapIterator<string> {
    return this.#entries.keys()
  }

  values(): MapIterator<DriverToolContract> {
    return this.#entries.values()
  }

  forEach(
    callbackfn: (
      value: DriverToolContract,
      key: string,
      map: ReadonlyMap<string, DriverToolContract>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[string, DriverToolContract]> {
    return this.entries()
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlyMap'
  }
}

function parseInitialize(value: unknown): string | undefined {
  if (!record(value)) throw protocol('initialize result must be an object')
  if (!record(value.capabilities) || !record(value.capabilities.tools))
    throw protocol('initialize result lacks tools capability')
  if (value.capabilityVersion === undefined) return undefined
  if (typeof value.capabilityVersion !== 'string' || value.capabilityVersion.length === 0)
    throw protocol('initialize result has an invalid capabilityVersion')
  return value.capabilityVersion
}

function parseCatalog(
  value: unknown,
  initializeCapabilityVersion: string | undefined,
): Readonly<{ capabilityVersion: string; catalog: ReadonlyMap<string, DriverToolContract> }> {
  if (!record(value) || !Array.isArray(value.tools)) throw protocol('tools/list result lacks tools')
  const listedVersion = value.capability_version ?? value.capabilityVersion
  const capabilityVersion =
    typeof listedVersion === 'string' && listedVersion.length > 0
      ? listedVersion
      : initializeCapabilityVersion
  if (!capabilityVersion) throw protocol('tools/list result lacks capability version')
  if (initializeCapabilityVersion && capabilityVersion !== initializeCapabilityVersion)
    throw protocol('tools/list capability version drifted from initialize')
  const entries: Array<readonly [string, DriverToolContract]> = []
  const names = new Set<string>()
  for (const raw of value.tools) {
    if (!record(raw) || typeof raw.name !== 'string' || raw.name.length === 0)
      throw protocol('catalog tool has invalid name')
    if (names.has(raw.name)) throw protocol(`catalog has duplicate tool ${raw.name}`)
    names.add(raw.name)
    const schema = inspectJsonData(raw.inputSchema, MAX_FRAME_BYTES)
    if (!schema.ok || !record(schema.value))
      throw protocol(`catalog tool ${raw.name} has invalid inputSchema`)
    if (
      !Array.isArray(raw.capabilities) ||
      raw.capabilities.some((capability) => typeof capability !== 'string' || capability.length === 0)
    )
      throw protocol(`catalog tool ${raw.name} has invalid capabilities`)
    if (raw.capabilityVersion !== undefined && raw.capabilityVersion !== capabilityVersion)
      throw protocol(`catalog tool ${raw.name} capabilityVersion drifted`)
    const contract = Object.freeze({
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      inputSchema: deepFreeze(schema.value),
      capabilities: Object.freeze([...raw.capabilities] as string[]),
      capabilityVersion,
    })
    entries.push([raw.name, contract])
  }
  return Object.freeze({ capabilityVersion, catalog: new Catalog(entries) })
}

function parseContent(value: unknown): DriverContent {
  if (!record(value)) throw protocol('tool content must be an object')
  if (value.type === 'text' && typeof value.text === 'string')
    return Object.freeze({ type: 'text' as const, text: value.text })
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string')
    return Object.freeze({ type: 'image' as const, data: value.data, mimeType: value.mimeType })
  throw protocol(`unsupported tool content ${String(value.type)}`)
}

function parseCallResult(value: unknown): DriverCallResult {
  if (!record(value) || !Array.isArray(value.content)) throw protocol('tools/call result lacks content')
  if (value.isError !== undefined && typeof value.isError !== 'boolean')
    throw protocol('tools/call isError must be boolean')
  let structuredContent: JsonValue | undefined
  if (value.structuredContent !== undefined) {
    const checked = inspectJsonData(value.structuredContent, MAX_FRAME_BYTES)
    if (!checked.ok) throw protocol('tools/call structuredContent is not bounded JSON')
    structuredContent = deepFreeze(checked.value)
  }
  const content = Object.freeze(value.content.map(parseContent))
  return Object.freeze({
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: value.isError === true,
  })
}

function waitForExit(child: OwnedFakeProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void child.completion.then(() => finish(true))
  })
}

function waitForCompletion(
  child: OwnedFakeProcess,
  timeoutMs: number,
): Promise<Readonly<{ error?: Error }> | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Readonly<{ error?: Error }> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    void child.completion.then(finish)
  })
}

export async function closeOwnedFakeProcess(child: OwnedFakeProcess, closeGraceMs: number): Promise<void> {
  const failures: unknown[] = []
  const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }

  await attempt(() => child.captureDescendants())
  try {
    if (!child.stdin.destroyed) child.stdin.end()
  } catch (error) {
    failures.push(error)
  }
  await waitForExit(child, closeGraceMs)
  // Cleanup is deliberately best-effort across phases. A failed process-table snapshot must not
  // prevent either root signal, and every failure remains visible to the lifecycle caller.
  await attempt(() => child.terminate('SIGTERM'))
  await waitForExit(child, closeGraceMs)
  await attempt(() => child.terminate('SIGKILL'))
  let exited = false
  await attempt(async () => {
    exited = await child.waitForTreeExit(2_000)
  })
  if (!exited) failures.push(new Error('fake Computer Use child tree cleanup timed out'))
  // A broken owner may never deliver its completion promise. When the tree is not known gone there
  // is nothing safe to await; when it is gone, allow only a short bounded event-loop handoff.
  if (exited) {
    const completion = await waitForCompletion(child, Math.max(1, closeGraceMs))
    if (!completion) failures.push(new Error('fake Computer Use child completion timed out'))
    else if (completion.error)
      failures.push(new Error('fake Computer Use child cleanup failed', { cause: completion.error }))
  }
  if (failures.length) throw new AggregateError(failures, 'fake Computer Use child cleanup failed')
}

class Connection implements FakeComputerUseDriverConnection {
  readonly generation: number
  readonly pid: number
  readonly transportId = randomUUID()
  capabilityVersion = ''
  catalog: ReadonlyMap<string, DriverToolContract> = new Catalog([])
  readonly #child: OwnedFakeProcess
  readonly #closeGraceMs: number
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<(event: DriverCloseEvent) => void>()
  #nextId = 0
  #chunks: string[] = []
  #bufferedBytes = 0
  #state: 'open' | 'closing' | 'closed' = 'open'
  #terminalError: Error | undefined
  #closeEvent: DriverCloseEvent | undefined
  #closeTask: Promise<void> | undefined
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(child: OwnedFakeProcess, command: FakeDriverCommand, generation: number) {
    this.generation = generation
    this.#closeGraceMs = command.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    this.pid = child.pid
    this.#child = child
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.#onData(this.#decoder.decode(chunk, { stream: true }))
      } catch {
        this.#fail(protocol('invalid UTF-8 frame'), 'protocol_error')
      }
    })
    child.stdout.on('end', () => {
      if (this.#state !== 'open') return
      try {
        const tail = this.#decoder.decode()
        if (tail) this.#onData(tail)
      } catch {
        this.#fail(protocol('invalid UTF-8 frame'), 'protocol_error')
        return
      }
      if (this.#state === 'open') this.#fail(new Error('fake Computer Use child reached EOF'), 'eof')
    })
    child.stderr.resume()
    child.stdin.on('error', (error) => this.#fail(error, 'driver_exit'))
    void child.completion.then((result) => {
      if (this.#state === 'open')
        this.#fail(result.error ?? new Error('fake Computer Use child exited'), 'driver_exit')
    })
  }

  async initialize(signal: AbortSignal, startupTimeoutMs: number): Promise<void> {
    const initialized = await this.#request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agnes-computer-use-fake', version: '0.0.0' },
      },
      { timeoutMs: startupTimeoutMs, signal },
    )
    const initializedCapabilityVersion = parseInitialize(initialized)
    this.#notify('notifications/initialized', {})
    const listed = parseCatalog(
      await this.#request('tools/list', {}, { timeoutMs: startupTimeoutMs, signal }),
      initializedCapabilityVersion,
    )
    this.capabilityVersion = listed.capabilityVersion
    this.catalog = listed.catalog
  }

  async call(
    name: string,
    args: JsonValue,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<DriverCallResult> {
    if (!this.catalog.has(name)) throw new Error(`fake Computer Use catalog has no tool ${name}`)
    const checked = inspectJsonData(args, MAX_FRAME_BYTES)
    if (!checked.ok) throw new TypeError('fake Computer Use arguments are not bounded JSON')
    const value = await this.#request(
      'tools/call',
      { name, arguments: checked.value },
      { timeoutMs: finiteTimeout(options.timeoutMs), signal: options.signal },
    )
    try {
      return parseCallResult(value)
    } catch (error) {
      this.#fail(error instanceof Error ? error : protocol('invalid tools/call result'), 'protocol_error')
      throw error
    }
  }

  onClose(listener: (event: DriverCloseEvent) => void): () => void {
    if (this.#closeEvent) {
      const event = this.#closeEvent
      queueMicrotask(() => {
        try {
          listener(event)
        } catch {
          // A late observer cannot affect an already completed close.
        }
      })
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(_reason: string): Promise<void> {
    return this.closeForReset(undefined)
  }

  closeForReset(resetReason: ComputerUseResetReason | undefined): Promise<void> {
    return this.#beginClose({
      generation: this.generation,
      reason: 'closed',
      ...(resetReason ? { resetReason } : {}),
    })
  }

  cancelFromSession(): Promise<void> {
    return this.#beginClose({ generation: this.generation, reason: 'cancel', resetReason: 'cancel' })
  }

  #notify(method: string, params: JsonValue): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  #request(
    method: string,
    params: JsonValue,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.#state !== 'open')
      return Promise.reject(this.#terminalError ?? new Error('fake runtime is closed'))
    if (options.signal?.aborted) {
      void this.#beginClose({ generation: this.generation, reason: 'cancel', resetReason: 'cancel' })
      return Promise.reject(abortError('fake Computer Use request cancelled'))
    }
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const onAbort = options.signal
        ? () => {
            this.#fail(abortError('fake Computer Use request cancelled'), 'cancel', 'cancel')
          }
        : undefined
      const timer = setTimeout(() => {
        this.#fail(new Error(`fake Computer Use ${method} timed out`), 'timeout', 'transport_suspect')
      }, finiteTimeout(options.timeoutMs))
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })
      options.signal?.addEventListener('abort', onAbort as () => void, { once: true })
      try {
        this.#send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#fail(
          error instanceof Error ? error : new Error('fake Computer Use write failed'),
          'protocol_error',
        )
      }
    })
  }

  #send(message: JsonObject): void {
    if (this.#state !== 'open' || this.#child.stdin.destroyed)
      throw this.#terminalError ?? new Error('fake runtime is closed')
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw protocol('outbound frame exceeds 8 MiB')
    if (this.#child.stdin.writableLength + Buffer.byteLength(line) > MAX_BUFFERED_BYTES)
      throw protocol('outbound queue exceeds 16 MiB')
    this.#child.stdin.write(line, (error) => {
      if (error) this.#fail(error, 'driver_exit')
    })
  }

  #onData(chunk: string): void {
    if (this.#state !== 'open') return
    const incoming = Buffer.byteLength(chunk)
    if (this.#bufferedBytes + incoming > MAX_BUFFERED_BYTES) {
      this.#chunks = []
      this.#bufferedBytes = 0
      this.#fail(protocol('inbound buffer exceeds 16 MiB'), 'protocol_error')
      return
    }
    this.#chunks.push(chunk)
    this.#bufferedBytes += incoming
    if (!chunk.includes('\n')) return
    let rest = this.#chunks.join('')
    this.#chunks = []
    this.#bufferedBytes = 0
    for (;;) {
      const end = rest.indexOf('\n')
      if (end < 0) {
        if (rest.length > 0) {
          this.#chunks = [rest]
          this.#bufferedBytes = Buffer.byteLength(rest)
        }
        return
      }
      const line = rest.slice(0, end)
      rest = rest.slice(end + 1)
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.#fail(protocol('inbound frame exceeds 8 MiB'), 'protocol_error')
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.#fail(protocol('invalid JSON frame'), 'protocol_error')
        return
      }
      if (!record(message) || message.jsonrpc !== '2.0') {
        this.#fail(protocol('invalid JSON-RPC envelope'), 'protocol_error')
        return
      }
      if (message.method === 'notifications/tools/list_changed' && message.id === undefined) {
        this.#fail(protocol('catalog drift notification'), 'protocol_error')
        return
      }
      if (message.id === undefined) continue
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
        this.#fail(protocol('invalid response id'), 'protocol_error')
        return
      }
      const pending = this.#pending.get(message.id)
      if (!pending) {
        this.#fail(protocol('response id is not pending'), 'protocol_error')
        return
      }
      this.#pending.delete(message.id)
      this.#clearPending(pending)
      if (Object.hasOwn(message, 'error') && Object.hasOwn(message, 'result')) {
        const error = protocol('response has both result and error')
        pending.reject(error)
        this.#fail(error, 'protocol_error')
        return
      }
      if (message.error !== undefined)
        pending.reject(protocol(`driver returned JSON-RPC error for ${message.id}`))
      else if (!Object.hasOwn(message, 'result')) {
        const error = protocol('response lacks result')
        pending.reject(error)
        this.#fail(error, 'protocol_error')
        return
      } else pending.resolve(message.result)
    }
  }

  #clearPending(pending: Pending): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
  }

  #fail(
    error: Error,
    reason: DriverCloseReason,
    resetReason: ComputerUseResetReason = 'transport_suspect',
  ): void {
    if (this.#state !== 'open') return
    this.#terminalError = error
    for (const pending of this.#pending.values()) {
      this.#clearPending(pending)
      pending.reject(error)
    }
    this.#pending.clear()
    void this.#beginClose({ generation: this.generation, reason, resetReason })
  }

  #beginClose(event: DriverCloseEvent): Promise<void> {
    if (this.#closeTask) return this.#closeTask
    this.#state = 'closing'
    for (const pending of this.#pending.values()) {
      this.#clearPending(pending)
      pending.reject(this.#terminalError ?? new Error('fake Computer Use runtime closed'))
    }
    this.#pending.clear()
    this.#closeTask = (async () => {
      await closeOwnedFakeProcess(this.#child, this.#closeGraceMs)
      this.#state = 'closed'
      this.#closeEvent = event
      for (const listener of [...this.#listeners]) {
        try {
          listener(event)
        } catch {
          // Lifecycle cleanup must not depend on observer behavior.
        }
      }
      this.#listeners.clear()
    })()
    // Transport failures and abort listeners initiate cleanup without an awaiting caller. Mark the
    // shared task handled here while preserving its rejection for later explicit close/dispose.
    void this.#closeTask.catch((error) => {
      this.#terminalError = error instanceof Error ? error : new Error('fake runtime cleanup failed')
    })
    return this.#closeTask
  }
}

export async function connectFakeComputerUseDriver(
  command: FakeDriverCommand,
  generation: number,
  sessionToken: string,
  signal: AbortSignal,
): Promise<Connection> {
  const child = await startOwnedFakeProcess(
    command.command,
    command.args ?? [],
    {
      ...baseEnvironment(),
      ...command.env,
      AGNES_CUA_FAKE_SESSION: sessionToken,
    },
    signal,
  )
  const connection = new Connection(child, command, generation)
  try {
    await connection.initialize(signal, command.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    return connection
  } catch (error) {
    await connection.closeForReset(signal.aborted ? 'cancel' : 'transport_suspect')
    throw error
  }
}

/** Production-neutral entry point for the locked driver. */
export const connectComputerUseDriver = connectFakeComputerUseDriver
