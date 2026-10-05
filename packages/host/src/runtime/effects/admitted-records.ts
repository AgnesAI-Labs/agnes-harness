import type { DatabaseSync } from 'node:sqlite'
import { types } from 'node:util'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type ActionRecordValue,
  type AttemptRecordValue,
  type RequestIdentity,
  type RunBinding,
  type RunRecordValue,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { LocalDeploymentIdentity } from '../identity/local-deployment-identity.js'
import { createNativeStateReadOwner } from '../state/native-read-owner.js'
import {
  actionRecordId,
  attemptRecordId,
  digestOf,
  runBindingRecordId,
  runRecordId,
  sameJson,
} from '../state/records.js'
import { refuse } from '../state/refusal.js'
import type { NativeStateRecordFact, RuntimeStateDatabase } from '../state/transactions.js'

export type AdmittedEffectsRecords = Readonly<{
  run: RunRecordValue
  binding: RunBinding
  action: ActionRecordValue
  attempt: AttemptRecordValue
  snapshotId: string
  throughSeq: number
  actionCommitId: string
  attemptCommitId: string
}>

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

function ownFields(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    refuse('denied', 'effects_admitted_record', 'effect selector is not an original data object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    refuse('denied', 'effects_admitted_record', 'effect selector has a foreign prototype')
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
    required.some((key) => !keys.includes(key))
  )
    refuse('denied', 'effects_admitted_record', 'effect selector has unexpected fields')
  const original = new Map<string, PropertyDescriptor>()
  const copy: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor))
      refuse('denied', 'effects_admitted_record', 'effect selector has an accessor')
    original.set(key as string, descriptor)
    copy[key as string] = descriptor.value
  }
  return {
    copy,
    check() {
      if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) return false
      const now = Reflect.ownKeys(value)
      if (now.length !== keys.length || now.some((key, index) => key !== keys[index])) return false
      return [...original].every(([key, before]) => {
        const after = Object.getOwnPropertyDescriptor(value, key)
        return after && 'value' in after && Object.is(after.value, before.value)
      })
    },
  }
}

function captureIds(ids: unknown) {
  const outer = ownFields(ids, ['sessionId', 'runId', 'actionId', 'attemptId'], ['expectedRequestIdentity'])
  for (const key of ['sessionId', 'runId', 'actionId', 'attemptId'] as const)
    if (!validateRuntime('Id', outer.copy[key]).ok)
      refuse('denied', 'effects_admitted_record', 'effect selector id is invalid')
  const identity =
    outer.copy.expectedRequestIdentity === undefined
      ? null
      : ownFields(outer.copy.expectedRequestIdentity, [
          'system',
          'aghRequestId',
          'idempotencyKey',
          'requestDigest',
        ])
  if (identity && !validateRuntime('RequestIdentity', identity.copy).ok)
    refuse('denied', 'effects_admitted_record', 'effect request identity is invalid')
  const value = {
    sessionId: outer.copy.sessionId as string,
    runId: outer.copy.runId as string,
    actionId: outer.copy.actionId as string,
    attemptId: outer.copy.attemptId as string,
    expectedRequestIdentity: identity?.copy as RequestIdentity | undefined,
  }
  return { value, check: () => outer.check() && (identity?.check() ?? true) }
}

/** Historical committed inputs for Host dispatch. This never grants a current physical send. */
export function createAdmittedEffectsRecordReader(
  input: Readonly<{
    originalState: RuntimeStateDatabase
    originalIdentity: LocalDeploymentIdentity
    originalDatabase: DatabaseSync
  }>,
) {
  const reader = createNativeStateReadOwner(input)
  let closed = false
  function denied(): never {
    refuse('denied', 'effects_admitted_record', 'original admitted effect facts are unavailable')
  }
  async function read<T>(
    snapshot: Awaited<ReturnType<typeof reader.openVerifiedSnapshot>>,
    context: CallContext,
    window: { kind: 'action'; runId: string; actionId: string },
    recordId: string,
    schema: (typeof RuntimeSchemaRefs)[keyof typeof RuntimeSchemaRefs],
    definition: 'RunRecordValue' | 'RunBinding' | 'ActionRecordValue' | 'AttemptRecordValue',
  ): Promise<{ value: T; fact: NativeStateRecordFact }> {
    const fact = await reader.readVerifiedRecord(snapshot, recordId, schema, context, window)
    if (!fact) denied()
    const parsed = validateRuntime(definition, fact.value)
    if (!parsed.ok) denied()
    return { value: parsed.value as T, fact }
  }
  return Object.freeze({
    async read(
      context: CallContext,
      ids: Readonly<{
        sessionId: string
        runId: string
        actionId: string
        attemptId: string
        expectedRequestIdentity?: RequestIdentity
      }>,
    ): Promise<AdmittedEffectsRecords> {
      if (closed) denied()
      const selector = captureIds(ids)
      const chosen = selector.value
      const check = () => {
        if (closed || !selector.check()) denied()
      }
      const snapshot = await reader.openVerifiedSnapshot(chosen.sessionId, context)
      const window = { kind: 'action' as const, runId: chosen.runId, actionId: chosen.actionId }
      try {
        check()
        const run = await read<RunRecordValue>(
          snapshot,
          context,
          window,
          runRecordId(chosen.runId),
          RuntimeSchemaRefs.RunRecordValue,
          'RunRecordValue',
        )
        check()
        const binding = await read<RunBinding>(
          snapshot,
          context,
          window,
          runBindingRecordId(chosen.runId),
          RuntimeSchemaRefs.RunBinding,
          'RunBinding',
        )
        check()
        const action = await read<ActionRecordValue>(
          snapshot,
          context,
          window,
          actionRecordId(chosen.actionId),
          RuntimeSchemaRefs.ActionRecordValue,
          'ActionRecordValue',
        )
        check()
        const attempt = await read<AttemptRecordValue>(
          snapshot,
          context,
          window,
          attemptRecordId(chosen.attemptId),
          RuntimeSchemaRefs.AttemptRecordValue,
          'AttemptRecordValue',
        )
        check()
        const target = action.value.intent.target
        const selected = binding.value.providers.filter((provider) => sameJson(provider.binding, target))
        const operations = selected[0]?.descriptor.operations.filter(
          (operation) => operation.method === action.value.intent.method,
        )
        if (
          run.value.runId !== chosen.runId ||
          run.value.sessionId !== chosen.sessionId ||
          run.value.bindingId !== binding.value.bindingId ||
          action.value.actionId !== chosen.actionId ||
          action.value.runId !== chosen.runId ||
          action.value.currentAttemptId !== chosen.attemptId ||
          !['dispatching', 'running', 'unknown', 'reconciling', 'settled'].includes(action.value.state) ||
          attempt.value.attemptId !== chosen.attemptId ||
          attempt.value.actionId !== chosen.actionId ||
          attempt.value.kind !== 'leaf' ||
          attempt.value.bindingId !== binding.value.bindingId ||
          attempt.value.inputDigest !== digestOf(action.value.intent.input) ||
          attempt.value.requestIdentity === null ||
          attempt.value.requestIdentity.requestDigest !== attempt.value.inputDigest ||
          (chosen.expectedRequestIdentity !== undefined &&
            !sameJson(attempt.value.requestIdentity, chosen.expectedRequestIdentity)) ||
          selected.length !== 1 ||
          operations?.length !== 1
        )
          denied()
        return freezeJson({
          run: run.value,
          binding: binding.value,
          action: action.value,
          attempt: attempt.value,
          snapshotId: snapshot.snapshotId,
          throughSeq: snapshot.throughSeq,
          actionCommitId: action.fact.commitId,
          attemptCommitId: attempt.fact.commitId,
        })
      } finally {
        reader.releaseSnapshot(snapshot, context)
      }
    },
    close(): void {
      closed = true
      reader.close()
    },
  })
}
