import {
  createInteractionAuthority,
  type InteractionEvidence,
  type InteractionTransaction,
  type StoredInteractionResponse,
  type StoredInteractionWake,
} from '@agnes/core'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type ApprovalRespondRequest,
  type CommitControlRequest,
  canonicalJsonDigest,
  type InteractionRecord,
  type InteractionRequest,
  type InteractionResponseStatus,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { frozenJson } from '../../ext-host/frozen-json.js'
import { stableId } from './records.js'
import { integrity, refuse } from './refusal.js'

type InteractionOwner = InteractionRecord['owner']

export type ApprovalPreparation = Omit<CommitControlRequest, 'command'> & {
  command: Extract<CommitControlRequest['command'], { kind: 'prepare_authorization' }>
}

export type ApprovalResponder = Readonly<{ actorRef: string; evidence: InteractionEvidence }>
export type ApprovalPreparationInput = Readonly<{
  request: InteractionRequest
  owner: InteractionOwner
  preparation: ApprovalPreparation
  context: CallContext
}>
export type ApprovalResolutionInput = Readonly<{
  request: ApprovalRespondRequest
  context: CallContext
  /** Process-private capability associated by the actual authenticated ingress owner. */
  authentication: unknown
}>

/** Private owner ports. Every put stages into the already-open original State transaction. */
export interface ApprovalJointPorts {
  now(): string
  assertTransaction(): void
  assertJoint(context: CallContext): void
  currentResponder(context: CallContext, authentication: unknown): ApprovalResponder
  interaction: InteractionTransaction
  prepared(identity: string): { fingerprint: string; record: InteractionRecord } | undefined
  stagePreparation(
    identity: string,
    fingerprint: string,
    record: InteractionRecord,
    request: ApprovalPreparation,
  ): void | Promise<void>
  fullResponse(responseId: string): { fingerprint: string; response: StoredInteractionResponse } | undefined
  stageFullResponse(
    fingerprint: string,
    response: StoredInteractionResponse,
    request: ApprovalRespondRequest,
    responder: ApprovalResponder,
  ): void
  stageResolvedWake(wake: StoredInteractionWake): void
}

function fingerprint(value: unknown): string {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) integrity('approval source is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}
function assertCurrent(ports: ApprovalJointPorts, context: CallContext): void {
  ports.assertTransaction()
  ports.assertJoint(context)
  if (context.signal.aborted || !(Date.parse(context.deadline) > Date.parse(ports.now())))
    refuse('denied', 'approval_current', 'approval call is no longer current')
}
function responder(ports: ApprovalJointPorts, input: ApprovalResolutionInput): ApprovalResponder {
  assertCurrent(ports, input.context)
  const result = ports.currentResponder(input.context, input.authentication)
  if (
    !result ||
    !validateRuntime('Id', result.actorRef).ok ||
    !validateRuntime('JsonValue', result.evidence).ok
  )
    refuse('denied', 'approval_authentication', 'actual approval responder evidence is missing')
  return frozenJson(JSON.parse(jcs(result))) as ApprovalResponder
}
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Runs existing interaction rules over only this owner's scoped staging adapter, never a nested store. */
function rules(ports: ApprovalJointPorts, id: string, adapter: InteractionTransaction = ports.interaction) {
  let entered = false
  return createInteractionAuthority(
    {
      async transaction<T>(body: (tx: InteractionTransaction) => T): Promise<T> {
        ports.assertTransaction()
        if (entered) integrity('approval rule adapter was reused')
        entered = true
        return body(adapter)
      },
    },
    { now: ports.now, newId: () => id },
  )
}

/** Called only inside the State owner's preparation/cutoff transaction, before its single flush. */
export async function prepareApprovalInTransaction(
  ports: ApprovalJointPorts,
  input: ApprovalPreparationInput,
): Promise<InteractionRecord> {
  assertCurrent(ports, input.context)
  const request = validateRuntime('InteractionRequest', input.request)
  const preparation = validateRuntime('CommitControlRequest', input.preparation)
  if (!request.ok || !preparation.ok || input.owner.runId !== input.preparation.guard.runId)
    refuse('invalid_input', 'approval_preparation', 'approval preparation source is invalid')
  if (request.value.kind === 'approval' && jcs(request.value.scope) !== jcs(input.context.scope))
    refuse('denied', 'approval_scope', 'approval question belongs to another current scope')
  const command = preparation.value.command
  if (
    command.kind !== 'prepare_authorization' ||
    request.value.kind !== 'approval' ||
    command.actionId !== input.owner.actionId ||
    command.preparation.actionId !== input.owner.actionId ||
    command.preparation.inputDigest !== request.value.inputDigest ||
    jcs(command.preparation.approvalRequest) !== jcs(request.value)
  )
    refuse(
      'invalid_input',
      'approval_preparation',
      'approval question differs from its actual authorization preparation',
    )
  const identity = stableId(
    'interaction',
    jcs({
      bindingId: input.context.bindingId,
      scope: input.context.scope,
      owner: input.owner,
      idempotencyKey: request.value.idempotencyKey,
    }),
  )
  const digest = fingerprint({
    request: request.value,
    owner: input.owner,
    preparation: preparation.value,
    bindingId: input.context.bindingId,
    scope: input.context.scope,
  })
  const prior = ports.prepared(identity)
  if (prior) {
    if (prior.fingerprint !== digest)
      refuse('conflict', 'idempotency_conflict', 'approval preparation identity has different complete input')
    if (!validateRuntime('InteractionRecord', prior.record).ok || prior.record.interactionId !== identity)
      integrity('approval preparation immutable result differs')
    return prior.record
  }
  const record = unwrap(await rules(ports, identity).request({ request: request.value, owner: input.owner }))
  assertCurrent(ports, input.context)
  if (record.interactionId !== identity)
    integrity('approval idempotency source belongs to another preparation')
  await ports.stagePreparation(identity, digest, record, { ...preparation.value, command })
  assertCurrent(ports, input.context)
  return record
}

/** Answer, complete replay proof and wake all remain staged until the original owner commits. */
export async function resolveApprovalInTransaction(
  ports: ApprovalJointPorts,
  input: ApprovalResolutionInput,
): Promise<InteractionResponseStatus> {
  const request = validateRuntime('ApprovalRespondRequest', input.request)
  if (!request.ok) refuse('invalid_input', 'approval_response', 'approval response source is invalid')
  const actual = responder(ports, input)
  const digest = fingerprint({
    method: 'respondApproval',
    request: request.value,
    actorRef: actual.actorRef,
    evidence: actual.evidence,
    bindingId: input.context.bindingId,
    scope: input.context.scope,
  })
  const prior = ports.fullResponse(request.value.responseId)
  if (
    prior &&
    (!validateRuntime('InteractionResponseStatus', prior.response.status).ok ||
      prior.response.responseId !== request.value.responseId ||
      prior.response.status.responseId !== request.value.responseId ||
      prior.response.status.interactionId !== request.value.interactionId)
  )
    integrity('approval response immutable result identity differs')
  if (prior && prior.fingerprint !== digest)
    refuse('conflict', 'idempotency_conflict', 'approval response identity has different complete input')
  const tx = ports.interaction
  const adapter: InteractionTransaction = {
    record: (id) => tx.record(id),
    recordByIdempotencyKey: (key) => tx.recordByIdempotencyKey(key),
    response: (id) => {
      if (id !== request.value.responseId) integrity('approval rule requested another response')
      const existing = tx.response(id)
      if (!!existing !== !!prior || (existing && prior && jcs(existing) !== jcs(prior.response)))
        integrity('approval response cache differs from its original membership proof')
      return prior?.response
    },
    putRecord: (record) => tx.putRecord(record),
    putResponse: (response) => ports.stageFullResponse(digest, response, request.value, actual),
    wake: (key) => tx.wake(key),
    dueWakes: (now, limit) => tx.dueWakes(now, limit),
    putWake: (wake) => {
      tx.putWake(wake)
      ports.stageResolvedWake(wake)
    },
  }
  const status = unwrap(
    await rules(ports, request.value.interactionId, adapter).respond({
      method: 'respondApproval',
      request: request.value,
      actorRef: actual.actorRef,
      evidence: actual.evidence,
    }),
  )
  if (fingerprint(responder(ports, input)) !== fingerprint(actual))
    refuse('denied', 'approval_authentication', 'approval responder changed across rule await')
  // This operation deliberately creates no taint acknowledgement: State authorization owns that proof.
  return status
}
