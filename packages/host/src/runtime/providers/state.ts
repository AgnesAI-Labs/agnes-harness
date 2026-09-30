import { defaultIds } from '@agnes/core'
import type {
  CallContext,
  Outcome,
  RuntimeError,
  RuntimeErrorCode,
  StateAuthorityRef,
  StateStoreControl,
} from '@agnes/extension-api/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import {
  openRuntimeStateDatabase,
  type RuntimeDurability,
  type RuntimeStateDatabaseOptions,
  StateRefusal,
} from '../state/transactions.js'

export const UNIMPLEMENTED_STATE_METHODS = [
  'abortMigration',
  'acceptBridgeChild',
  'acceptInbox',
  'acceptServiceCommand',
  'ackOutbox',
  'admitQuery',
  'advanceProvider',
  'appendStream',
  'beginMigration',
  'beginReconciliation',
  'cancelAdmission',
  'cancelPreparedActionAdmission',
  'claimOutbox',
  'commitMigratedRun',
  'completeReconciliation',
  'createChild',
  'failOutbox',
  'fireTimer',
  'importConversation',
  'intakeReceipt',
  'probeActionResult',
  'probeAdmission',
  'probeBridgeChild',
  'probeConversationImport',
  'probeMigration',
  'probePreparedActionAdmission',
  'pruneRecordVersions',
  'publishActionResult',
  'readServiceCommand',
  'readSessionControl',
  'registerStream',
  'sessionControlStatus',
  'submitSessionControl',
] as const

export type UnimplementedStateMethod = (typeof UNIMPLEMENTED_STATE_METHODS)[number]

export type RuntimeStateStore = StateStoreControl & {
  close(): void
  durability(): RuntimeDurability
}

function sameAuthority(left: StateAuthorityRef, right: StateAuthorityRef): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.tenantId === right.tenantId &&
    left.authorityEpoch === right.authorityEpoch
  )
}

export function createRuntimeStateStore(options: RuntimeStateDatabaseOptions): RuntimeStateStore {
  const database = openRuntimeStateDatabase(options)
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
  const run = async <T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> => {
    if (context.signal.aborted) return failure('cancelled', 'aborted', 'call was cancelled')
    try {
      return { ok: true, value: await body() }
    } catch (caught) {
      if (caught instanceof StateRefusal)
        return Promise.resolve({
          ok: false,
          error: error(caught.failure.code, caught.failure.detailCode, caught.failure.message),
        })
      return Promise.resolve(failure('internal', 'fault', 'state store failed'))
    }
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
      return run(context, () => database.createRun({ admission: result.value, scope: context.scope }))
    },
    acceptServiceCommand: (_request, context) => unavailable('acceptServiceCommand', context),
    readServiceCommand: (_request, context) => unavailable('readServiceCommand', context),
    importConversation: (_request, context) => unavailable('importConversation', context),
    probeConversationImport: (_requestId, context) => unavailable('probeConversationImport', context),
    createChild: (_request, context) => unavailable('createChild', context),
    cancelAdmission: (_ticketId, _fingerprint, context) => unavailable('cancelAdmission', context),
    cancelPreparedActionAdmission: (_request, context) =>
      unavailable('cancelPreparedActionAdmission', context),
    probePreparedActionAdmission: (_request, context) => unavailable('probePreparedActionAdmission', context),
    readSessionControl: (_request, context) => unavailable('readSessionControl', context),
    submitSessionControl: (_request, context) => unavailable('submitSessionControl', context),
    sessionControlStatus: (_request, context) => unavailable('sessionControlStatus', context),
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
    probeAdmission: (_ticketId, context) => unavailable('probeAdmission', context),
    admitInvocation: (request, context) => {
      const result = validateRuntime('InvocationAdmission', request)
      if (!result.ok)
        return Promise.resolve(failure('invalid_input', 'schema', 'InvocationAdmission is not valid'))
      return run(context, () => database.admitInvocation(result.value))
    },
    admitQuery: (_request, context) => unavailable('admitQuery', context),
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
    advanceProvider: (_request, context) => unavailable('advanceProvider', context),
    dispatchAdmission: (request, context) => {
      const result = validateRuntime('DispatchAdmissionRequest', request)
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
    intakeReceipt: (_request, context) => unavailable('intakeReceipt', context),
    publishActionResult: (_request, context) => unavailable('publishActionResult', context),
    probeActionResult: (_request, context) => unavailable('probeActionResult', context),
    acceptInbox: (_delivery, context) => unavailable('acceptInbox', context),
    claimOutbox: (_request, context) => unavailable('claimOutbox', context),
    ackOutbox: (_request, context) => unavailable('ackOutbox', context),
    failOutbox: (_request, context) => unavailable('failOutbox', context),
    pruneRecordVersions: (_request, context) => unavailable('pruneRecordVersions', context),
    close: () => database.close(),
    durability: () => database.durability(),
  }
  return store
}
