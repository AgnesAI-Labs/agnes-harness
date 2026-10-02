import { pid } from 'node:process'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeSchemaRefs, RuntimeServiceCatalog, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, CaseContext, ConformanceHarness, TestServiceBinding } from '../harness.js'

const CONTRACT = 'agh.interaction'
const HEX = /^[a-f0-9]{64}$/

/**
 * Facts each scenario reports. A binding only drives its implementation and reads back; this module
 * decides whether the facts meet the interaction rules, so every implementation is judged the same way.
 */
export interface InteractionObservations {
  /** The binding the provider offers. The contract registers it and resolves it through the container. */
  readonly select: { readonly binding: TestServiceBinding }
  /**
   * One pending approval answered with the grant scope left out, the same response repeated, and the wake
   * delivered twice through the inbox fixture. Statuses are read after answering, repeating and delivery.
   */
  readonly normal: {
    readonly statuses: readonly string[]
    readonly record: Wire.InteractionRecord
    readonly woken: number
  }
  /**
   * Wrong actor, forged intent, stale version, a request with a field its schema does not define and a
   * grant scope the question does not offer, in that order, against one pending approval.
   */
  readonly deny: {
    readonly refusals: readonly (string | null)[]
    readonly record: Wire.InteractionRecord
    readonly woken: number
  }
  /**
   * Three approvals due at the same moment: one cancelled, one expired once due and one left overdue
   * without an expiry. Each then gets an answer at version 1, as a client that missed the change sends
   * it. Records and the late responses' statuses are read after a restart once wakes are delivered;
   * `woken` counts wakes for every version past the first.
   */
  readonly cancel: {
    readonly records: readonly Wire.InteractionRecord[]
    readonly refusals: readonly (string | null)[]
    readonly statuses: readonly string[]
    readonly woken: number
  }
  /**
   * A provider process killed with SIGKILL after committing one answer while a second was still
   * uncommitted, then a second process killed after handing the committed wake to the inbox but before
   * recording the acknowledgement. `kills` holds each exit signal and pid, in that order. The rest is
   * read after the store is rebuilt from disk: statuses of the committed response before and after
   * redelivery, pending wakes before it, and how often the wake reached the inbox across both processes.
   */
  readonly recover: {
    readonly kills: readonly { readonly signal: string | null; readonly pid: number | null }[]
    readonly record: Wire.InteractionRecord
    readonly uncommitted: Wire.InteractionRecord
    readonly uncommittedStatus: string
    readonly statuses: readonly string[]
    readonly pendingWakes: number
    readonly delivered: number
    readonly woken: number
  }
  /**
   * Whether use after close was refused, the database file is still there and a mount over a file that
   * is not a store was refused. `handles` counts open file descriptors before any store is open, after
   * the refused mount and after a store is opened and closed again. The counts are null only where the
   * platform offers nothing to count them with, which means not measurable there, never passed.
   */
  readonly dispose: {
    readonly refused: boolean
    readonly storeRemains: boolean
    readonly mountRefused: boolean
    readonly handles: {
      readonly baseline: number | null
      readonly afterFailedMount: number | null
      readonly afterClose: number | null
    }
  }
}

export type InteractionContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<InteractionObservations[K]>
}

export interface InteractionConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the provider code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly port: InteractionContractPort
}

const same = (left: readonly unknown[], right: readonly unknown[]) =>
  JSON.stringify(left) === JSON.stringify(right)

const at = (record: Wire.InteractionRecord, status: string, version: number) =>
  validateRuntime('InteractionRecord', record).ok && record.status === status && record.version === version

function approvedOnce(record: Wire.InteractionRecord): boolean {
  if (record.status !== 'answered' || record.resolution.answer.kind !== 'inline') return false
  const { schema, value } = record.resolution.answer
  return (
    schema.typeId === RuntimeSchemaRefs.ApprovalAnswer.typeId &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.decision === 'approve' &&
    value.grantScope === 'once'
  )
}

/** Every count back at the baseline, or no count at all where descriptors cannot be counted. */
function returned({ baseline, afterFailedMount, afterClose }: InteractionObservations['dispose']['handles']) {
  return baseline === null
    ? afterFailedMount === null && afterClose === null
    : afterFailedMount === baseline && afterClose === baseline
}

function selected(binding: TestServiceBinding, context: CaseContext, providerId: string): boolean {
  const { requirement } = binding
  if (requirement.contract !== CONTRACT || requirement.major !== RuntimeServiceCatalog[CONTRACT].major)
    return false
  try {
    context.container.register(binding)
  } catch {
    return false
  }
  const chosen = context.container.dependencies.get(requirement)
  return chosen.ok && chosen.value.binding.providerId === providerId
}

type Judge = {
  readonly [K in ScenarioName]: (
    seen: InteractionObservations[K],
    context: CaseContext,
    providerId: string,
  ) => boolean
}

const JUDGE: Judge = {
  select: (seen, context, providerId) => selected(seen.binding, context, providerId),
  normal: (seen) =>
    same(seen.statuses, ['accepted', 'accepted', 'applied']) &&
    at(seen.record, 'answered', 2) &&
    approvedOnce(seen.record) &&
    seen.woken === 1,
  deny: (seen) =>
    same(seen.refusals, [
      'permission_denied',
      'invalid_request',
      'revision_conflict',
      'invalid_request',
      'invalid_request',
    ]) &&
    at(seen.record, 'pending', 1) &&
    seen.woken === 0,
  cancel: (seen) =>
    same(
      seen.records.map((record) => [record.status, record.version]),
      [
        ['cancelled', 2],
        ['expired', 2],
        ['pending', 1],
      ],
    ) &&
    seen.records.every((record) => at(record, record.status, record.version)) &&
    seen.records.slice(0, 2).every((record) => record.terminationReason !== null) &&
    same(seen.refusals, ['revision_conflict', 'revision_conflict', 'blocked']) &&
    same(seen.statuses, ['not-accepted', 'not-accepted', 'not-accepted']) &&
    seen.woken === 2,
  recover: (seen) =>
    seen.kills.length === 2 &&
    seen.kills.every((kill) => kill.signal === 'SIGKILL' && kill.pid !== null && kill.pid !== pid) &&
    at(seen.record, 'answered', 2) &&
    at(seen.uncommitted, 'pending', 1) &&
    seen.uncommittedStatus === 'not-accepted' &&
    same(seen.statuses, ['accepted', 'applied']) &&
    seen.pendingWakes === 1 &&
    seen.delivered === 2 &&
    seen.woken === 1,
  dispose: (seen) => seen.refused && seen.storeRemains && seen.mountRefused && returned(seen.handles),
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['request'],
  normal: ['request', 'respondApproval', 'responseStatus'],
  deny: ['request', 'respondApproval'],
  cancel: ['cancel', 'expire', 'read', 'respondApproval', 'responseStatus'],
  recover: ['read', 'responseStatus'],
  dispose: ['read'],
}

const FIXTURE: Record<ScenarioName, AssertionInput['fixture']> = {
  select: 'test-service-container',
  normal: 'runtime-inbox',
  deny: 'runtime-inbox',
  cancel: 'runtime-inbox',
  recover: 'runtime-inbox',
  dispose: null,
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

async function observe<K extends ScenarioName>(
  scenario: K,
  binding: InteractionConformanceBinding,
  context: CaseContext,
): Promise<boolean> {
  const seen = await binding.port[scenario](context)
  return JUDGE[scenario](seen, context, binding.providerId)
}

/** Register select, normal, deny, cancel, recover and dispose for one interaction provider. */
export function registerInteractionContract(
  harness: ConformanceHarness,
  binding: InteractionConformanceBinding,
): void {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(context): Promise<AssertionInput> {
        const passed =
          digests.every((digest) => HEX.test(digest)) && (await observe(scenario, binding, context))
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...FEATURES[scenario]],
          build: binding.build,
          consumer: 'interaction-conformance-consumer',
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: FIXTURE[scenario],
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
