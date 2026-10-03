import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BindingRef,
  canonicalJsonDigest,
  type DataRef,
  type ExternalRequestRef,
  type ScopeRef,
  type UsageFact,
  type UsageFactRef,
  type UsageMeasurement,
  type UsageRecordRequest,
  type UsageRecordResult,
  validateRuntime,
} from '@agnes/protocol/runtime'

export class UsageOriginFault extends Error {
  constructor(
    readonly detail: 'invalid' | 'conflict' | 'denied' | 'integrity',
    message: string,
  ) {
    super(message)
  }
}
function fail(detail: UsageOriginFault['detail'], message: string): never {
  throw new UsageOriginFault(detail, message)
}
function digest(value: unknown): string {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) return fail('integrity', 'usage source is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export type VerifiedUsageOrigin = Readonly<{
  authorityId: string
  actionId: string
  attemptId: string
  source: BindingRef
  externalRequest: ExternalRequestRef
  scope: ScopeRef
  observedAt: string
  measurement: UsageMeasurement
  /** A genuine registered source codec, never a forged UsageMeasurement reference. */
  measurementRef: DataRef
  /** Verified certainty for corrected facts; no promotion based on the word corrected alone. */
  certainty: UsageFact['certainty']
  sourceDigest: string
  purpose: string
  parentActionId: string | null
}>
export type StoredUsageOrigin = Readonly<{
  authorityId: string
  originKey: string
  fingerprint: string
  revision: number
  latestUsageId: string
  replacements: readonly string[]
}>
export type StoredUsageFact = Readonly<{
  ref: UsageFactRef
  fact: UsageFact
  scope: ScopeRef
  sourceDigest: string
  measurement: UsageMeasurement
  purpose: string
  parentActionId: string | null
}>
/** Original Usage owner resolves actual Attempt/receipt and stores immutable facts in one real transaction. */
export interface UsageOriginTransaction {
  verify(input: UsageRecordRequest, context: CallContext): VerifiedUsageOrigin
  origin(authorityId: string, originKey: string): StoredUsageOrigin | undefined
  fact(usageId: string): StoredUsageFact | undefined
  putFact(record: StoredUsageFact): void
  putOrigin(record: StoredUsageOrigin): void
  replay(identity: string): { fingerprint: string; result: UsageRecordResult } | undefined
  remember(identity: string, fingerprint: string, result: UsageRecordResult): void
  nextRevision(): number
  assertCurrent(context: CallContext): void
}
export interface UsageOriginStore {
  transaction<T>(context: CallContext, body: (tx: UsageOriginTransaction) => T): Promise<T>
}
export function usageOriginKey(
  source: Pick<VerifiedUsageOrigin, 'authorityId' | 'actionId' | 'attemptId' | 'externalRequest'>,
): string {
  return digest({
    authorityId: source.authorityId,
    actionId: source.actionId,
    attemptId: source.attemptId,
    externalRequest: source.externalRequest,
  })
}
export function createUsageOrigins(store: UsageOriginStore) {
  return {
    record(input: UsageRecordRequest, context: CallContext): Promise<UsageRecordResult> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('UsageRecordRequest', input).ok) fail('invalid', 'invalid usage record request')
        const source = clone(tx.verify(input, context))
        if (
          source.actionId !== input.attemptRef.actionId ||
          source.attemptId !== input.attemptRef.attemptId ||
          !validateRuntime('Id', source.authorityId).ok ||
          !validateRuntime('ExternalRequestRef', source.externalRequest).ok ||
          !validateRuntime('UsageMeasurement', source.measurement).ok ||
          !validateRuntime('DataRef', source.measurementRef).ok ||
          digest(source.measurement) !== digest(input.measurement)
        )
          fail('denied', 'usage source differs from its original attempt or measurement')
        if (
          input.externalReceiptRef !== null &&
          digest(input.externalReceiptRef) !== digest(source.measurement.sourceReceipt)
        )
          fail('denied', 'usage source receipt differs')
        const expected =
          input.measurement.kind === 'reported'
            ? 'measured'
            : input.measurement.kind === 'estimated'
              ? 'estimated'
              : input.measurement.kind === 'unknown'
                ? 'unknown'
                : source.certainty
        if (
          source.certainty !== expected ||
          (source.certainty === 'unknown' && source.measurement.quantities.length !== 0)
        )
          fail('denied', 'usage certainty is unsupported by its actual source')
        const body =
          source.measurementRef.kind === 'inline' ? source.measurementRef : source.measurementRef.blob
        if (
          body.digest !== digest(source.measurement) ||
          body.bytes !== new TextEncoder().encode(jcs(source.measurement)).byteLength
        )
          fail('integrity', 'usage dimensions proof differs from actual measurement')
        if (
          source.measurementRef.kind === 'inline' &&
          digest(source.measurementRef.value) !== digest(source.measurement)
        )
          fail('integrity', 'usage dimensions inline value differs')
        const originKey = usageOriginKey(source)
        const fingerprint = digest({
          input,
          sourceDigest: source.sourceDigest,
          purpose: source.purpose,
          parentActionId: source.parentActionId,
        })
        const identity = digest({
          authorityId: source.authorityId,
          originKey,
          measurement: input.measurement,
        })
        const prior = tx.replay(identity)
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail('conflict', 'usage identity has different original source')
          if (!validateRuntime('UsageRecordResult', prior.result).ok)
            fail('integrity', 'original usage replay result is invalid')
          for (const reference of prior.result.factRefs) {
            const original = tx.fact(reference.usageId)
            if (
              !original ||
              digest(original.ref) !== digest(reference) ||
              digest(original.fact) !== reference.digest ||
              original.fact.originKey !== originKey ||
              original.ref.authorityId !== source.authorityId
            )
              fail('integrity', 'original usage replay fact proof differs')
          }
          tx.assertCurrent(context)
          return clone(prior.result)
        }
        const origin = tx.origin(source.authorityId, originKey)
        if (origin && (origin.authorityId !== source.authorityId || origin.originKey !== originKey))
          fail('integrity', 'stored usage origin identity differs')
        const replacements = source.measurement.replacesFactIds
        if (input.measurement.kind === 'corrected') {
          if (!origin || replacements.length !== 1 || replacements[0] !== origin.latestUsageId)
            fail('conflict', 'correction does not replace the current original usage fact')
          const replaced = tx.fact(origin.latestUsageId)
          if (
            !replaced ||
            replaced.ref.authorityId !== source.authorityId ||
            replaced.fact.originKey !== originKey ||
            digest(replaced.fact) !== replaced.ref.digest
          )
            fail('integrity', 'correction original fact membership is missing')
        } else if (origin || replacements.length !== 0)
          fail('conflict', 'changed usage requires a verified correction')
        const usageId = `usage-${digest({ identity, fingerprint })}`
        if (tx.fact(usageId)) fail('integrity', 'new usage identity already has an immutable fact')
        const fact: UsageFact = {
          usageId,
          originKey,
          actionId: source.actionId,
          attemptId: source.attemptId,
          source: source.source,
          dimensions: source.measurementRef,
          externalRequest: source.externalRequest,
          observedAt: source.observedAt,
          certainty: source.certainty,
        }
        if (!validateRuntime('UsageFact', fact).ok)
          fail('integrity', 'source cannot produce a valid official usage fact')
        const ref: UsageFactRef = { authorityId: source.authorityId, usageId, digest: digest(fact) }
        const revision = tx.nextRevision()
        if (!Number.isSafeInteger(revision) || revision < 1 || (origin && revision <= origin.revision))
          fail('integrity', 'usage authority revision is not monotonic')
        tx.putFact({
          ref,
          fact,
          scope: source.scope,
          sourceDigest: source.sourceDigest,
          measurement: source.measurement,
          purpose: source.purpose,
          parentActionId: source.parentActionId,
        })
        tx.putOrigin({
          authorityId: source.authorityId,
          originKey,
          fingerprint,
          revision,
          latestUsageId: usageId,
          replacements: [...(origin?.replacements ?? []), ...replacements],
        })
        const result: UsageRecordResult = { factRefs: [ref], revision }
        tx.remember(identity, fingerprint, result)
        tx.assertCurrent(context)
        return clone(result)
      })
    },
  }
}
