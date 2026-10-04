import { pid } from 'node:process'
import type {
  ActionContext,
  EffectPorts,
  LeafActionProvider,
  Outcome,
  ServiceProvider,
  TrustedIngressContext,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, CaseContext, ConformanceHarness, TestServiceBinding } from '../harness.js'

const CONTRACT = 'agh.channel'
const METHODS = RuntimeMethodSchemaRefs[CONTRACT]
const HEX = /^[a-f0-9]{64}$/
const AT = '2026-10-01T00:00:00.000Z'
const DAY_EARLIER = '2026-09-30T00:00:00.000Z'
const DEADLINE = '2099-01-01T00:00:00.000Z'
const RUN = 'run-1'

/**
 * Every class drives the remote, the webhook ingress context and the client ingress through binding doubles:
 * no Host route issues channel callback contexts and no client ingress accepts channel callbacks yet. A pass
 * shows the provider keeps the contract against those doubles, nothing more.
 */
const DOUBLES =
  'remote, webhook ingress context and client ingress are binding doubles; not evidence for authenticated IM replies'

/** How the remote answers the posts that reach it: with a receipt, with a refusal, or never. */
export type ChannelRemoteAnswer = 'deliver' | 'refuse' | 'hold'

/** One webhook delivery the remote makes for a message it holds. */
export interface ChannelRemoteEvent {
  readonly eventId: string
  readonly remoteMessageId: string
  /** The remote user who acted. */
  readonly user: string
  readonly bot?: boolean
  /** The time the remote signs into the delivery. */
  readonly sentAt: string
  /** A press on one of the message's action keys, or a free-text reply to it. */
  readonly reply: { readonly actionKey: string } | { readonly text: string }
  /** Reported from another conversation than the message's, as a forwarded copy would be. */
  readonly forwarded?: boolean
  /** Signed with a key that is not the channel's, or changed after it was signed. */
  readonly forged?: 'signature' | 'body'
}

/**
 * One store with its remote and the doubles around it: `effects` reaches an in-memory remote, `ingress`
 * issues contexts the way a Host webhook route would, and accepted callbacks go to a client-ingress double.
 */
export interface ChannelWorld {
  /** Opens a provider over this world's store. Opening again after a close stands in for a restart. */
  open(): Promise<ServiceProvider>
  /** The effect ports every action context carries; they reach this world's remote. */
  readonly effects: EffectPorts
  answer(mode: ChannelRemoteAnswer): void
  /** Resolves once a post the remote holds has reached it. */
  held(): Promise<void>
  /** Posts that reached the remote, held and refused ones included. */
  posts(): number
  /** The signed webhook request the remote makes for `event`. */
  deliver(event: ChannelRemoteEvent): Wire.ChannelCallbackRequest
  /** A context as the Host webhook route issues it for a request received at `receivedAt`. */
  ingress(receivedAt: string): TrustedIngressContext
  /** Callbacks the provider handed on to the client ingress double, in order. */
  forwarded(): readonly Wire.AuthenticatedCallback[]
  /**
   * Executes `frame` in a separate provider process over this store and kills that process with SIGKILL
   * once the remote holds its post, so the remote has the message and the provider never saw the answer.
   */
  crash(frame: Wire.ActionFrame): Promise<{ readonly signal: string | null; readonly pid: number | null }>
  close(): Promise<void>
}

export interface ChannelConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the provider code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly binding: Wire.BindingRef
  /** The scope the provider serves; every action and call runs in it. */
  readonly scope: Wire.ScopeRef
  /** A destination the deployment lets the provider post to, and one it does not. */
  readonly destinations: {
    readonly allowed: Wire.ChannelDestination
    readonly refused: Wire.ChannelDestination
  }
  /** A remote user the deployment maps to `principalRef`, and one it maps to nobody. */
  readonly users: { readonly known: string; readonly principalRef: string; readonly unknown: string }
  /** A fresh world: its own store, remote and doubles. */
  world(): Promise<ChannelWorld>
}

type Checks = Record<string, boolean>
type ActionMethod = 'send' | 'reconcile'
type Attempt = { readonly actionId: string; readonly attempt?: number; readonly signal?: AbortSignal }

/** Canonical JSON equality: validated values come back without the plain object prototype. */
function same(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false
  try {
    return jcs(left as Wire.JsonValue) === jcs(right as Wire.JsonValue)
  } catch {
    return false
  }
}

function inline(schema: Wire.SchemaRef, value: unknown): Wire.DataRef {
  const json = value as Wire.JsonValue
  return {
    kind: 'inline',
    schema,
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(json)),
  }
}

/** A one-part view with one action, as a renderer formats it for a channel. */
function message(messageId: string, destination: Wire.ChannelDestination, revision = 3): Wire.ChannelMessage {
  const content: Wire.FormattedView = {
    viewId: 'view-1',
    revision,
    parts: [
      { kind: 'text', text: 'Deploy finished.' },
      { kind: 'action', actionKey: 'retry', label: 'Retry' },
    ],
    complete: true,
    unsupportedRequiredFeatures: [],
  }
  const digest = canonicalJsonDigest(content)
  const part = { partIndex: 0, partCount: 1, fullContentDigest: digest, attachments: [] }
  return {
    messageId,
    destination,
    viewId: 'view-1',
    viewRevision: revision,
    content,
    interaction: null,
    ...part,
  }
}

/** The delivery an action result carries, or null when it carries none that passes its schema. */
function delivery(result: Wire.EffectResult | undefined, method: ActionMethod = 'send') {
  const ref = result?.outcome === 'succeeded' ? result.result : undefined
  if (ref?.kind !== 'inline' || ref.schema.typeId !== METHODS[method].output.typeId) return null
  const parsed = validateRuntime('ChannelDelivery', ref.value)
  return parsed.ok ? parsed.value : null
}

function accepted(outcome: Outcome<Wire.DataRef>): Wire.ChannelCallbackResult | null {
  if (!outcome.ok || outcome.value.kind !== 'inline') return null
  if (outcome.value.schema.typeId !== METHODS.callback.output.typeId) return null
  const parsed = validateRuntime('ChannelCallbackResult', outcome.value.value)
  return parsed.ok ? parsed.value : null
}

const code = (result: Wire.EffectResult) => result.error?.detailCode ?? result.outcome
const refusal = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)

/** Drives one provider through the public action and ingress surface. */
function driver(binding: ChannelConformanceBinding, world: ChannelWorld) {
  const bindingId = binding.binding.bindingId
  const { allowed } = binding.destinations
  function frame(method: ActionMethod, value: unknown, { actionId, attempt = 1 }: Attempt): Wire.ActionFrame {
    const input = inline(METHODS[method].input, value)
    const invocationId = `${actionId}.${attempt}`
    const page = { items: [], nextCursor: null, complete: true }
    return {
      actionId,
      parentActionId: null,
      runId: RUN,
      bindingId,
      method,
      input,
      inputDigest: canonicalJsonDigest(value as Wire.JsonValue),
      attemptId: invocationId,
      attemptNumber: attempt,
      invocationId,
      requestIdentity: null,
      providerRevision: 0,
      continuation: null,
      signals: { ...page, snapshot: 'signals' },
      receipts: { ...page, snapshot: 'receipts' },
      signalHighWater: 0,
      snapshot: 'frame',
      observedAt: AT,
      context: {
        principalRef: 'channel-caller',
        scope: binding.scope,
        bindingId,
        invocationId,
        deadline: DEADLINE,
        traceRef: invocationId,
        authorizationRef: 'channel-caller-grant',
      },
      actionTimebox: { defaultTimeoutMs: 10_000, maxDeadline: DEADLINE },
    }
  }
  const context = (frame: Wire.ActionFrame, signal = new AbortController().signal): ActionContext => ({
    call: { ...frame.context, signal },
    effects: world.effects,
    progress: async () => ({ ok: true, value: undefined }),
  })
  async function leaf(provider: ServiceProvider, method: ActionMethod, actionId: string) {
    const scope = { instanceId: 'channel', actionId, runId: RUN, bindingId, scope: binding.scope }
    const made = await provider.actions?.[method]?.create({ ...scope, signal: new AbortController().signal })
    if (made?.kind !== 'leaf') throw new Error(`${method} is not a leaf action`)
    return made
  }
  const run = (handler: LeafActionProvider, method: ActionMethod, value: unknown, attempt: Attempt) => {
    const made = frame(method, value, attempt)
    return handler.execute(made, context(made, attempt.signal))
  }
  const act = async (provider: ServiceProvider, method: ActionMethod, value: unknown, attempt: Attempt) =>
    run(await leaf(provider, method, attempt.actionId), method, value, attempt)
  function callback(
    provider: ServiceProvider,
    request: Wire.ChannelCallbackRequest,
    ingress = world.ingress(AT),
  ) {
    if (provider.ingress === undefined) throw new Error('provider has no callback ingress')
    const input = inline(METHODS.callback.input, request)
    return provider.ingress({ target: binding.binding, method: 'callback', input }, ingress)
  }
  return {
    frame,
    leaf,
    run,
    act,
    callback,
    /** Sends message `messageId` to the allowed destination as attempt `attempt` of action `actionId`. */
    send: (
      provider: ServiceProvider,
      messageId: string,
      actionId: string,
      attempt = 1,
      signal?: AbortSignal,
    ) =>
      act(provider, 'send', message(messageId, allowed), {
        actionId,
        attempt,
        ...(signal ? { signal } : {}),
      }),
    /** Asks the send leaf of that action to reconcile, as a runtime does after an unknown outcome. */
    async settle(provider: ServiceProvider, messageId: string, actionId: string, attempt: number) {
      const made = frame('send', message(messageId, allowed), { actionId, attempt })
      return (await leaf(provider, 'send', actionId)).reconcile(made, [], context(made))
    },
    reconcile: async (provider: ServiceProvider, messageId: string, actionId: string) =>
      delivery(
        await act(provider, 'reconcile', { messageId, destination: allowed, evidence: null }, { actionId }),
        'reconcile',
      ),
    /** A press on the `retry` key of a delivered message by the mapped user, unless `event` says otherwise. */
    event: (
      eventId: string,
      delivered: Wire.ChannelDelivery | null,
      event: Partial<ChannelRemoteEvent> = {},
    ) =>
      world.deliver({
        eventId,
        remoteMessageId: delivered?.remoteMessageId ?? 'none',
        user: binding.users.known,
        sentAt: AT,
        reply: { actionKey: 'retry' },
        ...event,
      }),
  }
}

type Driver = ReturnType<typeof driver>
type Body = (world: ChannelWorld, drive: Driver, checks: Checks) => Promise<void>

/** Runs `body` in a fresh world and returns the checks it recorded. */
async function inWorld(binding: ChannelConformanceBinding, body: Body): Promise<Checks> {
  const world = await binding.world()
  const checks: Checks = {}
  try {
    await body(world, driver(binding, world), checks)
    return checks
  } finally {
    await world.close()
  }
}

const CASES: Record<
  ScenarioName,
  (binding: ChannelConformanceBinding, context: CaseContext) => Promise<Checks>
> = {
  select: (binding, context) =>
    inWorld(binding, async (world, drive, checks) => {
      const requirement = {
        contract: CONTRACT,
        major: RuntimeServiceCatalog[CONTRACT].major,
        logicalName: binding.binding.logicalName,
        features: [],
        scope: binding.scope.kind,
        optional: false,
      }
      try {
        context.container.register({ requirement, binding: binding.binding } satisfies TestServiceBinding)
        const chosen = context.container.dependencies.get(requirement)
        checks['container selects the provider'] =
          chosen.ok && chosen.value.binding.providerId === binding.providerId
      } catch {
        checks['container selects the provider'] = false
      }
      const provider = await world.open()
      const actions = Object.entries(RuntimeServiceCatalog[CONTRACT].methods)
        .filter(([, method]) => method.kind === 'action')
        .map(([name]) => name)
      checks['actions are exactly the catalog actions'] = same(
        Object.keys(provider.actions ?? {}).sort(),
        actions.sort(),
      )
      checks['callback is an ingress'] = typeof provider.ingress === 'function'
      for (const method of ['send', 'reconcile'] as const) {
        const handler = await drive.leaf(provider, method, `select-${method}`)
        checks[`${method} is a receipt-query leaf`] =
          provider.actions?.[method]?.kind === 'leaf' && handler.effectSemantics === 'receipt-query'
      }
      const { context: call } = drive.frame('send', {}, { actionId: 'select' })
      checks['provider ready'] = (await provider.ready({ ...call, signal: new AbortController().signal })).ok
      await provider.close('shutdown')
    }),

  normal: (binding) =>
    inWorld(binding, async (world, drive, checks) => {
      const provider = await world.open()
      const first = delivery(await drive.send(provider, 'm-1', 'a-send'))
      checks['send delivered with a receipt'] =
        first?.state === 'delivered' &&
        first.messageId === 'm-1' &&
        same(first.destination, binding.destinations.allowed) &&
        first.remoteMessageId !== null &&
        first.receipt !== null
      const again = delivery(await drive.send(provider, 'm-1', 'a-send', 2))
      checks['same action identity returns the same delivery'] = first !== null && same(again, first)
      checks['reconcile reads the same delivery'] =
        first !== null && same(await drive.reconcile(provider, 'm-1', 'a-reconcile'), first)
      checks['one post reached the remote'] = world.posts() === 1
      const request = drive.event('e-1', first)
      const result = accepted(await drive.callback(provider, request))
      const command = result?.callback.command
      checks['callback references the pressed view action'] =
        command?.kind === 'domain' &&
        command.command.kind === 'inline' &&
        same(command.command.value, { viewId: 'view-1', actionKey: 'retry', viewRevision: 3 })
      checks['callback carries the mapped actor and the message destination'] =
        result?.callback.actorPrincipalRef === binding.users.principalRef &&
        same(result.callback.destination, binding.destinations.allowed) &&
        result.callback.remoteEventId === 'e-1' &&
        HEX.test(result.callback.verifiedEnvelopeDigest)
      checks['callback carries the accepted command'] = (result?.acceptedCommandRef ?? null) !== null
      checks['callback handed on once'] =
        world.forwarded().length === 1 && same(world.forwarded()[0], result?.callback)
      const redelivered = accepted(await drive.callback(provider, request))
      checks['redelivery returns the first result'] = result !== null && same(redelivered, result)
      checks['redelivery is not handed on again'] = world.forwarded().length === 1
      await provider.close('shutdown')
    }),

  deny: (binding) =>
    inWorld(binding, async (world, drive, checks) => {
      const provider = await world.open()
      const { allowed, refused } = binding.destinations
      const first = delivery(await drive.send(provider, 'm-1', 'a-1'))
      const refusals = [
        // The same action with another input, then another action with the same message.
        await drive.act(provider, 'send', message('m-1', allowed, 4), { actionId: 'a-1', attempt: 2 }),
        await drive.send(provider, 'm-1', 'a-2'),
        await drive.act(provider, 'send', message('m-2', refused), { actionId: 'a-3' }),
        await drive.act(
          provider,
          'reconcile',
          { messageId: 'm-9', destination: allowed, evidence: null },
          { actionId: 'a-4' },
        ),
      ].map(code)
      checks['actions refused'] = same(refusals, [
        'idempotency_conflict',
        'idempotency_conflict',
        'permission_denied',
        'not_found',
      ])
      world.answer('refuse')
      const rejected = delivery(await drive.send(provider, 'm-3', 'a-5'))
      checks['remote refusal is a failed delivery'] = rejected?.state === 'failed'
      const retried = delivery(await drive.send(provider, 'm-3', 'a-5', 2))
      checks['failed delivery is final'] = rejected !== null && same(retried, rejected)
      checks['refused actions never reached the remote'] = world.posts() === 2
      world.answer('deliver')
      const deliver = (eventId: string, event: Partial<ChannelRemoteEvent> = {}) =>
        drive.callback(provider, drive.event(eventId, first, event))
      const callbacks = [
        // A copy of an issued context is not one the Host issued.
        await drive.callback(provider, drive.event('e-1', first), { ...world.ingress(AT) }),
        await deliver('e-2', { forged: 'signature' }),
        await deliver('e-3', { forged: 'body' }),
        await deliver('e-4', { sentAt: DAY_EARLIER }),
        await deliver('e-5', { user: binding.users.unknown }),
        await deliver('e-6', { bot: true }),
        await deliver('e-7', { forwarded: true }),
        await deliver('e-8', { reply: { actionKey: 'delete' } }),
        // A reply's text is never taken as an answer, approval or otherwise.
        await deliver('e-9', { reply: { text: 'approve' } }),
      ].map(refusal)
      const unauthenticated = Array(4).fill('authentication_required')
      const unauthorized = Array(4).fill('permission_denied')
      checks['callbacks refused'] = same(callbacks, [...unauthenticated, ...unauthorized, 'unsupported'])
      checks['authenticated press accepted'] = accepted(await deliver('e-10')) !== null
      const replayed = await deliver('e-10', { reply: { text: 'approve' } })
      checks['replayed event with another body refused'] = refusal(replayed) === 'idempotency_conflict'
      checks['only the authenticated press handed on'] = world.forwarded().length === 1
      await provider.close('shutdown')
    }),

  cancel: (binding) =>
    inWorld(binding, async (world, drive, checks) => {
      const provider = await world.open()
      const early = await drive.send(provider, 'm-1', 'a-1', 1, AbortSignal.abort())
      checks['abort before sending cancels without a post'] =
        early.outcome === 'cancelled' && world.posts() === 0
      world.answer('hold')
      const stop = new AbortController()
      const pending = drive.send(provider, 'm-2', 'a-2', 1, stop.signal)
      await world.held()
      stop.abort()
      checks['abort after the post leaves the outcome unknown'] = (await pending).outcome === 'unknown_effect'
      world.answer('deliver')
      const retried = await drive.send(provider, 'm-2', 'a-2', 2)
      checks['retrying an unknown send does not post again'] = retried.outcome === 'unknown_effect'
      const settled = await drive.settle(provider, 'm-2', 'a-2', 3)
      const resolved = settled.kind === 'resolved' ? delivery(settled.result) : null
      checks['leaf reconcile resolves the held post'] = resolved?.state === 'delivered'
      const after = delivery(await drive.send(provider, 'm-2', 'a-2', 4))
      checks['send then returns the reconciled delivery'] = resolved !== null && same(after, resolved)
      const resumed = delivery(await drive.send(provider, 'm-1', 'a-1', 2))
      checks['a send cancelled before posting can still deliver'] = resumed?.state === 'delivered'
      checks['each message posted once'] = world.posts() === 2
      await provider.close('shutdown')
    }),

  recover: (binding) =>
    inWorld(binding, async (world, drive, checks) => {
      const sent = message('m-1', binding.destinations.allowed)
      const killed = await world.crash(drive.frame('send', sent, { actionId: 'a-1' }))
      checks['provider process killed'] =
        killed.signal === 'SIGKILL' && killed.pid !== null && killed.pid !== pid && world.posts() === 1
      const provider = await world.open()
      const retried = await drive.send(provider, 'm-1', 'a-1', 2)
      checks['restarted send does not post again'] =
        retried.outcome === 'unknown_effect' && world.posts() === 1
      const reconciled = await drive.reconcile(provider, 'm-1', 'a-reconcile')
      checks['reconcile resolves the unknown outcome'] =
        reconciled?.state === 'delivered' && reconciled.remoteMessageId !== null
      const after = delivery(await drive.send(provider, 'm-1', 'a-1', 3))
      checks['send then returns the reconciled delivery'] = reconciled !== null && same(after, reconciled)
      const request = drive.event('e-1', reconciled)
      const result = accepted(await drive.callback(provider, request))
      await provider.close('shutdown')
      const restarted = await world.open()
      const replayed = accepted(await drive.callback(restarted, request))
      checks['callback outcome survives a restart'] = result !== null && same(replayed, result)
      checks['restart hands on nothing again'] = world.forwarded().length === 1 && world.posts() === 1
      await restarted.close('shutdown')
    }),

  dispose: (binding) =>
    inWorld(binding, async (world, drive, checks) => {
      const { allowed } = binding.destinations
      const provider = await world.open()
      const sent = delivery(await drive.send(provider, 'm-1', 'a-1'))
      const early = await drive.leaf(provider, 'send', 'a-4')
      world.answer('hold')
      const inflight = drive.send(provider, 'm-2', 'a-2')
      await world.held()
      await provider.close('shutdown')
      checks['in-flight send ends unknown at close'] = (await inflight).outcome === 'unknown_effect'
      await provider.close('shutdown')
      world.answer('deliver')
      const created = await drive.leaf(provider, 'send', 'a-3').catch(() => null)
      const late = created && (await drive.run(created, 'send', message('m-3', allowed), { actionId: 'a-3' }))
      const old = await drive.run(early, 'send', message('m-4', allowed), { actionId: 'a-4' })
      checks['actions after close refused'] = same(
        [late ? code(late) : 'blocked', code(old)],
        ['blocked', 'blocked'],
      )
      const callback = await drive.callback(provider, drive.event('e-1', sent))
      checks['callback after close refused'] =
        refusal(callback) === 'blocked' && world.forwarded().length === 0
      checks['nothing posted after close'] = world.posts() === 2
      const reopened = await world.open()
      const again = delivery(await drive.send(reopened, 'm-1', 'a-1', 2))
      checks['the store outlives the provider'] = sent !== null && same(again, sent)
      await reopened.close('shutdown')
    }),
}

/** The names of the failed checks, or the error a case threw. */
async function failures(
  scenario: ScenarioName,
  binding: ChannelConformanceBinding,
  context: CaseContext,
): Promise<string[]> {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  if (!digests.every((digest) => HEX.test(digest))) return ['provider, config or release set digest']
  try {
    return Object.entries(await CASES[scenario](binding, context))
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  } catch (error) {
    return [`threw: ${error instanceof Error ? error.message : String(error)}`]
  }
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

/** Register select, normal, deny, cancel, recover and dispose for one channel provider. */
export function registerChannelContract(
  harness: ConformanceHarness,
  binding: ChannelConformanceBinding,
): void {
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(context): Promise<AssertionInput> {
        const failed = await failures(scenario, binding, context)
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: ['send', 'reconcile', 'callback'],
          build: binding.build,
          consumer: 'channel-conformance-consumer',
          command: binding.command,
          status: failed.length === 0 ? 'passed' : 'failed',
          diagnostic: [...failed, DOUBLES].join('; '),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          // The remote answers through the binding's restricted effect ports.
          fixture: scenario === 'select' ? 'test-service-container' : 'restricted-effects',
          sharedEvidenceId: null,
          reuse: {
            scope: 'run',
            methodKind: 'action',
            lifecycle: LIFECYCLE[scenario],
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
