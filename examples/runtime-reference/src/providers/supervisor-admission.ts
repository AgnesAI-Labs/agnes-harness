import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { RefPorts, RefTicket } from './supervisor-ports.js'
import { placeOf, refuse, same, sessionOf, until } from './supervisor-wire.js'

const DAY = 86_400_000
type Release = NonNullable<
  Awaited<ReturnType<NonNullable<RefPorts['releases']>['select']>> extends Outcome<infer R> ? R : never
>

/** The same authorization-then-abort gate in front of every outward call. */
const gateOf =
  (ports: Required<Pick<RefPorts, 'identity'>>, context: CallContext) => (): Outcome<never> | null => {
    try {
      ports.identity.check(context)
    } catch {
      return refuse('denied', 'permission_denied')
    }
    return context.signal.aborted ? refuse('cancelled', 'cancelled') : null
  }

const loopOf = (release: Release | null): W.BindingRef | null =>
  release?.runBinding.providers
    .map((entry) => entry.binding)
    .find((binding) => binding.contract === 'agh.loop') ?? null

function expiry(now: number, lifetime: number, delegation: string | null): string | Outcome<never> {
  if (!(lifetime > 0 && lifetime <= 365 * DAY)) return refuse('incompatible', 'supervisor_limits_invalid')
  const cap = delegation === null ? Number.POSITIVE_INFINITY : Date.parse(delegation)
  if (cap <= now) return refuse('denied', 'revoked')
  return new Date(Math.min(now + lifetime, cap)).toISOString()
}

export async function referenceAdmit(
  ports: RefPorts,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorAdmitResult>> {
  const { admission, releases, identity, limits } = ports
  if (!admission || !releases || !identity || !limits)
    return refuse('incompatible', 'supervisor_port_unavailable')
  const spec = input as W.NewRunSpec
  const place = placeOf(context.scope)
  if (!place) return refuse('invalid_input', 'supervisor_session_required')
  const gate = gateOf({ identity }, context)
  const bytes = spec.inputRef.kind === 'inline' ? spec.inputRef.digest : spec.inputRef.blob.digest
  const request = canonicalJsonDigest({
    preset: spec.presetRef,
    conversation: (spec.conversation ?? null) as never,
    bytes,
  })
  const material = canonicalJsonDigest({
    kind: 'reference-admit',
    scope: context.scope as never,
    key: spec.idempotencyKey,
    request,
  })
  const ticketId = `rt-${material.slice(0, 40)}`
  const runId = `rr-${material.slice(0, 40)}`

  const blocked = gate()
  if (blocked) return blocked
  const stored = await until(admission.recall(ticketId, context), context, ports.clock)
  if (!stored.ok) return stored
  const afterRecall = gate()
  if (afterRecall) return afterRecall

  let draft: Parameters<NonNullable<RefPorts['admission']>['coordinate']>[0]
  let release: Release | null
  const found: RefTicket | null = stored.value
  if (found) {
    if (
      found.admission.ticketId !== ticketId ||
      found.admission.runId !== runId ||
      found.runKey !== spec.idempotencyKey
    )
      return refuse('internal', 'supervisor_peer_mismatch')
    const { fingerprint: _f, packagePinReceipt: _p, ...body } = found.admission
    draft = {
      runKey: found.runKey,
      admission: body,
      stateAuthorityRef: found.stateAuthorityRef,
      grantRef: found.grantRef,
    }
    const pinned = await until(
      releases.bound(found.admission.releaseSetId, found.admission.bindingId, context),
      context,
      ports.clock,
    )
    if (!pinned.ok) return pinned
    release = pinned.value
  } else {
    const chosen = await until(releases.select(spec.presetRef, context), context, ports.clock)
    if (!chosen.ok) return chosen
    release = chosen.value
    const now = ports.clock()
    const deadline = expiry(now, limits.workflowLifetimeMs, identity.delegationExpiresAt(context))
    if (typeof deadline !== 'string') return deadline
    draft = {
      runKey: spec.idempotencyKey,
      admission: {
        ticketId,
        releaseSetId: chosen.value.releaseSetId,
        bindingId: chosen.value.runBinding.bindingId,
        runId,
        sessionId: place.sessionId,
        lane: chosen.value.lane,
        workspaceId: place.workspaceId,
        input: spec.inputRef,
        admittedAt: new Date(now).toISOString(),
        deadline,
        conversation: spec.conversation ?? null,
      },
      stateAuthorityRef: chosen.value.stateAuthorityRef,
      grantRef: context.authorizationRef,
    }
  }
  const loop = loopOf(release)
  if (!loop) return refuse('incompatible', 'supervisor_release_invalid')
  const beforeWrite = gate()
  if (beforeWrite) return beforeWrite
  const probe = await until(admission.coordinate(draft, context), context, ports.clock)
  if (!probe.ok)
    return probe.error.detailCode === 'admission_ticket_conflict'
      ? refuse('conflict', 'idempotency_conflict')
      : { ok: false, error: probe.error }
  switch (probe.value.state) {
    case 'cancelled':
      return refuse('cancelled', 'supervisor_admission_cancelled')
    case 'absent':
      return refuse('retryable', 'supervisor_admission_pending', { kind: 'retry_same_action' })
    case 'created':
      return probe.value.runId === runId
        ? { ok: true, value: { runId, bindingRef: loop } }
        : refuse('retryable', 'supervisor_admission_pending', { kind: 'retry_same_action' })
  }
}

export async function referenceCancel(
  ports: RefPorts,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorCancelResult>> {
  const { admission, identity } = ports
  if (!admission || !identity) return refuse('incompatible', 'supervisor_port_unavailable')
  const { runRef } = input as W.SupervisorCancelRequest
  const own = sessionOf(context.scope)
  if (own !== null && own !== runRef.session.sessionId) return refuse('denied', 'supervisor_scope_session')
  const gate = gateOf({ identity }, context)
  const first = gate()
  if (first) return first
  const recalled = await until(admission.recallByRun(runRef.runId, context), context, ports.clock)
  if (!recalled.ok) return recalled
  const ticket = recalled.value
  if (!ticket || !same(ticket.stateAuthorityRef, runRef.session.authority))
    return refuse('invalid_input', 'not_found')
  const second = gate()
  if (second) return second
  // One decision slot arbitrates createRun against cancelAdmission; probing first would refuse on unproven absence.
  const done = await until(
    admission.cancel(ticket.admission.ticketId, ticket.admission.fingerprint, context),
    context,
    ports.clock,
  )
  if (!done.ok) return done
  if (done.value.state !== 'cancelled') return refuse('incompatible', 'supervisor_state_command_unavailable')
  const tombstone = done.value.tombstoneId
  return {
    ok: true,
    value: {
      cancellationRef: {
        authorityId: ticket.stateAuthorityRef.authorityId,
        receiptId: tombstone,
        digest: canonicalJsonDigest({
          ticket: ticket.admission.ticketId,
          tombstone,
          kind: 'reference-tombstone',
        }),
      },
    },
  }
}
