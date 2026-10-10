/** Pure validation and replay of the portable append-only record stream. */

import { InvalidDecisionToolSnapshot, readDecisionToolSnapshot } from './decision-tools.js'
import type {
  ArtifactRef,
  FrozenIntent,
  IntentId,
  LedgerEntry,
  ModelSettlement,
  Observation,
  RecordedObservation,
  RecordId,
  RuntimeRecord,
} from './types.js'

/** Malformed or contradictory durable history is refused before new work. */
export class InvalidLedger extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidLedger'
  }
}

/** Causal state reconstructed solely from committed records. */
export interface ReplayState {
  readonly records: readonly RuntimeRecord[]
  readonly requests: ReadonlyMap<RecordId, RuntimeRecord & { kind: 'model.requested' }>
  readonly modelSettlements: ReadonlyMap<RecordId, ModelSettlement>
  readonly intents: ReadonlyMap<IntentId, FrozenIntent>
  readonly dispatching: ReadonlySet<IntentId>
  readonly actions: ReadonlyMap<IntentId, RuntimeRecord & { kind: 'action.settled' }>
  readonly resolutions: ReadonlyMap<IntentId, RuntimeRecord & { kind: 'action.resolved' }>
  readonly observations: readonly RecordedObservation[]
  readonly unresolved: readonly IntentId[]
  readonly lastStop?: RuntimeRecord & { kind: 'run.stopped' }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!object(value) && !Array.isArray(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => json(item, seen))
    : Object.values(value).every((item) => json(item, seen))
  seen.delete(value)
  return valid
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}

function artifact(value: unknown): boolean {
  return (
    object(value) &&
    nonempty(value.id) &&
    nonempty(value.digest) &&
    nonempty(value.mediaType) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0
  )
}

function content(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        object(block) &&
        ((block.kind === 'text' && typeof block.text === 'string') ||
          (block.kind === 'artifact' &&
            artifact(block.artifact) &&
            (block.label === undefined || typeof block.label === 'string'))),
    )
  )
}

function input(value: unknown): boolean {
  return (
    object(value) &&
    nonempty(value.id) &&
    nonempty(value.source) &&
    content(value.content) &&
    (value.snapshot === undefined ||
      (object(value.snapshot) && nonempty(value.snapshot.codec) && json(value.snapshot.value)))
  )
}

function outcome(value: unknown): boolean {
  return (
    object(value) &&
    oneOf(value.kind, ['success', 'error', 'cancelled']) &&
    content(value.content) &&
    object(value.directive) &&
    typeof value.directive.conclude === 'boolean' &&
    Array.isArray(value.directive.additions) &&
    value.directive.additions.every(input) &&
    (value.value === undefined || json(value.value)) &&
    (value.meta === undefined || json(value.meta)) &&
    (value.effect === undefined ||
      oneOf(value.effect, ['none', 'not_applied', 'acknowledged', 'applied', 'unknown'])) &&
    (value.effectEvidence === undefined || json(value.effectEvidence)) &&
    (value.error === undefined ||
      (object(value.error) &&
        nonempty(value.error.code) &&
        typeof value.error.message === 'string' &&
        (value.error.data === undefined || json(value.error.data)))) &&
    (value.snapshot === undefined ||
      (object(value.snapshot) && nonempty(value.snapshot.codec) && json(value.snapshot.value)))
  )
}

/**
 * Validate the record envelope and required fields at a durable input boundary.
 * @param value - Decoded host payload.
 * @returns A narrowed record or throws InvalidLedger.
 */
export function assertRuntimeRecord(value: unknown): asserts value is RuntimeRecord {
  if (
    !object(value) ||
    value.version !== 1 ||
    !nonempty(value.id) ||
    !nonempty(value.turn) ||
    (value.step !== undefined && !nonempty(value.step)) ||
    (value.attempt !== undefined && !nonempty(value.attempt)) ||
    typeof value.kind !== 'string'
  ) {
    throw new InvalidLedger('Invalid runtime record envelope or version')
  }
  switch (value.kind) {
    case 'run.opened':
      if (!object(value.config) || !json(value.config) || !nonempty(value.runtimeVersion)) break
      return
    case 'environment.observed':
      if (
        !nonempty(value.epoch) ||
        !json(value.facts) ||
        !Array.isArray(value.catalog) ||
        !value.catalog.every(
          (item) =>
            object(item) &&
            nonempty(item.name) &&
            nonempty(item.description) &&
            nonempty(item.revision) &&
            json(item.parameters) &&
            json(item.output) &&
            (item.parameterMode === undefined ||
              oneOf(item.parameterMode, ['no_arguments', 'parameterized'])) &&
            (item.phases === undefined ||
              (Array.isArray(item.phases) &&
                item.phases.every((phase: unknown) => oneOf(phase, ['INSPECT', 'ACT', 'VERIFY'])))) &&
            (item.effectClass === undefined ||
              oneOf(item.effectClass, ['read_only', 'workspace_mutation', 'external_write'])) &&
            (item.concurrencySafe === undefined || typeof item.concurrencySafe === 'boolean') &&
            (item.defaults === undefined || (object(item.defaults) && json(item.defaults))),
        )
      )
        break
      return
    case 'input.admitted':
      if (!input(value.input)) break
      return
    case 'resource.observed':
      if (!json(value.resource)) break
      if (
        object(value.resource) &&
        value.resource.kind === 'jev.response-review.v1' &&
        (!nonempty(value.resource.checkpoint) ||
          !oneOf(value.resource.stage, ['requested', 'accepted']) ||
          (value.resource.stage === 'accepted' &&
            !oneOf(value.resource.verdict, ['allow_response', 'continue_call'])))
      )
        break
      try {
        readDecisionToolSnapshot(value.resource)
      } catch (error) {
        if (!(error instanceof InvalidDecisionToolSnapshot)) throw error
        break
      }
      return
    case 'model.requested':
      if (
        !object(value.call) ||
        !oneOf(value.call.purpose, ['decision', 'parameters', 'arbitration', 'answer']) ||
        !nonempty(value.call.backend) ||
        !nonempty(value.call.endpoint) ||
        !nonempty(value.call.codec) ||
        (value.call.requestedModel !== null && typeof value.call.requestedModel !== 'string') ||
        (value.call.inputCursor !== null && typeof value.call.inputCursor !== 'string') ||
        !json(value.call.input) ||
        (value.call.pricing !== undefined && !json(value.call.pricing))
      )
        break
      return
    case 'model.settled':
      if (
        !nonempty(value.requested) ||
        !object(value.settlement) ||
        (value.settlement.output === undefined) === (value.settlement.error === undefined) ||
        (value.settlement.output !== undefined && !json(value.settlement.output)) ||
        (value.settlement.snapshot !== undefined &&
          (!object(value.settlement.snapshot) ||
            !nonempty(value.settlement.snapshot.codec) ||
            !json(value.settlement.snapshot.response))) ||
        (value.settlement.error !== undefined &&
          (!object(value.settlement.error) ||
            !nonempty(value.settlement.error.code) ||
            typeof value.settlement.error.message !== 'string' ||
            typeof value.settlement.error.retryable !== 'boolean')) ||
        (value.settlement.observedModel !== undefined &&
          typeof value.settlement.observedModel !== 'string') ||
        (value.settlement.routing !== undefined && !json(value.settlement.routing)) ||
        (value.settlement.usage !== undefined && !json(value.settlement.usage)) ||
        (value.settlement.latencyMs !== undefined &&
          (!Number.isFinite(value.settlement.latencyMs) || Number(value.settlement.latencyMs) < 0))
      )
        break
      return
    case 'decision.selected':
      if (
        !nonempty(value.requested) ||
        !nonempty(value.operation) ||
        !nonempty(value.phase) ||
        !oneOf(value.phase, ['INSPECT', 'ACT', 'VERIFY', 'RESPOND', 'UNSPECIFIED']) ||
        (value.source !== undefined && !oneOf(value.source, ['jev', 'llm_arbitration'])) ||
        (value.callIndex !== undefined &&
          ((value.source !== 'llm_arbitration' && !nonempty(value.parameterDecision)) ||
            !Number.isSafeInteger(value.callIndex) ||
            Number(value.callIndex) < 0 ||
            Number(value.callIndex) >= 32)) ||
        (value.source === 'llm_arbitration' && value.confidence !== undefined) ||
        (value.source !== 'llm_arbitration' &&
          (typeof value.confidence !== 'number' ||
            !Number.isFinite(value.confidence) ||
            value.confidence < 0 ||
            value.confidence > 1)) ||
        (value.parameterDecision !== undefined &&
          (!nonempty(value.parameterDecision) || value.source !== 'jev' || value.callIndex === undefined)) ||
        (value.candidateId !== undefined && !nonempty(value.candidateId))
      )
        break
      return
    case 'action.intended':
      if (
        !object(value.intent) ||
        !nonempty(value.intent.id) ||
        !nonempty(value.intent.tool) ||
        !nonempty(value.intent.toolRevision) ||
        !nonempty(value.intent.environmentEpoch) ||
        !oneOf(value.intent.effectClass, ['read_only', 'workspace_mutation', 'external_write']) ||
        !object(value.intent.arguments) ||
        !json(value.intent.arguments) ||
        (value.intent.preconditions !== undefined && !json(value.intent.preconditions)) ||
        !nonempty(value.decision)
      )
        break
      return
    case 'action.dispatching':
      if (!nonempty(value.intentId) || !nonempty(value.epoch)) break
      return
    case 'action.settled':
      if (
        !nonempty(value.intentId) ||
        !outcome(value.outcome) ||
        !Array.isArray(value.observations) ||
        !value.observations.every(
          (item) =>
            object(item) &&
            nonempty(item.kind) &&
            nonempty(item.source) &&
            json(item.data) &&
            (item.references === undefined ||
              (Array.isArray(item.references) &&
                item.references.every(
                  (reference: unknown) =>
                    object(reference) &&
                    nonempty(reference.kind) &&
                    nonempty(reference.id) &&
                    nonempty(reference.label),
                ))) &&
            (item.coverage === undefined || json(item.coverage)),
        ) ||
        !oneOf(value.effect, ['none', 'not_applied', 'acknowledged', 'applied', 'unknown'])
      )
        break
      return
    case 'action.resolved':
      if (
        !nonempty(value.intentId) ||
        !oneOf(value.resolution, [
          'confirmed_applied',
          'confirmed_not_applied',
          'accepted_uncertainty',
          'reconciled_state',
        ]) ||
        !nonempty(value.actor) ||
        !nonempty(value.explanation) ||
        !Array.isArray(value.evidence) ||
        !value.evidence.every(nonempty)
      )
        break
      return
    case 'run.stopped':
      if (
        !oneOf(value.reason, ['completed', 'cancelled', 'failed', 'blocked', 'budget']) ||
        !nonempty(value.detail) ||
        !Array.isArray(value.unresolved) ||
        !value.unresolved.every(nonempty)
      )
        break
      return
    default:
      break
  }
  throw new InvalidLedger(`Invalid ${value.kind} record payload`)
}

/**
 * Incrementally validate records and retain their causal state.
 * @returns A replay handle whose state includes only successfully appended records.
 */
export function createLedgerReplay(): {
  append(record: RuntimeRecord): void
  readonly state: ReplayState
} {
  const records: RuntimeRecord[] = []
  const ids = new Set<RecordId>()
  const requests = new Map<RecordId, RuntimeRecord & { kind: 'model.requested' }>()
  const modelSettlements = new Map<RecordId, ModelSettlement>()
  const selected = new Map<RecordId, Extract<RuntimeRecord, { kind: 'decision.selected' }>>()
  const batchSelections = new Set<string>()
  const intents = new Map<IntentId, FrozenIntent>()
  const dispatching = new Set<IntentId>()
  const actions = new Map<IntentId, RuntimeRecord & { kind: 'action.settled' }>()
  const resolutions = new Map<IntentId, RuntimeRecord & { kind: 'action.resolved' }>()
  const observations: RecordedObservation[] = []
  const unresolved: IntentId[] = []
  const openedTurns = new Set<string>()
  let lastStop: (RuntimeRecord & { kind: 'run.stopped' }) | undefined
  const append = (record: RuntimeRecord): void => {
    assertRuntimeRecord(record)
    if (ids.has(record.id)) throw new InvalidLedger(`Duplicate record ${record.id}`)
    ids.add(record.id)
    switch (record.kind) {
      case 'run.opened':
        if (openedTurns.has(record.turn)) throw new InvalidLedger('Turn has duplicate runtime opening')
        openedTurns.add(record.turn)
        break
      case 'model.requested':
        if (!object(record.call) || (!object(record.call.input) && !Array.isArray(record.call.input))) {
          throw new InvalidLedger('Model request lacks its exact serializable input')
        }
        requests.set(record.id, record)
        break
      case 'model.settled':
        if (!requests.has(record.requested) || modelSettlements.has(record.requested))
          throw new InvalidLedger('Model settlement has no unique request')
        modelSettlements.set(record.requested, record.settlement)
        break
      case 'decision.selected':
        if (!modelSettlements.has(record.requested))
          throw new InvalidLedger('Decision uses an unsettled model request')
        if (record.callIndex !== undefined) {
          const request = requests.get(record.requested)
          const settlement = modelSettlements.get(record.requested)
          const output = settlement?.output
          const proposal =
            object(output) && output.kind === 'calls' && Array.isArray(output.calls)
              ? output.calls[record.callIndex]
              : undefined
          const key = JSON.stringify([record.requested, record.callIndex])
          const parameterSelection =
            record.parameterDecision === undefined ? undefined : selected.get(record.parameterDecision)
          const parameterBatch =
            request?.call.purpose === 'parameters' &&
            parameterSelection?.source === 'jev' &&
            parameterSelection.parameterDecision === undefined &&
            requests.get(parameterSelection.requested)?.call.purpose === 'decision' &&
            parameterSelection.operation === record.operation &&
            parameterSelection.phase === record.phase &&
            parameterSelection.turn === record.turn &&
            parameterSelection.step === record.step
          if (
            !(
              (request?.call.purpose === 'arbitration' &&
                record.source === 'llm_arbitration' &&
                record.parameterDecision === undefined) ||
              parameterBatch
            ) ||
            settlement?.error ||
            !object(proposal) ||
            proposal.kind !== 'call' ||
            proposal.name !== record.operation ||
            request.turn !== record.turn ||
            request.step !== record.step ||
            request.attempt !== record.attempt ||
            batchSelections.has(key)
          )
            throw new InvalidLedger('Batch decision has no unique matching proposal')
          batchSelections.add(key)
        }
        selected.set(record.id, record)
        break
      case 'action.intended':
        if (!selected.has(record.decision) || intents.has(record.intent.id))
          throw new InvalidLedger('Intent has no unique selected decision')
        intents.set(record.intent.id, record.intent)
        break
      case 'action.dispatching':
        if (
          !intents.has(record.intentId) ||
          dispatching.has(record.intentId) ||
          actions.has(record.intentId)
        ) {
          throw new InvalidLedger('Dispatch marker has no unique pending intent')
        }
        dispatching.add(record.intentId)
        break
      case 'action.settled': {
        if (!intents.has(record.intentId) || actions.has(record.intentId))
          throw new InvalidLedger('Action settlement has no unique intent')
        if (!dispatching.has(record.intentId) && record.effect !== 'not_applied') {
          throw new InvalidLedger('Undispatched action cannot claim an effect')
        }
        if (!Array.isArray(record.observations))
          throw new InvalidLedger('Action settlement lacks observations')
        actions.set(record.intentId, record)
        const sourceObservations: readonly Observation[] = record.observations
        for (const observation of sourceObservations)
          observations.push({ ...observation, sourceRecordId: record.id })
        if (record.effect === 'unknown' && intents.get(record.intentId)?.effectClass !== 'read_only') {
          unresolved.push(record.intentId)
        }
        break
      }
      case 'action.resolved': {
        const action = actions.get(record.intentId)
        const intent = intents.get(record.intentId)
        if (
          !action ||
          !intent ||
          intent.effectClass === 'read_only' ||
          action.effect !== 'unknown' ||
          resolutions.has(record.intentId) ||
          !record.actor ||
          !record.explanation ||
          !Array.isArray(record.evidence)
        ) {
          throw new InvalidLedger('Resolution does not name one unresolved mutating intent')
        }
        if (record.resolution === 'reconciled_state') {
          const proof = records.find(
            (source) =>
              source.kind === 'resource.observed' &&
              record.evidence.includes(source.id) &&
              object(source.resource) &&
              source.resource.kind === 'jev.effect-recovery.proof.v1' &&
              source.resource.intentId === record.intentId &&
              source.resource.settlementRecordId === action.id &&
              source.resource.resolution === 'reconciled_state',
          )
          const sources =
            proof?.kind === 'resource.observed' &&
            object(proof.resource) &&
            Array.isArray(proof.resource.evidence)
              ? proof.resource.evidence
              : []
          const settledIndex = records.indexOf(action)
          const inspected = records.some(
            (source, index) =>
              index > settledIndex &&
              source.kind === 'action.settled' &&
              sources.includes(source.id) &&
              record.evidence.includes(source.id) &&
              source.outcome.kind === 'success' &&
              source.effect === 'none' &&
              intents.get(source.intentId)?.effectClass === 'read_only',
          )
          if (
            intent.effectClass !== 'workspace_mutation' ||
            record.actor !== 'host:effect-recovery' ||
            !proof ||
            !inspected ||
            !sources.every((id) => typeof id === 'string' && record.evidence.includes(id))
          )
            throw new InvalidLedger(
              'Reconciled state requires a Host proof bound to the uncertain action and fresh inspection',
            )
        }
        resolutions.set(record.intentId, record)
        unresolved.splice(unresolved.indexOf(record.intentId), 1)
        break
      }
      case 'run.stopped':
        lastStop = record
        break
      case 'environment.observed':
      case 'input.admitted':
      case 'resource.observed':
        break
    }
    records.push(record)
  }
  return {
    append,
    get state(): ReplayState {
      return {
        records,
        requests,
        modelSettlements,
        intents,
        dispatching,
        actions,
        resolutions,
        observations,
        unresolved,
        ...(lastStop ? { lastStop } : {}),
      }
    },
  }
}

/**
 * Fold host envelope and cursor formats into the same causal state.
 * @param entries - Ordered committed entries.
 * @returns Validated causal state or throws InvalidLedger.
 */
export function replayRecords<C>(entries: readonly LedgerEntry<C>[]): ReplayState {
  const replay = createLedgerReplay()
  for (const entry of entries) replay.append(entry.record)
  return replay.state
}

/**
 * Identify request and action prefixes requiring interruption records.
 * @param state - Replayed durable prefix.
 * @returns Pending requests, undispatched intents, and dispatched intents.
 */
export function interrupted(state: ReplayState): {
  readonly requests: readonly RecordId[]
  readonly intended: readonly IntentId[]
  readonly dispatching: readonly IntentId[]
} {
  return {
    requests: [...state.requests.keys()].filter((id) => !state.modelSettlements.has(id)),
    intended: [...state.intents.keys()].filter((id) => !state.dispatching.has(id) && !state.actions.has(id)),
    dispatching: [...state.dispatching].filter((id) => !state.actions.has(id)),
  }
}

/**
 * Find typed references whose bytes the host must retain for replay.
 * @param records - Validated runtime records.
 * @returns Distinct artifact references.
 */
export function referencedArtifacts(records: readonly RuntimeRecord[]): readonly ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>()
  const content = (blocks: readonly { readonly kind: string; readonly artifact?: ArtifactRef }[]): void => {
    for (const block of blocks)
      if (block.kind === 'artifact' && block.artifact) refs.set(block.artifact.id, block.artifact)
  }
  for (const record of records) {
    if (record.kind === 'input.admitted') content(record.input.content)
    if (
      record.kind === 'model.settled' &&
      object(record.settlement.output) &&
      record.settlement.output.kind === 'answer' &&
      Array.isArray(record.settlement.output.content)
    ) {
      for (const block of record.settlement.output.content) {
        if (
          object(block) &&
          block.kind === 'artifact' &&
          object(block.artifact) &&
          typeof block.artifact.id === 'string' &&
          typeof block.artifact.digest === 'string' &&
          typeof block.artifact.size === 'number' &&
          typeof block.artifact.mediaType === 'string'
        ) {
          refs.set(block.artifact.id, {
            id: block.artifact.id,
            digest: block.artifact.digest,
            size: block.artifact.size,
            mediaType: block.artifact.mediaType,
          })
        }
      }
    }
    if (record.kind === 'action.settled') {
      content(record.outcome.content)
      for (const addition of record.outcome.directive.additions) content(addition.content)
    }
  }
  return [...refs.values()]
}
