import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type {
  ActionContext,
  ActionHandlerScope,
  ActionProviderFactory,
  CallContext,
  EffectPorts,
  LeafActionProvider,
  Outcome,
  ProviderLifecycle,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const CHANNEL_PROVIDER = { id: 'reference.channel', contract: 'agh.channel' } as const

const METHODS = RuntimeMethodSchemaRefs['agh.channel']
const schema = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})

/** The raw webhook body, carried as one JSON string so the signature covers its exact bytes. */
export const WEBHOOK_BODY = schema('reference.channel/webhook-body@1')
/** `{ timestamp, signature }`: the hex HMAC-SHA256 of `${timestamp}.${body}` under the webhook secret. */
export const WEBHOOK_SIGNATURE = schema('reference.channel/webhook-signature@1')
/** Effect operations the remote answers; the provider reaches it only through the action's effect ports. */
export const REMOTE = { post: 'reference.channel/post', lookup: 'reference.channel/lookup' } as const
export const REMOTE_DATA = schema('reference.channel/remote@1')
const RECEIPT = schema('reference.channel/receipt@1')
const ACTION_REF = schema('reference.channel/action-ref@1')

/** What one post carries. The remote keeps one message per `remoteKey`. */
export type RemotePost = {
  remoteKey: string
  destination: Wire.ChannelDestination
  text: string
  actions: { actionKey: string; label: string }[]
}
/** The remote's answer to a post or a lookup; a lookup of a key the remote never received answers null. */
export type RemoteAnswer =
  | { kind: 'delivered'; remoteMessageId: string; receipt: Wire.JsonValue }
  | { kind: 'refused'; reason: string }
/** The parsed webhook body: a press on one of a message's action keys, or a free-text reply to it. */
export type WebhookEvent = {
  eventId: string
  remoteMessageId: string
  conversationId: string
  threadId: string | null
  user: { id: string; bot: boolean }
  reply: { actionKey: string } | { text: string }
}

export function channelData(
  schemaRef: Wire.SchemaRef,
  value: unknown,
): Extract<Wire.DataRef, { kind: 'inline' }> {
  const json = value as Wire.JsonValue
  return {
    kind: 'inline',
    schema: schemaRef,
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(json)),
  }
}

export const signWebhook = (key: string, timestamp: string, body: string) =>
  createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')

export type ChannelCallbackOptions = Readonly<{
  /** Whether the Host issued this context for the channel's webhook route. */
  trusted(context: TrustedIngressContext): boolean
  /** The secrets broker the webhook secret is read through; its material never leaves `use`. */
  secrets: {
    resolve(input: Wire.SecretsResolveRequest, call: CallContext): Promise<Outcome<Wire.SecretHandle>>
    use(
      handle: Wire.SecretHandle,
      binding: Wire.SecretConsumerBinding,
      call: CallContext,
      work: (value: string, signal: AbortSignal) => void | Promise<void>,
    ): Promise<Outcome<void>>
  }
  credential: Wire.SecretConsumerBinding
  /** The call under which the provider reads its webhook secret for one delivery. */
  credentialCall(context: TrustedIngressContext): CallContext
  /** Remote user id to principal. Users missing here are refused, and so is every bot. */
  actors: Readonly<Record<string, Wire.Id>>
  /** How far the signed timestamp may sit from receipt, either way. */
  windowMs: number
  /** Hands an authenticated callback to the client ingress and answers the command it accepted. */
  forward(
    callback: Wire.AuthenticatedCallback,
    signal: AbortSignal,
  ): Promise<Outcome<Wire.ReceiptPointer | null>>
}>

export type ReferenceChannelOptions = Readonly<{
  /** The store file; it outlives the provider, so a restarted one resumes from it. */
  path: string
  binding: Wire.BindingRef
  scope: Wire.ScopeRef
  /** Whether the deployment lets this call post to `destination`. */
  authorize(destination: Wire.ChannelDestination, call: CallContext): boolean
  /** Without these the callback ingress refuses everything. */
  callbacks?: ChannelCallbackOptions
}>

type Detail = keyof typeof RuntimeErrorDetails

function error(detail: Detail, actionId?: string): Wire.RuntimeError {
  return {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message: 'Channel request refused',
    retryAdvice:
      detail === 'effect_unknown' && actionId !== undefined
        ? { kind: 'reconcile', ownerRef: { kind: 'action', id: actionId } }
        : { kind: 'never' },
    diagnosticId: 'reference-channel',
  }
}
const refuse = (detail: Detail): Outcome<never> => ({ ok: false, error: error(detail) })
const effect = (outcome: Wire.EffectResult['outcome'], extra: Partial<Wire.EffectResult> = {}) => ({
  outcome,
  externalRequests: [],
  usage: [],
  references: [],
  ...extra,
})
function fail(detail: Detail, actionId?: string): Wire.EffectResult {
  const problem = error(detail, actionId)
  const outcome = problem.code === 'cancelled' || problem.code === 'unknown_effect' ? problem.code : 'failed'
  return effect(outcome, { error: problem })
}
const done = (method: 'send' | 'reconcile', delivery: Wire.ChannelDelivery) =>
  effect('succeeded', { result: channelData(METHODS[method].output, delivery) })

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
const keys = (value: Record<string, unknown>, expected: string[]) =>
  jcs(Object.keys(value).sort()) === jcs(expected)

/** The input an inline reference carries, if it has the expected schema, digest and shape. */
function decode<K extends keyof Wire.RuntimeWireTypes>(ref: Wire.DataRef, expected: Wire.SchemaRef, name: K) {
  if (
    ref.kind !== 'inline' ||
    jcs(ref.schema) !== jcs(expected) ||
    ref.digest !== canonicalJsonDigest(ref.value)
  )
    return null
  const parsed = validateRuntime(name, ref.value)
  return parsed.ok ? parsed.value : null
}

function readAnswer(value: unknown): RemoteAnswer | null | undefined {
  if (value === null) return null
  if (record(value) && value.kind === 'delivered' && text(value.remoteMessageId) && 'receipt' in value)
    return value as RemoteAnswer
  if (record(value) && value.kind === 'refused' && text(value.reason)) return value as RemoteAnswer
  return undefined
}

function readEvent(body: string): WebhookEvent | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (
    !record(value) ||
    !keys(value, ['conversationId', 'eventId', 'remoteMessageId', 'reply', 'threadId', 'user'])
  )
    return null
  const { user, reply } = value
  const replied =
    record(reply) &&
    ((keys(reply, ['actionKey']) && text(reply.actionKey)) ||
      (keys(reply, ['text']) && typeof reply.text === 'string'))
  return text(value.eventId) &&
    text(value.remoteMessageId) &&
    text(value.conversationId) &&
    (value.threadId === null || text(value.threadId)) &&
    record(user) &&
    keys(user, ['bot', 'id']) &&
    text(user.id) &&
    typeof user.bot === 'boolean' &&
    replied
    ? (value as WebhookEvent)
    : null
}

const TABLES = `
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  remote_key TEXT NOT NULL,
  message TEXT NOT NULL,
  delivery TEXT,
  remote_message_id TEXT
);
CREATE TABLE IF NOT EXISTS callbacks (
  remote_event_id TEXT PRIMARY KEY,
  envelope_digest TEXT NOT NULL,
  callback TEXT NOT NULL,
  accepted TEXT
);`

type Row = {
  message_id: string
  fingerprint: string
  remote_key: string
  message: string
  delivery: string | null
}
type CallbackRow = { envelope_digest: string; callback: string; accepted: string | null }

/**
 * An authenticated webhook channel. A send commits its delivery row before the post leaves, so a crash
 * between the two leaves a row the remote's own record settles later; nothing ever posts a message twice.
 * A callback must come through a Host-issued context, carry a valid signature under the current webhook
 * secret within the window, name a mapped human user and press an action key the delivered message carries;
 * it then only references that view action, and each remote event is handed on once.
 */
export function createReferenceChannel(options: ReferenceChannelOptions): ServiceProvider {
  const db = new DatabaseSync(options.path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    // A delivery row must be on disk before its post leaves.
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(TABLES)
  } catch (problem) {
    db.close()
    throw problem
  }
  const stopping = new AbortController()
  const work = new Set<Promise<unknown>>()
  const used = new WeakSet<TrustedIngressContext>()
  let closing: Promise<void> | null = null

  const row = (messageId: string) =>
    db.prepare('SELECT * FROM deliveries WHERE message_id = ?').get(messageId) as Row | undefined
  const stored = (value: Row) => JSON.parse(value.message) as Wire.ChannelMessage

  function track<T>(task: () => Promise<T>): Promise<T> {
    const running = task()
    work.add(running)
    return running.finally(() => work.delete(running))
  }

  /** The remote's answer, or undefined once the call or the provider stops or the answer is unusable. */
  async function remote(context: ActionContext, operation: string, value: unknown) {
    const stop = AbortSignal.any([context.call.signal, stopping.signal])
    const reply = context.effects.invoke({ operation, input: channelData(REMOTE_DATA, value) }, context.call)
    const settled = await new Promise<Outcome<Wire.DataRef> | undefined>((resolve) => {
      const halt = () => resolve(undefined)
      if (stop.aborted) return halt()
      stop.addEventListener('abort', halt, { once: true })
      reply.then(resolve, halt).finally(() => stop.removeEventListener('abort', halt))
    })
    return settled?.ok && settled.value.kind === 'inline' ? readAnswer(settled.value.value) : undefined
  }

  /** Records the remote's answer; whichever answer is recorded first stands. */
  function settle(value: Row, answer: RemoteAnswer): Wire.ChannelDelivery {
    const { destination } = stored(value)
    const delivery: Wire.ChannelDelivery =
      answer.kind === 'delivered'
        ? {
            messageId: value.message_id,
            destination,
            state: 'delivered',
            remoteMessageId: answer.remoteMessageId,
            receipt: channelData(RECEIPT, answer.receipt),
          }
        : {
            messageId: value.message_id,
            destination,
            state: 'failed',
            remoteMessageId: null,
            receipt: channelData(RECEIPT, { refused: answer.reason }),
          }
    db.prepare(
      'UPDATE deliveries SET delivery = ?, remote_message_id = ? WHERE message_id = ? AND delivery IS NULL',
    ).run(JSON.stringify(delivery), delivery.remoteMessageId, value.message_id)
    return JSON.parse(String(row(value.message_id)?.delivery)) as Wire.ChannelDelivery
  }

  /** Settles a row from the remote's own record without posting; no record keeps it unknown. */
  async function resolve(value: Row, context: ActionContext): Promise<Wire.ChannelDelivery> {
    if (value.delivery !== null) return JSON.parse(value.delivery) as Wire.ChannelDelivery
    const answer = await remote(context, REMOTE.lookup, { remoteKey: value.remote_key })
    if (answer) return settle(value, answer)
    const { destination } = stored(value)
    return {
      messageId: value.message_id,
      destination,
      state: 'unknown',
      remoteMessageId: null,
      receipt: null,
    }
  }

  async function send(
    frame: Wire.ActionFrame,
    message: Wire.ChannelMessage,
    context: ActionContext,
    post: boolean,
  ): Promise<Wire.EffectResult> {
    if (message.partIndex >= message.partCount) return fail('invalid_request')
    // ponytail: attachments need a broker read through the artifact access port; refused until one is wired.
    if ((message.attachments ?? []).length > 0) return fail('unsupported')
    if (!options.authorize(message.destination, context.call)) return fail('permission_denied')
    if (context.call.signal.aborted) return fail('cancelled')
    const fingerprint = canonicalJsonDigest({
      message,
      owner: { runId: frame.runId, actionId: frame.actionId },
      bindingId: options.binding.bindingId,
    })
    let fresh = false
    if (post)
      fresh =
        db
          .prepare(
            'INSERT OR IGNORE INTO deliveries (message_id, fingerprint, remote_key, message) VALUES (?, ?, ?, ?)',
          )
          .run(
            message.messageId,
            fingerprint,
            canonicalJsonDigest({ messageId: message.messageId, destination: message.destination }),
            JSON.stringify(message),
          ).changes === 1
    const value = row(message.messageId)
    if (value === undefined) return fail('not_found')
    if (value.fingerprint !== fingerprint) return fail('idempotency_conflict')
    if (value.delivery !== null) return done('send', JSON.parse(value.delivery) as Wire.ChannelDelivery)
    if (!post) return done('send', await resolve(value, context))
    // A row from an earlier attempt may have a post out; only the remote's record may settle it.
    if (!fresh) return fail('effect_unknown', frame.actionId)
    const outgoing: RemotePost = {
      remoteKey: value.remote_key,
      destination: message.destination,
      text: message.content.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join(''),
      actions: message.content.parts.flatMap((part) =>
        part.kind === 'action' ? [{ actionKey: part.actionKey, label: part.label }] : [],
      ),
    }
    const answer = await remote(context, REMOTE.post, outgoing)
    return answer ? done('send', settle(value, answer)) : fail('effect_unknown', frame.actionId)
  }

  async function reconcile(request: Wire.ChannelReconcileRequest, context: ActionContext) {
    const value = row(request.messageId)
    // The request's evidence is only a hint and is not read; the remote's record decides.
    if (value === undefined || jcs(stored(value).destination) !== jcs(request.destination))
      return fail('not_found')
    return done('reconcile', await resolve(value, context))
  }

  const lifecycle: ProviderLifecycle = {
    async ready() {
      return closing ? refuse('blocked') : { ok: true, value: undefined }
    },
    async health() {
      return { ok: true, value: { status: closing ? 'failed' : 'ready', diagnosticIds: [] } }
    },
    async drain() {
      return {
        ok: true,
        value: {
          state: work.size ? 'blocked' : 'drained',
          activeInvocationIds: [],
          durableOwnerRefs: [],
          diagnosticIds: [],
        },
      }
    },
    close() {
      closing ??= (async () => {
        stopping.abort()
        await Promise.allSettled([...work])
        db.close()
      })()
      return closing
    },
  }

  function leaf(method: 'send' | 'reconcile'): ActionProviderFactory {
    const name = method === 'send' ? 'ChannelMessage' : 'ChannelReconcileRequest'
    return {
      kind: 'leaf',
      recovery: 'R2',
      stateCodec: null,
      async create(scope: ActionHandlerScope): Promise<LeafActionProvider> {
        const run = (frame: Wire.ActionFrame, context: ActionContext, post: boolean) =>
          track(async (): Promise<Wire.EffectResult> => {
            if (closing || scope.signal.aborted) return fail('blocked')
            const { signal: _signal, ...call } = context.call
            const input = decode(frame.input, METHODS[method].input, name)
            if (
              input === null ||
              !validateRuntime('ActionFrame', frame).ok ||
              frame.method !== method ||
              frame.actionId !== scope.actionId ||
              frame.runId !== scope.runId ||
              frame.bindingId !== options.binding.bindingId ||
              scope.bindingId !== options.binding.bindingId ||
              jcs(scope.scope) !== jcs(options.scope) ||
              jcs(call) !== jcs(frame.context) ||
              (frame.input.kind === 'inline' && frame.input.digest !== frame.inputDigest)
            )
              return fail('invalid_request')
            return method === 'send'
              ? send(frame, input as Wire.ChannelMessage, context, post)
              : reconcile(input as Wire.ChannelReconcileRequest, context)
          })
        return {
          ...lifecycle,
          kind: 'leaf',
          executionUnit: 'single-effect',
          effectSemantics: 'receipt-query',
          execute: (frame, context) => run(frame, context, true),
          async reconcile(frame, _evidence, context): Promise<Wire.ReconcileResult> {
            const result = await run(frame, context, false)
            const evidence = result.result ?? channelData(RECEIPT, { outcome: result.outcome })
            const state =
              result.result?.kind === 'inline' && record(result.result.value) && result.result.value.state
            if (result.outcome === 'succeeded' && state !== 'unknown')
              return { kind: 'resolved', evidence, result }
            if (result.error?.detailCode === 'not_found')
              return { kind: 'not_found', evidence, safeToRetry: true }
            return { kind: 'unknown', evidence, reason: 'The remote has no record of this post' }
          },
        }
      },
    }
  }

  async function callback(
    settings: ChannelCallbackOptions,
    request: Wire.ServiceOperation,
    context: TrustedIngressContext,
  ): Promise<Outcome<Wire.DataRef>> {
    if (!settings.trusted(context) || used.has(context)) return refuse('authentication_required')
    used.add(context)
    if (request.method !== 'callback' || jcs(request.target) !== jcs(options.binding))
      return refuse('invalid_request')
    const input = decode(request.input, METHODS.callback.input, 'ChannelCallbackRequest')
    const { envelope, signatureEvidence: proof } = input ?? {}
    if (
      envelope?.kind !== 'inline' ||
      jcs(envelope.schema) !== jcs(WEBHOOK_BODY) ||
      typeof envelope.value !== 'string' ||
      proof?.kind !== 'inline' ||
      jcs(proof.schema) !== jcs(WEBHOOK_SIGNATURE) ||
      !record(proof.value) ||
      !text(proof.value.timestamp) ||
      typeof proof.value.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.value.signature)
    )
      return refuse('invalid_request')
    const body = envelope.value
    const { timestamp, signature } = proof.value
    if (!(Math.abs(Date.parse(context.receivedAt) - Date.parse(timestamp)) <= settings.windowMs))
      return refuse('authentication_required')
    const call = settings.credentialCall(context)
    const { credential } = settings
    const handle = await settings.secrets.resolve(
      { secretId: credential.secretId, audience: credential.audience, purpose: credential.purpose },
      call,
    )
    // ponytail: the secret version stands in for credentialRevision, so versions must be decimal revisions.
    const revision = handle.ok ? Number(handle.value.version) : 0
    let verified = false
    if (
      handle.ok &&
      Number.isSafeInteger(revision) &&
      revision > 0 &&
      String(revision) === handle.value.version
    ) {
      const read = await settings.secrets.use(handle.value, credential, call, (key) => {
        const expected = Buffer.from(signWebhook(key, timestamp, body), 'hex')
        verified = timingSafeEqual(Buffer.from(signature, 'hex'), expected)
      })
      verified &&= read.ok
    }
    if (!verified) return refuse('authentication_required')
    const event = readEvent(body)
    if (event === null) return refuse('invalid_request')
    // Replays: an event id repeats only with the body it was first accepted with.
    const prior = db.prepare('SELECT * FROM callbacks WHERE remote_event_id = ?').get(event.eventId) as
      | CallbackRow
      | undefined
    if (prior !== undefined && prior.envelope_digest !== envelope.digest)
      return refuse('idempotency_conflict')
    let accepted: Wire.AuthenticatedCallback
    if (prior !== undefined) accepted = JSON.parse(prior.callback) as Wire.AuthenticatedCallback
    else {
      // A reply's text is never read as an answer: only a press on a key the message carries counts.
      if (!('actionKey' in event.reply)) return refuse('unsupported')
      const actor = Object.hasOwn(settings.actors, event.user.id) ? settings.actors[event.user.id] : undefined
      if (event.user.bot || actor === undefined) return refuse('permission_denied')
      const delivered = db
        .prepare('SELECT * FROM deliveries WHERE remote_message_id = ?')
        .get(event.remoteMessageId) as Row | undefined
      const message = delivered ? stored(delivered) : undefined
      const { actionKey } = event.reply
      if (
        message === undefined ||
        message.destination.conversationId !== event.conversationId ||
        message.destination.threadId !== event.threadId ||
        !message.content.parts.some((part) => part.kind === 'action' && part.actionKey === actionKey)
      )
        return refuse('permission_denied')
      accepted = {
        callbackId: canonicalJsonDigest({ binding: options.binding.bindingId, eventId: event.eventId }),
        channelId: message.destination.channelId,
        remoteEventId: event.eventId,
        actorPrincipalRef: actor,
        destination: message.destination,
        receivedAt: context.receivedAt,
        credentialRevision: revision,
        verifiedEnvelopeDigest: envelope.digest,
        command: {
          kind: 'domain',
          command: channelData(ACTION_REF, {
            viewId: message.viewId,
            actionKey,
            viewRevision: message.viewRevision,
          }),
        },
      }
      db.prepare('INSERT INTO callbacks (remote_event_id, envelope_digest, callback) VALUES (?, ?, ?)').run(
        event.eventId,
        envelope.digest,
        JSON.stringify(accepted),
      )
    }
    const result = (acceptedCommandRef: Wire.ReceiptPointer | null): Outcome<Wire.DataRef> => ({
      ok: true,
      value: channelData(METHODS.callback.output, { callback: accepted, acceptedCommandRef }),
    })
    if (prior?.accepted) return result(JSON.parse(prior.accepted) as Wire.ReceiptPointer | null)
    // ponytail: a redelivery racing the first hand-on forwards twice; the receiver must dedupe by callbackId.
    const forwarded = await settings.forward(accepted, context.signal)
    if (!forwarded.ok) return forwarded
    db.prepare('UPDATE callbacks SET accepted = ? WHERE remote_event_id = ?').run(
      JSON.stringify(forwarded.value),
      event.eventId,
    )
    return result(forwarded.value)
  }

  return {
    ...lifecycle,
    actions: { send: leaf('send'), reconcile: leaf('reconcile') },
    ingress(request, context) {
      const settings = options.callbacks
      if (closing) return Promise.resolve(refuse('blocked'))
      if (settings === undefined) return Promise.resolve(refuse('unsupported'))
      return track(() => callback(settings, request, context))
    },
  }
}

const idle = () => setInterval(() => undefined, 1000)

/**
 * `hold <config>` executes one send frame over a store and prints each post as `POST <json>` without ever
 * answering it, so a parent can kill this process once the remote has the message.
 */
async function runCommand(argv: readonly string[]): Promise<void> {
  const [command, file] = argv
  if (command !== 'hold' || file === undefined) throw new Error('usage: channel.ts hold <config>')
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    path: string
    binding: Wire.BindingRef
    scope: Wire.ScopeRef
    allowed: Wire.ChannelDestination
    frame: Wire.ActionFrame
  }
  const unsupported = async () => refuse('unsupported')
  const effects: EffectPorts = {
    invoke(request) {
      process.stdout.write(
        `POST ${JSON.stringify(request.input.kind === 'inline' ? request.input.value : null)}\n`,
      )
      return new Promise(() => undefined)
    },
    stream: unsupported,
    upload: unsupported,
  }
  const provider = createReferenceChannel({
    path: config.path,
    binding: config.binding,
    scope: config.scope,
    authorize: (destination) => jcs(destination) === jcs(config.allowed),
  })
  const { frame } = config
  const signal = new AbortController().signal
  const handler = await provider.actions?.send?.create({
    instanceId: 'channel-hold',
    actionId: frame.actionId,
    runId: frame.runId,
    bindingId: frame.bindingId,
    scope: config.scope,
    signal,
  })
  if (handler?.kind !== 'leaf') throw new Error('send is not a leaf action')
  idle()
  await handler.execute(frame, {
    call: { ...frame.context, signal },
    effects,
    progress: async () => ({ ok: true, value: undefined }),
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommand(process.argv.slice(2)).catch((problem: unknown) => {
    process.stderr.write(`${problem instanceof Error ? problem.message : 'channel provider failed'}\n`)
    process.exit(1)
  })
}
