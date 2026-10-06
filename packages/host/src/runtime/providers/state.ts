import { defaultIds } from '@agnes/core'
import type {
  AckOutboxRequest,
  AckOutboxResult,
  AdvanceRunRequest,
  CallContext,
  CloseInvocationRequest,
  DispatchAdmissionRequest,
  DispatchAdmissionResult,
  InvocationAdmission,
  Outcome,
  RuntimeError,
  RuntimeErrorCode,
  StateAuthorityRef,
  StateCommitReceipt,
  StateStoreControl,
} from '@agnes/extension-api/runtime'
import type {
  InteractionClientPendingRequest,
  InteractionRecord,
  InteractionResponseStatus,
  PageInteractionRecord,
} from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import type { ApprovalPreparationInput, ApprovalResolutionInput } from '../state/approval.js'
import { enterPhase, leavePhase, profiling } from '../state/profile.js'
import {
  matchesRuntimeStateDatabaseOptions,
  openRuntimeStateDatabase,
  type RuntimeDurability,
  type RuntimeStateDatabase,
  type RuntimeStateDatabaseOptions,
  StateRefusal,
} from '../state/transactions.js'

export const UNIMPLEMENTED_STATE_METHODS = [
  'abortMigration',
  'acceptBridgeChild',
  'acceptInbox',
  'acceptServiceCommand',
  'appendStream',
  'beginMigration',
  'beginReconciliation',
  'cancelPreparedActionAdmission',
  'commitMigratedRun',
  'completeReconciliation',
  'createChild',
  'fireTimer',
  'importConversation',
  'probeBridgeChild',
  'probeConversationImport',
  'probeMigration',
  'probePreparedActionAdmission',
  'pruneRecordVersions',
  'publishActionResult',
  'readServiceCommand',
  'registerStream',
] as const

export type UnimplementedStateMethod = (typeof UNIMPLEMENTED_STATE_METHODS)[number]

export type RuntimeStateStore = StateStoreControl & {
  close(): void
  durability(): RuntimeDurability
  /** Host-private default-provider composition in the original State transaction. */
  prepareApproval(input: ApprovalPreparationInput): Promise<Outcome<InteractionRecord>>
  resolveApproval(input: ApprovalResolutionInput): Promise<Outcome<InteractionResponseStatus>>
  readInteraction(interactionId: string, context: CallContext): Promise<Outcome<InteractionRecord>>
  readInteractionResponseStatus(
    responseId: string,
    context: CallContext,
  ): Promise<Outcome<InteractionResponseStatus>>
  pendingInteractions(
    request: InteractionClientPendingRequest,
    context: CallContext,
  ): Promise<Outcome<PageInteractionRecord>>
  /** Host-internal. Not part of StateStoreControl. One state-commit covers admit, close, and advance. */
  commitPreparedAdvance(
    commitId: string,
    admit: InvocationAdmission,
    close: CloseInvocationRequest,
    advance: AdvanceRunRequest,
    context: CallContext,
  ): Promise<Outcome<StateCommitReceipt>>
  /** Host-internal. One state-commit covers a model tool batch. Intake stays separate. */
  commitDispatchBatch(
    commitId: string,
    requests: readonly DispatchAdmissionRequest[],
    context: CallContext,
  ): Promise<Outcome<DispatchAdmissionResult[]>>
  /** Host-internal. One transaction covers many acknowledgements. */
  ackOutboxMany(
    requests: readonly AckOutboxRequest[],
    context: CallContext,
  ): Promise<Outcome<AckOutboxResult[]>>
}

function sameAuthority(left: StateAuthorityRef, right: StateAuthorityRef): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.tenantId === right.tenantId &&
    left.authorityEpoch === right.authorityEpoch
  )
}

function validateProfiled<K extends 'DispatchAdmissionRequest' | 'ReceiptIntakeRequest'>(
  kind: K,
  value: unknown,
): ReturnType<typeof validateRuntime<K>> {
  if (!profiling) return validateRuntime(kind, value)
  enterPhase('schema')
  try {
    return validateRuntime(kind, value)
  } finally {
    leavePhase()
  }
}

export function createRuntimeStateStore(
  options: RuntimeStateDatabaseOptions,
  supplied?: RuntimeStateDatabase,
): RuntimeStateStore {
  if (supplied && !matchesRuntimeStateDatabaseOptions(supplied, options))
    throw new StateRefusal({
      code: 'denied',
      detailCode: 'state_owner',
      message: 'supplied State owner does not match its original native configuration',
    })
  const database = supplied ?? openRuntimeStateDatabase(options)
  const ids = defaultIds(options.now ?? (() => Date.now()))
  const error = (code: RuntimeErrorCode, detailCode: string, message: string): RuntimeError => ({
    code,
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: ids.ulid(),
  })
  const failure = (code: RuntimeErrorCode, detailCode: string, message: string): Outcome<never> => ({
    ok: false,
    error: error(code, detailCode, message),
  })
  const run = async <T>(
    context: CallContext,
    body: () => T | Promise<T>,
    approvalError = false,
  ): Promise<Outcome<T>> => {
    if (context.signal.aborted) return failure('cancelled', 'aborted', 'call was cancelled')
    try {
      return { ok: true, value: await body() }
    } catch (caught) {
      if (caught instanceof StateRefusal)
        return Promise.resolve({
          ok: false,
          error: error(caught.failure.code, caught.failure.detailCode, caught.failure.message),
        })
      if (approvalError) {
        const checked = validateRuntime('RuntimeError', caught)
        if (checked.ok) return { ok: false, error: checked.value }
      }
      return Promise.resolve(failure('internal', 'fault', 'state store failed'))
    }
  }
  const query = async <T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> => {
    const result = await run(context, body, true)
    if (!result.ok && result.error.detailCode === 'resync_required')
      return { ok: false, error: { ...result.error, retryAdvice: { kind: 'retry_read' } } }
    return result
  }
  const unavailable = <T>(method: UnimplementedStateMethod, context: CallContext): Promise<Outcome<T>> =>
    run(context, () => {
      throw new StateRefusal({
        code: 'internal',
        detailCode: 'not implemented',
        message: `${method} is not implemented`,
      })
    })
  const rejectAuthority = (authority: StateAuthorityRef): Outcome<never> | undefined =>
    sameAuthority(authority, options.authority)
      ? undefined
      : failure('conflict', 'authority', 'authority does not match this store')

  const store: RuntimeStateStore = {
    readInteraction: (id, context) => query(context, () => database.readInteraction(id, context)),
    readInteractionResponseStatus: (id, context) =>
      query(context, () => database.readInteractionResponseStatus(id, context)),
    pendingInteractions: (request, context) =>
      query(context, () => database.pendingInteractions(request, context)),
    prepareApproval: (input) => run(input.context, () => database.prepareApproval(input), true),
    resolveApproval: (input) => run(input.context, () => database.resolveApproval(input), true),
    open: (request, context) => {
      const result = validateRuntime('StateOpenRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'StateOpenRequest is not valid'))
      const rejected = rejectAuthority(result.value.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.open(result.value))
    },
    lease: (request, context) => {
      const result = validateRuntime('StateLeaseRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'StateLeaseRequest is not valid'))
      const rejected = rejectAuthority(result.value.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.lease(result.value))
    },
    createRun: (admission, context) => {
      const result = validateRuntime('RunAdmission', admission)
      if (!result.ok) return Promise.resolve(failure('invalid_input', 'schema', 'RunAdmission is not valid'))
      return run(context, () =>
        database.createRun({ admission: result.value, scope: context.scope }, context),
      )
    },
    acceptServiceCommand: (_request, context) => unavailable('acceptServiceCommand', context),
    readServiceCommand: (_request, context) => unavailable('readServiceCommand', context),
    importConversation: (_request, context) => unavailable('importConversation', context),
    probeConversationImport: (_requestId, context) => unavailable('probeConversationImport', context),
    createChild: (_request, context) => unavailable('createChild', context),
    cancelAdmission: (ticketId, fingerprint, context) => {
      const checked = validateRuntime('StateCancelAdmissionRequest', { ticketId, fingerprint })
      if (!checked.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'StateCancelAdmissionRequest is not valid'))
      return run(context, () => database.cancelAdmission(ticketId, fingerprint, context))
    },
    cancelPreparedActionAdmission: (_request, context) =>
      unavailable('cancelPreparedActionAdmission', context),
    probePreparedActionAdmission: (_request, context) => unavailable('probePreparedActionAdmission', context),
    readSessionControl: (request, context) => {
      const parsed = validateRuntime('StateStoreControlReadSessionControlRequest', request)
      if (!parsed.ok)
        return Promise.resolve(
          failure('invalid_input', 'session_control_request', 'read input violates its codec'),
        )
      return run(context, () => database.readSessionControl(parsed.value.sessionId, context))
    },
    submitSessionControl: (request, context) => {
      const parsed = validateRuntime('SessionControlRequest', request)
      if (!parsed.ok)
        return Promise.resolve(
          failure('invalid_input', 'session_control_request', 'submit input violates its codec'),
        )
      return run(context, () => database.submitSessionControl(parsed.value, context))
    },
    sessionControlStatus: (request, context) => {
      const parsed = validateRuntime('StateStoreControlSessionControlStatusRequest', request)
      if (!parsed.ok)
        return Promise.resolve(
          failure('invalid_input', 'session_control_request', 'status input violates its codec'),
        )
      return run(context, () => database.sessionControlStatus(parsed.value, context))
    },
    fireTimer: (_request, context) => unavailable('fireTimer', context),
    registerStream: (_request, context) => unavailable('registerStream', context),
    appendStream: (_request, context) => unavailable('appendStream', context),
    beginReconciliation: (_request, context) => unavailable('beginReconciliation', context),
    completeReconciliation: (_request, context) => unavailable('completeReconciliation', context),
    acceptBridgeChild: (_request, context) => unavailable('acceptBridgeChild', context),
    probeBridgeChild: (_request, context) => unavailable('probeBridgeChild', context),
    beginMigration: (_request, context) => unavailable('beginMigration', context),
    commitMigratedRun: (_request, context) => unavailable('commitMigratedRun', context),
    abortMigration: (_request, context) => unavailable('abortMigration', context),
    probeMigration: (_upgradeId, context) => unavailable('probeMigration', context),
    probeAdmission: (ticketId, context) => {
      const checked = validateRuntime('Id', ticketId)
      if (!checked.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'admission ticket Id is not valid'))
      return run(context, () => database.probeAdmission(ticketId, context))
    },
    admitInvocation: (request, context) => {
      const result = validateRuntime('InvocationAdmission', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'InvocationAdmission is not valid'))
      return run(context, () => database.admitInvocation(result.value))
    },
    admitQuery: (request, context) => {
      const result = validateRuntime('QueryAdmission', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'QueryAdmission is not valid'))
      return run(context, () => database.admitQuery(result.value))
    },
    closeInvocation: (request, context) => {
      const result = validateRuntime('CloseInvocationRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'CloseInvocationRequest is not valid'))
      return run(context, () => database.closeInvocation(result.value))
    },
    advanceRun: (request, context) => {
      const result = validateRuntime('AdvanceRunRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'AdvanceRunRequest is not valid'))
      const rejected = rejectAuthority(result.value.guard.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.advanceRun(result.value))
    },
    advanceProvider: (request, context) => {
      const result = validateRuntime('AdvanceProviderRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'AdvanceProviderRequest is not valid'))
      const rejected = rejectAuthority(result.value.guard.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.advanceProvider(result.value))
    },
    dispatchAdmission: (request, context) => {
      const result = validateProfiled('DispatchAdmissionRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'DispatchAdmissionRequest is not valid'))
      const rejected = rejectAuthority(result.value.guard.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.dispatchAdmission(result.value))
    },
    probeDispatchAdmission: (admissionId, context) => {
      const result = validateRuntime('Id', admissionId)
      if (!result.ok) return Promise.resolve(failure('invalid_input', 'schema', 'Id is not valid'))
      return run(context, () => database.probeDispatchAdmission(result.value))
    },
    commitControl: (request, context) => {
      const result = validateRuntime('CommitControlRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'CommitControlRequest is not valid'))
      const rejected = rejectAuthority(result.value.guard.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () => database.commitControl(result.value))
    },
    intakeReceipt: (request, context) => {
      const result = validateProfiled('ReceiptIntakeRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'ReceiptIntakeRequest is not valid'))
      return run(context, () => database.intakeReceipt(result.value))
    },
    publishActionResult: (_request, context) => unavailable('publishActionResult', context),
    probeActionResult: (request, context) => {
      const result = validateRuntime('ProbeActionResultRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'ProbeActionResultRequest is not valid'))
      return run(context, () => database.probeActionResult(result.value))
    },
    acceptInbox: (_delivery, context) => unavailable('acceptInbox', context),
    claimOutbox: (request, context) => {
      const result = validateRuntime('ClaimOutboxRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'ClaimOutboxRequest is not valid'))
      return run(context, () => database.claimOutbox(result.value))
    },
    ackOutbox: (request, context) => {
      const result = validateRuntime('AckOutboxRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'AckOutboxRequest is not valid'))
      return run(context, () => database.ackOutbox(result.value))
    },
    failOutbox: (request, context) => {
      const result = validateRuntime('FailOutboxRequest', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'FailOutboxRequest is not valid'))
      return run(context, () => database.failOutbox(result.value))
    },
    pruneRecordVersions: (_request, context) => unavailable('pruneRecordVersions', context),
    commitPreparedAdvance: (commitId, admit, close, advance, context) => {
      const admitted = validateRuntime('InvocationAdmission', admit)
      if (!admitted.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'InvocationAdmission is not valid'))
      const closed = validateRuntime('CloseInvocationRequest', close)
      if (!closed.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'CloseInvocationRequest is not valid'))
      const advanced = validateRuntime('AdvanceRunRequest', advance)
      if (!advanced.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'AdvanceRunRequest is not valid'))
      const rejected = rejectAuthority(advanced.value.guard.authority)
      if (rejected) return Promise.resolve(rejected)
      return run(context, () =>
        database.commitPreparedAdvance(commitId, admitted.value, closed.value, advanced.value),
      )
    },
    commitDispatchBatch: (commitId, requests, context) => {
      const validated: DispatchAdmissionRequest[] = []
      for (const request of requests) {
        const result = validateRuntime('DispatchAdmissionRequest', request)
        if (!result.ok)
          return Promise.resolve(failure('invalid_input', 'schema', 'DispatchAdmissionRequest is not valid'))
        const rejected = rejectAuthority(result.value.guard.authority)
        if (rejected) return Promise.resolve(rejected)
        validated.push(result.value)
      }
      return run(context, () => database.commitDispatchBatch(commitId, validated))
    },
    ackOutboxMany: (requests, context) => {
      const validated: AckOutboxRequest[] = []
      for (const request of requests) {
        const result = validateRuntime('AckOutboxRequest', request)
        if (!result.ok)
          return Promise.resolve(failure('invalid_input', 'schema', 'AckOutboxRequest is not valid'))
        validated.push(result.value)
      }
      return run(context, () => database.ackOutboxMany(validated))
    },
    close: () => database.close(),
    durability: () => database.durability(),
  }
  return store
}
