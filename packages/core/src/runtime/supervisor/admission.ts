import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { admissionIds, lifetimeDeadline, sessionIdOf, workspaceIdOf } from './keys.js'
import type { MethodEntry, PublishedRelease, RecalledTicket, SupervisorDeployment } from './ports.js'
import { equal, fail, race } from './wire.js'

type Ports = Required<Pick<SupervisorDeployment, 'admission' | 'releases' | 'identity' | 'limits'>> &
  Pick<SupervisorDeployment, 'clock'>

/** The same gate before every outward call and after every await: authorization, then caller abort. */
function current(deployment: Ports, context: CallContext): Outcome<never> | null {
  try {
    deployment.identity.check(context)
  } catch {
    return fail('denied', 'permission_denied')
  }
  return context.signal.aborted ? fail('cancelled', 'cancelled') : null
}

const ticketFailure = (error: W.RuntimeError): Outcome<never> =>
  error.detailCode === 'admission_ticket_conflict'
    ? fail('conflict', 'idempotency_conflict')
    : { ok: false, error }

function loopBinding(release: PublishedRelease): W.BindingRef | null {
  const found = release.runBinding.providers.find((entry) => entry.binding.contract === 'agh.loop')
  return found ? found.binding : null
}

function draftOf(ticket: RecalledTicket) {
  const { fingerprint: _fingerprint, packagePinReceipt: _pin, ...admission } = ticket.admission
  return {
    runKey: ticket.runKey,
    admission,
    stateAuthorityRef: ticket.stateAuthorityRef,
    grantRef: ticket.grantRef,
  }
}

export async function admit(
  deployment: SupervisorDeployment,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorAdmitResult>> {
  const { admission, releases, identity, limits } = deployment
  if (!admission || !releases || !identity || !limits)
    return fail('incompatible', 'supervisor_port_unavailable')
  const ports: Ports = { admission, releases, identity, limits, clock: deployment.clock }
  const spec = input as W.NewRunSpec
  const sessionId = sessionIdOf(context.scope)
  const workspaceId = workspaceIdOf(context.scope)
  if (sessionId === null || workspaceId === null) return fail('invalid_input', 'supervisor_session_required')
  const specDigest = canonicalJsonDigest({
    presetRef: spec.presetRef,
    input: spec.inputRef.kind === 'inline' ? spec.inputRef.digest : spec.inputRef.blob.digest,
    conversation: (spec.conversation ?? null) as unknown as W.JsonValue,
  })
  const ids = admissionIds(context.scope, spec.idempotencyKey, specDigest, canonicalJsonDigest)

  let refusal = current(ports, context)
  if (refusal) return refusal
  const recalled = await race(admission.recall(ids.ticketId, context), context, deployment.clock)
  if (!recalled.ok) return recalled
  refusal = current(ports, context)
  if (refusal) return refusal

  let draft: ReturnType<typeof draftOf>
  let release: PublishedRelease | null
  const prior = recalled.value
  if (prior) {
    // A retry reuses the stored issuance verbatim, including admittedAt and deadline: never a fresh clock.
    if (
      prior.admission.ticketId !== ids.ticketId ||
      prior.admission.runId !== ids.runId ||
      prior.runKey !== ids.runKey
    )
      return fail('internal', 'supervisor_peer_mismatch')
    draft = draftOf(prior)
    const bound = await race(
      releases.bound(prior.admission.releaseSetId, prior.admission.bindingId, context),
      context,
      deployment.clock,
    )
    if (!bound.ok) return bound
    release = bound.value
  } else {
    const picked = await race(releases.select(spec.presetRef, context), context, deployment.clock)
    if (!picked.ok) return picked
    release = picked.value
    const expires = identity.delegationExpiresAt(context)
    const now = deployment.clock()
    if (expires !== null && Date.parse(expires) <= now) return fail('denied', 'revoked')
    let deadline: string
    try {
      deadline = lifetimeDeadline(
        now,
        limits.workflowLifetimeMs,
        expires === null ? null : Date.parse(expires),
      )
    } catch {
      return fail('incompatible', 'supervisor_limits_invalid')
    }
    draft = {
      runKey: ids.runKey,
      admission: {
        ticketId: ids.ticketId,
        releaseSetId: release.releaseSetId,
        bindingId: release.runBinding.bindingId,
        runId: ids.runId,
        sessionId,
        lane: release.lane,
        workspaceId,
        input: spec.inputRef,
        admittedAt: new Date(now).toISOString(),
        deadline,
        conversation: spec.conversation ?? null,
      },
      stateAuthorityRef: release.stateAuthorityRef,
      grantRef: context.authorizationRef,
    }
  }
  const binding = release ? loopBinding(release) : null
  if (!binding) return fail('incompatible', 'supervisor_release_invalid')
  refusal = current(ports, context)
  if (refusal) return refusal
  const probe = await race(admission.coordinate(draft, context), context, deployment.clock)
  if (!probe.ok) return ticketFailure(probe.error)
  if (probe.value.state === 'cancelled') return fail('cancelled', 'supervisor_admission_cancelled')
  if (probe.value.state === 'absent' || probe.value.runId !== ids.runId)
    // createRun's answer is unknown or foreign: the pin stays and the same key retries to the same ticket.
    return fail('retryable', 'supervisor_admission_pending', { kind: 'retry_same_action' })
  return { ok: true, value: { runId: probe.value.runId, bindingRef: binding } }
}

export async function cancelAdmission(
  deployment: SupervisorDeployment,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorCancelResult>> {
  const { admission, identity } = deployment
  if (!admission || !identity) return fail('incompatible', 'supervisor_port_unavailable')
  const request = input as W.SupervisorCancelRequest
  const own = sessionIdOf(context.scope)
  if (own !== null && own !== request.runRef.session.sessionId)
    return fail('denied', 'supervisor_scope_session')
  const gate = (): Outcome<never> | null => {
    try {
      identity.check(context)
    } catch {
      return fail('denied', 'permission_denied')
    }
    return context.signal.aborted ? fail('cancelled', 'cancelled') : null
  }
  let refusal = gate()
  if (refusal) return refusal
  const recalled = await race(admission.recallByRun(request.runRef.runId, context), context, deployment.clock)
  if (!recalled.ok) return recalled
  const ticket = recalled.value
  if (!ticket || !equal(ticket.stateAuthorityRef, request.runRef.session.authority))
    return fail('invalid_input', 'not_found')
  refusal = gate()
  if (refusal) return refusal
  // The owner arbitrates createRun against cancelAdmission in one decision slot. Probing first would be wrong:
  // an issued ticket whose createRun never happened has no provable absence, so the probe itself refuses.
  const settled = await race(
    admission.cancel(ticket.admission.ticketId, ticket.admission.fingerprint, context),
    context,
    deployment.clock,
  )
  if (!settled.ok) return settled
  // createRun won: a run record exists and its cancellation is a State control command, a later slice.
  if (settled.value.state !== 'cancelled') return fail('incompatible', 'supervisor_state_command_unavailable')
  return {
    ok: true,
    value: {
      cancellationRef: {
        authorityId: ticket.stateAuthorityRef.authorityId,
        receiptId: settled.value.tombstoneId,
        digest: canonicalJsonDigest({
          kind: 'admission-tombstone',
          ticketId: ticket.admission.ticketId,
          tombstoneId: settled.value.tombstoneId,
          fingerprint: ticket.admission.fingerprint,
        }),
      },
    },
  }
}

export const admissionMethods = {
  admit: { needs: ['admission', 'releases', 'identity', 'limits'], run: admit },
  cancel: { needs: ['admission', 'identity'], run: cancelAdmission },
} satisfies Record<string, MethodEntry>
