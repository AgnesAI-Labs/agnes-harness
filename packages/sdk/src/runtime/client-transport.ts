// The client side of the runtime client wire: bootstrap, the complete module catalog, and
// validated HTTP calls. Routes, limits and per-operation metadata come from the generated
// protocol tables; nothing here restates them. A command leaves this client only while the
// catalog is complete and current, and a command carrying a business id is journaled before
// its first byte is sent. Nothing is ever resent automatically.
import { jcs } from '@agnes/protocol'
import {
  type ClientBootstrapRejected,
  type ClientCallHeader,
  type ClientCatalogPageResult,
  type ClientHello,
  type ClientJsonOperation,
  type ClientModule,
  type ClientOperationTypes,
  type ClientWelcome,
  RuntimeClientOperations,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  type RuntimeError,
  RuntimeSchemas,
  runtimeErrorHttpStatus,
  type SchemaRef,
  utf8ByteLength,
  validateClientBootstrap,
  validateClientCatalogPage,
  validateClientCommandRequest,
  validateClientQueryRequest,
  validateClientReply,
  validateClientTransportFrame,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import { ProtocolViolation } from '../errors.js'
import { type JournalStore, randomId } from '../journal.js'

const { routes } = RuntimeClientTransportWire

/** The journal key pending runtime commands live under; their entry id is the business id. */
export const RUNTIME_JOURNAL_KEY = 'agh.runtime.client'

export type RuntimeFetch = (url: string, init: RequestInit) => Promise<Response>
export type RuntimeClientOptions = {
  /** Deployment origin plus its mount prefix; the generated route paths are appended to it. */
  baseUrl: string
  hello: ClientHello
  journal: JournalStore
  /** Sent as `Authorization: Bearer`. A browser leaves it out and relies on its session cookie. */
  credential?: string
  fetch?: RuntimeFetch
}
export type RuntimeClientMode = 'disconnected' | ClientWelcome['mode']
export type LocalRefusal =
  | 'disconnected'
  | 'incompatible'
  | 'reload-required'
  | 'catalog-incomplete'
  | 'not-negotiated'
  | 'invalid-request'
  | 'identity-conflict'
/** `refused` never left this client; `unknown` was sent but has no current, verified reply. */
export type CallResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'failed'; error: RuntimeError }
  | { state: 'refused'; reason: LocalRefusal }
  | { state: 'unknown'; reason: string }
export type RecoveryReport = { id: string; operation: string; state: 'accepted' | 'not-accepted' | 'unknown' }
type Outcome = { ok: true; value: unknown } | { ok: false; error: RuntimeError }
type Session = {
  welcome: ClientWelcome
  base: Omit<ClientCallHeader, 'callId'>
  modules: Map<string, ClientModule>
  schemas: Map<string, SchemaRef>
  complete: boolean
}

// Typed refusals returned before admission. Every other failure code may hide an effect, so a
// journaled command stays pending until its owner's status says otherwise.
const refusedCodes = new Set<string>(['invalid_input', 'denied', 'incompatible', 'quota', 'conflict'])
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const admitted = (value: unknown) => !(record(value) && value.status === 'not-accepted')

/** A locally detected failure in the registered classification, so callers handle one error shape. */
export function localRuntimeError(
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
): RuntimeError {
  return { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: randomId() }
}

/** One HTTP Outcome: a 200 success, or a typed failure sent with its registered HTTP status. */
export async function readOutcome(response: Response): Promise<Outcome | null> {
  let body: unknown
  try {
    const text = await response.text()
    if (!utf8ByteLength(text, RuntimeClientTransportPolicy.maxJsonBytes).ok) return null
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!record(body)) return null
  const keys = Object.keys(body).sort().join(',')
  if (body.ok === true && keys === 'ok,value' && response.status === 200)
    return { ok: true, value: body.value }
  if (body.ok !== false || keys !== 'error,ok') return null
  const error = validateRuntimeErrorDetail(body.error)
  return error.ok && runtimeErrorHttpStatus(error.value) === response.status
    ? { ok: false, error: error.value }
    : null
}

/** The welcome supplies every header field but callId; one this client cannot speak yields none. */
function headerBase(welcome: ClientWelcome): Session['base'] | null {
  if (welcome.mode === 'incompatible' || welcome.wireVersion.major !== RuntimeClientTransportWire.wireMajor)
    return null
  const { negotiatedSession, clientInstanceId, catalogRevision } = welcome
  return { negotiatedSession, clientInstanceId, catalogRevision }
}

/** Pages repeat the schemas their modules need; an id seen twice must name identical content. */
function merge(session: Session, page: Pick<ClientCatalogPageResult, 'modules' | 'domainSchemas'>): boolean {
  const add = <T>(map: Map<string, T>, key: string, value: T) => {
    const seen = map.get(key)
    map.set(key, value)
    return seen === undefined || jcs(seen) === jcs(value)
  }
  return (
    page.modules.every((module) => add(session.modules, module.moduleId, module)) &&
    page.domainSchemas.every((schema) => add(session.schemas, `${schema.typeId}\0${schema.revision}`, schema))
  )
}

/** A status query takes the original id, or a closed object whose fields the original input carries. */
function statusInput(operation: ClientJsonOperation, id: string, input: Record<string, unknown>): unknown {
  const name = RuntimeClientOperations[operation].input
  const schemas = RuntimeSchemas as unknown as Record<
    string,
    { $defs?: Record<string, { required?: string[] }> }
  >
  const required = schemas[name]?.$defs?.[name]?.required
  return required ? Object.fromEntries(required.map((key) => [key, input[key]])) : id
}

export class RuntimeClientTransport {
  /** The last typed refusal from bootstrap or catalog paging, kept for diagnostics and upgrade prompts. */
  refusal: ClientBootstrapRejected | RuntimeError | null = null
  private session: Session | null = null
  private incompatible = false
  private connecting: Promise<void> | null = null
  private readonly base: string
  private readonly fetch: RuntimeFetch

  constructor(private readonly options: RuntimeClientOptions) {
    const url = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new TypeError('invalid runtime base URL')
    this.base = url.href.replace(/\/+$/, '')
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  get mode(): RuntimeClientMode {
    return this.session?.welcome.mode ?? (this.incompatible ? 'incompatible' : 'disconnected')
  }

  get catalog(): { complete: boolean; modules: ClientModule[]; domainSchemas: SchemaRef[] } | null {
    const session = this.session
    return (
      session && {
        complete: session.complete,
        modules: [...session.modules.values()],
        domainSchemas: [...session.schemas.values()],
      }
    )
  }

  /** A fresh call header for the current session, or null when nothing may be read. */
  header(): ClientCallHeader | null {
    return this.session && { ...this.session.base, callId: randomId() }
  }

  /** Bootstrap and read the catalog to completion; concurrent callers share one attempt. */
  connect(): Promise<void> {
    this.connecting ??= this.bootstrap().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** One authenticated POST to a generated route; the artifact reader sends through it too. */
  post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': `${RuntimeClientTransportWire.jsonMime}; charset=utf-8`,
    }
    if (this.options.credential !== undefined) headers.authorization = `Bearer ${this.options.credential}`
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) }
    return this.fetch(this.base + path, signal ? { ...init, signal } : init)
  }

  query<K extends ClientJsonOperation>(
    operation: K,
    input: ClientOperationTypes[K]['input'],
    signal?: AbortSignal,
  ): Promise<CallResult<ClientOperationTypes[K]['output']>> {
    return this.call('query', operation, input, signal) as Promise<
      CallResult<ClientOperationTypes[K]['output']>
    >
  }

  command<K extends ClientJsonOperation>(
    operation: K,
    input: ClientOperationTypes[K]['input'],
    signal?: AbortSignal,
  ): Promise<CallResult<ClientOperationTypes[K]['output']>> {
    return this.call('command', operation, input, signal) as Promise<
      CallResult<ClientOperationTypes[K]['output']>
    >
  }

  /** A catalog-changed frame for the current session drops the catalog and bootstraps again.
   * The push reader's own call id is not tracked yet, so any call id of the current session matches;
   * frames of an older session, and every other kind, are ignored here. */
  handleFrame(value: unknown): Promise<void> {
    const session = this.session
    const callId = record(value) && record(value.header) ? value.header.callId : undefined
    if (!session || typeof callId !== 'string') return Promise.resolve()
    const frame = validateClientTransportFrame({ ...session.base, callId }, value)
    return frame.ok && frame.value.kind === 'catalog-changed' ? this.invalidate() : Promise.resolve()
  }

  /** Asks each pending command's owner by its original id. Only an admitted status clears the entry;
   * `not-accepted` stays pending for the user to resend or drop, and nothing is resent from here. */
  async recover(): Promise<RecoveryReport[]> {
    const reports: RecoveryReport[] = []
    for (const saved of await this.options.journal.pending(RUNTIME_JOURNAL_KEY)) {
      const entry = Object.hasOwn(RuntimeClientOperations, saved.method)
        ? RuntimeClientOperations[saved.method as ClientJsonOperation]
        : undefined
      const field = entry && 'identityField' in entry ? entry.identityField : undefined
      const status = entry && 'statusOperation' in entry ? entry.statusOperation : undefined
      const result =
        status && record(saved.params)
          ? await this.call('query', status, statusInput(status, saved.commandId, saved.params))
          : undefined
      const state =
        result?.state !== 'ok' || !field || !record(result.value) || result.value[field] !== saved.commandId
          ? 'unknown'
          : admitted(result.value)
            ? 'accepted'
            : 'not-accepted'
      if (state === 'accepted') await this.options.journal.clearPending(RUNTIME_JOURNAL_KEY, saved.commandId)
      reports.push({ id: saved.commandId, operation: saved.method, state })
    }
    return reports
  }

  /** Closes writes at once and reads a fresh catalog. Callers on a reply path ignore a failed
   * bootstrap: it leaves the client disconnected, so later calls are refused until connect() works. */
  private invalidate(): Promise<void> {
    this.session = null
    return this.connect()
  }

  private refuse(refusal: ClientBootstrapRejected | RuntimeError): void {
    this.session = null
    this.incompatible = true
    this.refusal = refusal
  }

  private async bootstrap(): Promise<void> {
    // ponytail: three attempts, then stop chasing a catalog that never holds still between pages.
    attempts: for (let attempt = 0; attempt < 3; attempt++) {
      this.session = null
      this.incompatible = false
      const outcome = await readOutcome(await this.post(routes.bootstrap.path, this.options.hello))
      if (!outcome) throw new ProtocolViolation('invalid bootstrap reply')
      // A refusal is final: no retry, and no business call leaves this client.
      if (!outcome.ok) return this.refuse(outcome.error)
      const result = validateClientBootstrap(outcome.value)
      if (!result.ok) throw new ProtocolViolation('invalid bootstrap reply')
      if (!('welcome' in result.value)) return this.refuse(result.value)
      const { welcome, catalogPage } = result.value
      const base = headerBase(welcome)
      if (!base) return this.refuse(localRuntimeError('incompatible', 'unsupported', 'no usable call header'))
      const session: Session = { welcome, base, modules: new Map(), schemas: new Map(), complete: false }
      this.session = session
      this.refusal = null
      let page: Pick<ClientCatalogPageResult, 'modules' | 'domainSchemas' | 'nextCursor' | 'complete'> = {
        ...catalogPage,
        modules: welcome.modules,
        domainSchemas: welcome.domainSchemas,
      }
      for (;;) {
        if (!merge(session, page)) throw new ProtocolViolation('conflicting catalog entries')
        if (page.complete) {
          session.complete = true
          return
        }
        const next = await this.page(session, page.nextCursor)
        if (next === 'changed' || this.session !== session) continue attempts
        if (!next.ok) {
          // A typed failure leaves the catalog incomplete, so writes stay closed.
          this.refusal = next.error
          return
        }
        page = next.value
      }
    }
    this.session = null
    throw new ProtocolViolation('catalog changed on every bootstrap attempt')
  }

  private async page(
    session: Session,
    cursor: string | null,
  ): Promise<'changed' | { ok: true; value: ClientCatalogPageResult } | { ok: false; error: RuntimeError }> {
    const limit = RuntimeClientTransportPolicy.defaultCatalogPageLimit
    const outcome = await readOutcome(
      await this.post(routes.catalogPage.path, { ...session.base, cursor, limit }),
    )
    if (!outcome) throw new ProtocolViolation('invalid catalog page reply')
    if (!outcome.ok) return outcome.error.detailCode === 'catalog_changed' ? 'changed' : outcome
    const page = validateClientCatalogPage(outcome.value, limit)
    if (!page.ok) throw new ProtocolViolation('invalid catalog page')
    return page.value.catalogRevision === session.base.catalogRevision ? page : 'changed'
  }

  private gate(kind: 'query' | 'command', operation: ClientJsonOperation): LocalRefusal | null {
    const session = this.session
    if (!session) return this.incompatible ? 'incompatible' : 'disconnected'
    if (kind === 'query') return null
    if (!session.complete) return 'catalog-incomplete'
    const { mode, capabilities } = session.welcome
    if (mode === 'compatible') return null
    if (mode !== 'degraded') return 'reload-required'
    return capabilities.features.includes(RuntimeClientOperations[operation].requiredFeature)
      ? null
      : 'not-negotiated'
  }

  private async call(
    kind: 'query' | 'command',
    operation: ClientJsonOperation,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CallResult<unknown>> {
    const refusal = this.gate(kind, operation)
    const session = this.session
    if (refusal || !session) return { state: 'refused', reason: refusal ?? 'disconnected' }
    const entry = RuntimeClientOperations[operation]
    const header = { ...session.base, callId: randomId() }
    // Transport management queries repeat the call header inside their input.
    const value = entry.backendContract === 'agh.transport' && record(input) ? { ...input, header } : input
    const request = { header, call: { operation, input: value } }
    const valid =
      kind === 'query' ? validateClientQueryRequest(request) : validateClientCommandRequest(request)
    if (entry.kind !== kind || !valid.ok) return { state: 'refused', reason: 'invalid-request' }

    const journal = this.options.journal
    const id = 'identityField' in entry && record(value) ? value[entry.identityField] : undefined
    if (typeof id === 'string') {
      const saved = (await journal.pending(RUNTIME_JOURNAL_KEY)).find((command) => command.commandId === id)
      if (saved && (saved.method !== operation || jcs(saved.params) !== jcs(value)))
        return { state: 'refused', reason: 'identity-conflict' }
      // Durable before the first byte is sent: a reply lost after this point stays recoverable.
      if (!saved)
        await journal.markPending(RUNTIME_JOURNAL_KEY, { commandId: id, method: operation, params: value })
      if (this.session !== session) {
        if (!saved) await journal.clearPending(RUNTIME_JOURNAL_KEY, id)
        return { state: 'refused', reason: 'disconnected' }
      }
    }

    let outcome: Outcome | null
    try {
      const route = kind === 'query' ? routes.clientQuery : routes.clientCommand
      outcome = await readOutcome(await this.post(route.path, request, signal))
    } catch {
      return { state: 'unknown', reason: 'no reply' }
    }
    // A reply that outlived its session never advances the session that replaced it.
    if (this.session !== session) return { state: 'unknown', reason: 'reply from a replaced session' }
    if (!outcome) return { state: 'unknown', reason: 'invalid reply' }
    if (!outcome.ok) {
      if (outcome.error.detailCode === 'catalog_changed') void this.invalidate().catch(() => undefined)
      if (typeof id === 'string' && refusedCodes.has(outcome.error.code))
        await journal.clearPending(RUNTIME_JOURNAL_KEY, id)
      return { state: 'failed', error: outcome.error }
    }
    const reply = validateClientReply(valid.value, outcome.value)
    if (!reply.ok) return { state: 'unknown', reason: 'reply does not match the call' }
    const result = reply.value.reply.value
    if (typeof id === 'string' && admitted(result)) await journal.clearPending(RUNTIME_JOURNAL_KEY, id)
    if (
      reply.value.reply.operation === 'transport.catalogStatus' &&
      (reply.value.reply.value.catalogRevision !== session.base.catalogRevision ||
        reply.value.reply.value.mode !== session.welcome.mode)
    )
      void this.invalidate().catch(() => undefined)
    return { state: 'ok', value: result }
  }
}
