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
  /** Wrong actor, forged intent and stale version, in that order, against one pending approval. */
  readonly deny: {
    readonly refusals: readonly (string | null)[]
    readonly record: Wire.InteractionRecord
    readonly woken: number
  }
  /** One interaction cancelled and another expired once due, both read back and their wakes delivered. */
  readonly cancel: { readonly records: readonly Wire.InteractionRecord[]; readonly woken: number }
  /**
   * An answer whose wake reached the inbox without being acknowledged, read back after the store is
   * reopened. Statuses are read before and after redelivery; pending wakes are counted before it.
   */
  readonly recover: {
    readonly record: Wire.InteractionRecord
    readonly statuses: readonly string[]
    readonly pendingWakes: number
    readonly woken: number
  }
  /** Whether use after close was refused and the database file is still there. */
  readonly dispose: { readonly refused: boolean; readonly storeRemains: boolean }
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
    same(seen.refusals, ['permission_denied', 'invalid_request', 'revision_conflict']) &&
    at(seen.record, 'pending', 1) &&
    seen.woken === 0,
  cancel: (seen) =>
    same(
      seen.records.map((record) => record.status),
      ['cancelled', 'expired'],
    ) &&
    seen.records.every((record) => at(record, record.status, 2) && record.terminationReason !== null) &&
    seen.woken === 2,
  recover: (seen) =>
    at(seen.record, 'answered', 2) &&
    same(seen.statuses, ['accepted', 'applied']) &&
    seen.pendingWakes === 1 &&
    seen.woken === 1,
  dispose: (seen) => seen.refused && seen.storeRemains,
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['request'],
  normal: ['request', 'respondApproval', 'responseStatus'],
  deny: ['request', 'respondApproval'],
  cancel: ['cancel', 'expire', 'read'],
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
