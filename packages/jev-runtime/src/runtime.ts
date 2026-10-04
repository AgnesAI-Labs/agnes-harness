/** Durable Jev decision and guarded host-tool orchestration. */

import { AcceptedAnswers } from './accepted-answers.js'
import {
  candidateSourcesVisible,
  isCandidateDiagnostic,
  validCandidateEvidence,
} from './candidate-evidence.js'
import { candidateFacts } from './candidate-facts.js'
import { candidateInvocationKey } from './candidate-identity.js'
import { compileQuestions, InvalidDecision, parseDecision } from './decision.js'
import { DecisionContextProjection } from './decision-context.js'
import { operationGateReasons, operationSupportUsed, requiresResponseReview } from './decision-gates.js'
import { decisionToolPhases, decisionToolSnapshot, readDecisionToolSnapshot } from './decision-tools.js'
import {
  assertRuntimeRecord,
  createLedgerReplay,
  InvalidLedger,
  interrupted,
  referencedArtifacts,
} from './ledger.js'
import { parameterMode } from './parameter-mode.js'
import type { RuntimeFeedback } from './progress.js'
import { InvalidAuthoredArguments, progressOf, repeatedIntent, StaleCandidate } from './progress.js'
import { pendingRecovery, responseCheckpoint, responseReviewState } from './response-review.js'
import type {
  AttemptId,
  Candidate,
  CandidateId,
  Content,
  DecisionInput,
  DecisionToolProfile,
  EffectDisposition,
  FrozenIntent,
  InputFact,
  IntentId,
  JevRuntime,
  JsonValue,
  LanguageInput,
  ModelInput,
  ModelPurpose,
  ModelSettlement,
  Observation,
  RecordId,
  RunResult,
  RuntimeConfig,
  RuntimePorts,
  RuntimeRecord,
  StepId,
  ToolDescriptor,
  ToolOutcome,
  TurnId,
} from './types.js'

const VERSION = '4'

/** A selected operation or durable prefix cannot safely continue. */
export class RuntimeFault extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeFault'
  }
}

function byteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function orderProfiles(left: DecisionToolProfile, right: DecisionToolProfile): number {
  return left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0
}

function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeFault('Expected one JSON object')
  }
  return value
}

function configCheck(config: RuntimeConfig): void {
  for (const key of [
    'maxResponseReviewAttempts',
    'maxSteps',
    'maxModelAttempts',
    'maxNoProgress',
    'maxRepeatedFailures',
    'maxCandidates',
    'maxHistory',
    'maxQuestionBytes',
    'maxOutputBytes',
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new RuntimeFault(`Invalid ${key}`)
  }
  for (const key of [
    'escalateBelow',
    'bindingBelow',
    'mutationEscalateBelow',
    'equivalentSupportThreshold',
  ] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1)
      throw new RuntimeFault(`Invalid ${key}`)
  }
  if (config.ambiguityGate !== null) {
    throw new RuntimeFault(
      'ambiguityGate must be null; ambiguity is diagnostic. Configure equivalentSupportThreshold for operation support.',
    )
  }
  if (
    !['diagnostic', 'review'].includes(config.responseReviewMode) ||
    (config.responseReviewMode === 'review' && config.answerProgressFloor === null)
  )
    throw new RuntimeFault('Response review requires a progress floor')
  for (const key of ['ambiguityGate', 'answerProgressFloor'] as const) {
    const value = config[key]
    if (
      value !== null &&
      (!Number.isFinite(value) || value < 0 || value > (key === 'ambiguityGate' ? 1 : 3))
    ) {
      throw new RuntimeFault(`Invalid ${key}`)
    }
  }
}

function failedOutcome(code: string, message: string): ToolOutcome {
  return {
    kind: 'error',
    content: [],
    error: { code, message },
    directive: { conclude: false, additions: [] },
  }
}

function genericObservation(tool: ToolDescriptor, result: ToolOutcome): Observation {
  return {
    kind: 'tool.result',
    source: tool.name,
    data: {
      kind: result.kind,
      value: result.value ?? null,
      error: result.error ?? null,
      meta: result.meta ?? null,
    },
  }
}

function normalizeEffect(
  tool: ToolDescriptor,
  outcome: ToolOutcome,
  contributed?: EffectDisposition,
): EffectDisposition {
  if (tool.effectClass === 'read_only') return 'none'
  return outcome.effect ?? contributed ?? (outcome.kind === 'success' ? 'acknowledged' : 'unknown')
}

function parseCall(
  output: JsonValue | undefined,
  tools: readonly ToolDescriptor[],
  locked?: string,
):
  | { kind: 'call'; tool: ToolDescriptor; arguments: { readonly [key: string]: JsonValue } }
  | { kind: 'answer'; content?: readonly Content[] }
  | { kind: 'cannot_bind'; reason: string } {
  const value = object(output)
  if (value.kind === 'answer' && locked === undefined) {
    return Object.keys(value).length === 1
      ? { kind: 'answer' }
      : { kind: 'answer', content: answerContent(output) }
  }
  if (value.kind === 'cannot_bind' && typeof value.reason === 'string' && Object.keys(value).length === 2) {
    return { kind: 'cannot_bind', reason: value.reason }
  }
  if (
    value.kind !== 'call' ||
    typeof value.name !== 'string' ||
    value.arguments === undefined ||
    Object.keys(value).length !== 3
  ) {
    throw new RuntimeFault('Language helper must return exactly one complete call')
  }
  if (locked !== undefined && value.name !== locked)
    throw new RuntimeFault('Language helper changed the locked operation')
  const tool = tools.find((item) => item.name === value.name)
  if (!tool) throw new RuntimeFault('Language helper selected an unavailable operation')
  return { kind: 'call', tool, arguments: object(value.arguments) }
}

type ParsedCall = Extract<ReturnType<typeof parseCall>, { kind: 'call' }>

/** A batch is an ordered proposal, never a grant to execute its unchecked siblings. */
function parseArbitration(output: JsonValue | undefined, tools: readonly ToolDescriptor[]) {
  const value = object(output)
  if (value.kind !== 'calls') return parseCall(output, tools)
  if (
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.calls) ||
    value.calls.length < 1 ||
    value.calls.length > 32
  )
    throw new RuntimeFault('Language arbitration requires between one and 32 complete calls')
  const calls = value.calls.map((entry) => {
    const call = parseCall(entry, tools)
    if (call.kind !== 'call') throw new RuntimeFault('A tool batch cannot contain an answer or refusal')
    return call
  })
  return { kind: 'calls' as const, calls }
}

function answerContent(output: JsonValue | undefined): readonly Content[] {
  const value = object(output)
  if (value.kind !== 'answer' || !Array.isArray(value.content) || Object.keys(value).length !== 2) {
    throw new RuntimeFault('Final language response lacks content')
  }
  const blocks: Content[] = []
  for (const part of value.content) {
    const block = object(part)
    if (block.kind === 'text' && typeof block.text === 'string')
      blocks.push({ kind: 'text', text: block.text })
    else if (
      block.kind === 'artifact' &&
      typeof block.artifact === 'object' &&
      block.artifact !== null &&
      !Array.isArray(block.artifact)
    ) {
      const ref = object(block.artifact)
      if (
        typeof ref.id !== 'string' ||
        typeof ref.digest !== 'string' ||
        typeof ref.size !== 'number' ||
        typeof ref.mediaType !== 'string'
      ) {
        throw new RuntimeFault('Final answer has an invalid artifact reference')
      }
      blocks.push({
        kind: 'artifact',
        artifact: { id: ref.id, digest: ref.digest, size: ref.size, mediaType: ref.mediaType },
      })
    } else throw new RuntimeFault('Final answer contains unsupported content')
  }
  if (!blocks.some((block) => block.kind === 'artifact' || block.text.trim().length > 0)) {
    throw new RuntimeFault('Final language response has no visible content')
  }
  return blocks
}

function conversationHistory(records: readonly RuntimeRecord[]): InputFact[] {
  const answers = new AcceptedAnswers()
  const history: InputFact[] = []
  for (const record of records) {
    if (record.kind === 'input.admitted') history.push(record.input)
    const answer = answers.apply(record)?.settled
    if (answer !== undefined && answer.settlement.output !== undefined) {
      try {
        const content = answerContent(answer.settlement.output)
        history.push({
          id: `answer:${answer.id}`,
          source: 'assistant',
          content,
          ...(answer.settlement.snapshot
            ? {
                snapshot: {
                  codec: answer.settlement.snapshot.codec,
                  value: answer.settlement.snapshot.response,
                },
              }
            : {}),
        })
      } catch (error) {
        if (!(error instanceof RuntimeFault)) throw error
        // An invalid final response was settled but never admitted as an assistant answer.
      }
    }
  }
  return history
}

/**
 * Open a driver from the actual durable prefix and repair interrupted work.
 * @param ports - Host-owned ledger, model, tool, artifact, and lifecycle operations.
 * @param config - Validated finite budgets and routing thresholds.
 * @returns One driver that must reopen after a failed commit or drain.
 */
export async function openJevRuntime<C>(ports: RuntimePorts<C>, config: RuntimeConfig): Promise<JevRuntime> {
  configCheck(config)
  const candidatePolicy = ports.candidatePolicy ?? {
    maxPerTool: Math.max(config.maxCandidates, Math.floor(config.maxQuestionBytes / config.maxCandidates)),
    maxEvidenceBytes: config.maxQuestionBytes,
  }
  if (
    !Number.isSafeInteger(candidatePolicy.maxPerTool) ||
    candidatePolicy.maxPerTool <= 0 ||
    !Number.isSafeInteger(candidatePolicy.maxEvidenceBytes) ||
    candidatePolicy.maxEvidenceBytes <= 0
  ) {
    throw new RuntimeFault('Invalid candidate policy')
  }
  if (!Number.isSafeInteger(ports.language.maxFormatRetries) || ports.language.maxFormatRetries < 0) {
    throw new RuntimeFault('Invalid maxFormatRetries')
  }
  const loaded = await ports.ledger.read()
  const replay = createLedgerReplay()
  const decisionContext = new DecisionContextProjection(ports.decisionContext)
  for (const { record } of loaded) {
    replay.append(record)
    decisionContext.append(record)
  }
  let state = replay.state
  const records = state.records
  let lastCursor = loaded.at(-1)?.cursor
  let counter = records.reduce(
    (largest, record) => Math.max(largest, Number(record.id.match(/:(\d+)$/)?.[1] ?? 0)),
    0,
  )
  let poisoned = false
  let controller = new AbortController()
  let active: Promise<RunResult> | undefined
  let closed = false

  const id = (prefix: string): string => `${prefix}:${++counter}`
  const isCancelled = (): boolean => controller.signal.aborted
  const isPoisoned = (): boolean => poisoned
  const commit = async (record: RuntimeRecord): Promise<void> => {
    if (poisoned || closed) throw new RuntimeFault('Driver must reopen after a failed commit or close')
    try {
      assertRuntimeRecord(record)
      lastCursor = await ports.ledger.commit(record)
      replay.append(record)
      state = replay.state
      decisionContext.append(record)
    } catch (error) {
      poisoned = true
      throw error
    }
  }
  const write = async (
    kind: RuntimeRecord['kind'],
    turn: TurnId,
    values: object,
    step?: StepId,
    attempt?: AttemptId,
  ): Promise<RuntimeRecord> => {
    const record = {
      version: 1,
      id: id('record') as RecordId,
      turn,
      ...(step ? { step } : {}),
      ...(attempt ? { attempt } : {}),
      kind,
      ...values,
    } as RuntimeRecord
    await commit(record)
    return record
  }
  const feedback = async (
    turn: TurnId,
    step: StepId,
    attempt: AttemptId | undefined,
    sourceRecordId: RecordId,
    code: RuntimeFeedback['code'],
    stage: RuntimeFeedback['stage'],
    operation: string | null,
    message: string,
  ): Promise<void> => {
    const resource: RuntimeFeedback = {
      kind: 'jev.runtime.feedback.v1',
      code,
      stage,
      sourceRecordId,
      operation,
      message,
      ...(stage === 'decision' ? { languageVisible: false as const } : {}),
    }
    await write('resource.observed', turn, { resource }, step, attempt)
  }
  const stop = async (turn: TurnId, status: RunResult['status'], reason: string): Promise<RunResult> => {
    await write('run.stopped', turn, { reason: status, detail: reason, unresolved: [...state.unresolved] })
    return { status, reason, unresolved: [...state.unresolved] }
  }
  const retainContent = async (blocks: readonly Content[]): Promise<void> => {
    for (const block of blocks) if (block.kind === 'artifact') await ports.artifacts.retain(block.artifact)
  }

  for (const ref of referencedArtifacts(records)) {
    await ports.artifacts.retain(ref)
  }
  const gaps = interrupted(state)
  for (const requested of gaps.requests) {
    const source = state.requests.get(requested)
    if (source)
      await write(
        'model.settled',
        source.turn,
        {
          requested,
          settlement: {
            error: {
              code: 'INTERRUPTED',
              message: 'Request interrupted before settlement',
              retryable: false,
            },
          },
        },
        source.step,
        source.attempt,
      )
  }
  for (const intentId of gaps.intended) {
    const source = records.find((item) => item.kind === 'action.intended' && item.intent.id === intentId)
    if (source)
      await write(
        'action.settled',
        source.turn,
        {
          intentId,
          outcome: failedOutcome('NOT_DISPATCHED', 'Intent was not dispatched'),
          effect: 'not_applied',
          observations: [],
        },
        source.step,
        source.attempt,
      )
  }
  for (const intentId of gaps.dispatching) {
    const source = records.find((item) => item.kind === 'action.intended' && item.intent.id === intentId)
    if (source?.kind === 'action.intended') {
      const effect = source.intent.effectClass === 'read_only' ? 'none' : 'unknown'
      await write(
        'action.settled',
        source.turn,
        {
          intentId,
          outcome: failedOutcome('INTERRUPTED', 'Dispatched call has no durable settlement'),
          effect,
          observations: [],
        },
        source.step,
        source.attempt,
      )
    }
  }
  const admittedIds = new Set(
    records.filter((record) => record.kind === 'input.admitted').map((record) => record.input.id),
  )
  for (const record of [...records]) {
    if (record.kind !== 'action.settled') continue
    for (const addition of record.outcome.directive.additions) {
      if (admittedIds.has(addition.id)) continue
      await write('input.admitted', record.turn, { input: addition }, record.step, record.attempt)
      admittedIds.add(addition.id)
    }
  }

  async function model(
    purpose: ModelPurpose,
    input: ModelInput,
    turn: TurnId,
    step: StepId,
    attempt: AttemptId,
  ): Promise<{
    request: RuntimeRecord & { kind: 'model.requested' }
    settlement: ModelSettlement
  }> {
    const backend = purpose === 'decision' ? ports.decision : ports.language
    controller.signal.throwIfAborted()
    const inputCursor = lastCursor === undefined ? null : ports.ledger.cursorText(lastCursor)
    const currentInput: ModelInput =
      input.purpose === 'decision'
        ? { ...input, inputCursor }
        : { ...input, records: [...records], inputCursor }
    const call =
      currentInput.purpose === 'decision'
        ? await ports.decision.prepare(currentInput, controller.signal)
        : await ports.language.prepare(currentInput, controller.signal)
    controller.signal.throwIfAborted()
    if (
      call.purpose !== purpose ||
      !call.backend ||
      !call.endpoint ||
      !call.codec ||
      byteLength(call.input) > config.maxOutputBytes
    ) {
      throw new RuntimeFault('Prepared model request is incomplete or exceeds the byte budget')
    }
    const request = (await write('model.requested', turn, { call }, step, attempt)) as RuntimeRecord & {
      kind: 'model.requested'
    }
    let settlement: ModelSettlement
    try {
      settlement = await backend.invoke(call, controller.signal)
      if (byteLength(settlement as JsonValue) > config.maxOutputBytes)
        throw new RuntimeFault('Model response exceeds the byte budget')
    } catch (error) {
      settlement = { error: { code: 'MODEL_FAILURE', message: String(error), retryable: false } }
    }
    if ((purpose === 'answer' || purpose === 'arbitration') && settlement.output !== undefined) {
      let content: readonly Content[] | undefined
      try {
        content = answerContent(settlement.output)
      } catch (error) {
        if (!(error instanceof RuntimeFault)) throw error
      }
      if (content) {
        try {
          await retainContent(content)
        } catch (error) {
          poisoned = true
          throw error
        }
      }
    }
    await write('model.settled', turn, { requested: request.id, settlement }, step, attempt)
    return { request, settlement }
  }

  async function runStep(
    turn: TurnId,
    step: StepId,
    inputs: readonly InputFact[],
    attemptNumber: () => AttemptId,
    recoverable: boolean,
  ): Promise<'continue' | 'complete' | 'empty' | 'no_progress' | 'rejected' | 'review_stalled'> {
    const admitted = ports.lifecycle
      ? await ports.lifecycle.admitStep(turn, step, inputs)
      : { kind: 'enter' as const, inputs, resources: [] }
    if (admitted.kind === 'reject') return 'rejected'
    if (admitted.kind === 'complete') return 'empty'
    if ((admitted.resources?.length ?? 0) > config.maxHistory)
      throw new RuntimeFault('Current resource history budget exhausted')
    for (const resource of admitted.resources ?? [])
      await write('resource.observed', turn, { resource }, step)
    if (admitted.inputs.length > config.maxHistory)
      throw new RuntimeFault('Current input exceeds the history budget')
    for (const input of admitted.inputs) {
      await retainContent(input.content)
      await write('input.admitted', turn, { input }, step)
    }
    const history = conversationHistory(records)
    if (history.length > config.maxHistory) throw new RuntimeFault('Admitted input history budget exhausted')
    if (state.observations.length > config.maxHistory)
      throw new RuntimeFault('Observation history budget exhausted')
    const snapshot = await ports.environment.snapshot()
    const tools = await ports.environment.catalog()
    const environmentRecord = (await write(
      'environment.observed',
      turn,
      { epoch: snapshot.epoch, facts: snapshot.facts, catalog: tools },
      step,
    )) as Extract<RuntimeRecord, { kind: 'environment.observed' }>
    for (const resource of (await ports.environment.observe?.(controller.signal)) ?? []) {
      await write('resource.observed', turn, { resource }, step)
    }
    if ((await ports.environment.snapshot()).epoch !== snapshot.epoch)
      throw new RuntimeFault('Environment changed during resource observation')
    const described: DecisionToolProfile[] = []
    for (const tool of tools) {
      const profile = ports.decisionContext.describeTool?.(tool)
      if (profile === undefined) continue
      if (
        profile.operation !== tool.name ||
        profile.toolRevision !== tool.revision ||
        decisionToolPhases(tool, profile).length === 0
      )
        throw new RuntimeFault(`Invalid decision profile for ${tool.name}`)
      described.push(profile)
    }
    described.sort(orderProfiles)
    const previousProfiles = decisionContext.toolProfiles()
    const profileResource = decisionToolSnapshot(described)
    if (
      (described.length > 0 || previousProfiles !== undefined) &&
      JSON.stringify(profileResource) !==
        JSON.stringify(
          decisionToolSnapshot(
            previousProfiles === undefined ? [] : [...previousProfiles].sort(orderProfiles),
          ),
        )
    ) {
      await write('resource.observed', turn, { resource: profileResource }, step)
    }
    const profiles = decisionContext.profilesFor(tools)
    await write(
      'resource.observed',
      turn,
      {
        resource: {
          kind: 'jev.candidate.policy.v1',
          maxPerTool: candidatePolicy.maxPerTool,
          maxEvidenceBytes: candidatePolicy.maxEvidenceBytes,
        },
      },
      step,
    )
    const recordOrder = new Map(records.map((record, index) => [record.id, index] as const))
    const recordById = new Map(records.map((record) => [record.id, record] as const))
    const currentRecipeId = records.findLast(
      (record) =>
        record.kind === 'resource.observed' &&
        record.resource !== null &&
        typeof record.resource === 'object' &&
        !Array.isArray(record.resource) &&
        record.resource.kind === 'jev.native-candidate-recipes.v1',
    )?.id
    const facts = candidateFacts(records)
    const factSourceIds = new Set(facts.map((record) => record.id))
    const projection = decisionContext.project(turn, state, snapshot.facts, tools, history)
    const visibleSources = new Set(projection.sourceRecordIds)
    const candidateContext = Object.freeze({
      records: Object.freeze(facts),
      environmentRecord,
      limit: candidatePolicy.maxPerTool,
      visibleSourceRecordIds: Object.freeze([...visibleSources]),
    })
    const factObservations = state.observations.filter((item) => factSourceIds.has(item.sourceRecordId))
    const candidateList: Candidate[] = []
    let generated = 0
    const generationLimitReachedTools: string[] = []
    for (const tool of tools) {
      if (parameterMode(tool) === 'no_arguments') continue
      const supplied: Candidate[] = []
      try {
        for (const candidate of ports.semantics?.candidates(
          tool,
          factObservations,
          snapshot.epoch,
          candidateContext,
        ) ?? []) {
          supplied.push(candidate)
          if (supplied.length >= candidatePolicy.maxPerTool) break
        }
      } catch (error) {
        await write(
          'resource.observed',
          turn,
          {
            resource: { kind: 'candidate.enrichment.error', tool: tool.name, message: String(error) },
          },
          step,
        )
      }
      if (supplied.length >= candidatePolicy.maxPerTool) generationLimitReachedTools.push(tool.name)
      if (tool.defaults && supplied.length < candidatePolicy.maxPerTool)
        supplied.push({
          id: `default:${tool.name}:${tool.revision}` as CandidateId,
          tool: tool.name,
          label: `Declared default arguments for ${tool.name}`,
          arguments: tool.defaults,
          sourceRecordIds: [],
          environmentEpoch: snapshot.epoch,
          toolRevision: tool.revision,
        })
      generated += supplied.length
      for (const candidate of supplied) {
        if (
          candidate.tool !== tool.name ||
          candidate.environmentEpoch !== snapshot.epoch ||
          candidate.toolRevision !== tool.revision ||
          candidate.sourceRecordIds.some((source) => !factSourceIds.has(source))
        )
          continue
        const evidence = candidate.evidence ?? []
        if (
          new TextEncoder().encode(JSON.stringify(evidence)).length > candidatePolicy.maxEvidenceBytes ||
          evidence.some((field) => {
            const source = recordById.get(field.sourceRecordId)
            return (
              !candidate.sourceRecordIds.includes(field.sourceRecordId) ||
              source === undefined ||
              !validCandidateEvidence(field, source, environmentRecord.id, currentRecipeId, factSourceIds)
            )
          })
        ) {
          await write(
            'resource.observed',
            turn,
            {
              resource: {
                kind: 'jev.candidate.evidence.error.v1',
                tool: tool.name,
                candidateId: candidate.id,
                reason: 'field receipt is missing, stale, unequal, or exceeds its byte limit',
              },
            },
            step,
          )
          continue
        }
        candidateList.push(candidate)
      }
    }
    const eligible = candidateList
      .map((candidate, index) => ({
        candidate,
        index,
        newestSource: candidate.sourceRecordIds.reduce(
          (latest, source) => Math.max(latest, recordOrder.get(source) ?? -1),
          -1,
        ),
      }))
      .filter((item) => candidateSourcesVisible(item.candidate, visibleSources))
    const queues = tools.map((tool) =>
      eligible
        .filter((item) => item.candidate.tool === tool.name)
        .sort(
          (left, right) =>
            Number(left.candidate.revisit === 'verification') -
              Number(right.candidate.revisit === 'verification') ||
            right.newestSource - left.newestSource ||
            left.index - right.index,
        ),
    )
    const ranked: Candidate[] = []
    for (let position = 0; queues.some((queue) => position < queue.length); position++) {
      for (const queue of queues) {
        const item = queue[position]
        if (item !== undefined) ranked.push(item.candidate)
      }
    }
    const offered: Candidate[] = []
    const offeredInvocations = new Set<string>()
    let validated = 0
    let duplicates = 0
    for (const candidate of ranked) {
      if (offered.length >= config.maxCandidates) break
      const tool = tools.find((item) => item.name === candidate.tool)
      if (tool === undefined) continue
      try {
        validated++
        const arguments_ = await ports.environment.validate(
          tool,
          candidate.arguments,
          candidate.preconditions,
        )
        const resolved = { ...candidate, arguments: arguments_ }
        const invocation = candidateInvocationKey(resolved)
        if (offeredInvocations.has(invocation)) {
          duplicates++
          continue
        }
        offeredInvocations.add(invocation)
        offered.push(resolved)
      } catch (error) {
        await write(
          'resource.observed',
          turn,
          {
            resource: {
              kind: 'candidate.validation.error',
              tool: tool.name,
              candidateId: candidate.id,
              message: String(error),
            },
          },
          step,
        )
      }
    }
    let surface: ReturnType<typeof compileQuestions>
    for (;;) {
      try {
        surface = compileQuestions(tools, offered, config, profiles)
        break
      } catch (error) {
        if (
          !(error instanceof InvalidDecision) ||
          error.message !== 'Question byte budget exceeded' ||
          offered.length === 0
        )
          throw error
        offered.pop()
      }
    }
    if (generated !== offered.length || generationLimitReachedTools.length > 0)
      await write(
        'resource.observed',
        turn,
        {
          resource: {
            kind: 'candidate.offer.summary',
            eligibleKnown: eligible.length,
            offered: offered.length,
            omittedKnown: Math.max(0, eligible.length - offered.length - duplicates),
            ...(duplicates === 0 ? {} : { duplicates }),
            generated,
            validated,
            generationLimitReachedTools,
            availabilityComplete: generationLimitReachedTools.length === 0,
            policy: 'tool-round-robin-newest-source-first-verification-last',
          },
        },
        step,
      )
    await write(
      'resource.observed',
      turn,
      {
        resource: {
          kind: 'jev.decision.manifest.v1',
          requestVersion: 1,
          designRevision: 5,
          environmentRecordId: environmentRecord.id,
          sourceRecordIds: projection.sourceRecordIds,
          operations: [...surface.operations].map(([purpose, plan]) => ({
            purpose,
            question: plan.question,
            choices: [...plan.choices].map(([key, choice]) => ({ key, ...choice })),
          })),
          bindings: [...surface.bindings].map(([key, plan]) =>
            plan.mode === 'no_arguments'
              ? { key, operation: plan.operation, mode: plan.mode }
              : {
                  key,
                  operation: plan.operation,
                  mode: plan.mode,
                  question: plan.question,
                  choices: [...plan.choices].map(([key, candidateId]) => ({
                    key,
                    candidate: surface.candidates.get(candidateId) ?? null,
                  })),
                },
          ),
        },
      },
      step,
    )
    const resources = records.flatMap((record) =>
      record.kind === 'resource.observed' &&
      readDecisionToolSnapshot(record.resource) === undefined &&
      !isCandidateDiagnostic(record.resource)
        ? [record.resource]
        : [],
    )
    if (resources.length > config.maxHistory) throw new RuntimeFault('Resource history budget exhausted')
    const stateInput: JsonValue = {
      environment: snapshot.facts,
      resources,
      observations: state.observations.map((item) => ({
        kind: item.kind,
        source: item.source,
        data: item.data,
        sourceRecordId: item.sourceRecordId,
      })),
      inputs: history.map((item) => ({
        id: item.id,
        source: item.source,
        content: item.content.map((block) =>
          block.kind === 'text'
            ? { kind: 'text', text: block.text }
            : {
                kind: 'artifact',
                artifact: {
                  id: block.artifact.id,
                  digest: block.artifact.digest,
                  size: block.artifact.size,
                  mediaType: block.artifact.mediaType,
                },
                label: block.label ?? null,
              },
        ),
      })),
    }
    const inputCursor = lastCursor === undefined ? null : ports.ledger.cursorText(lastCursor)
    const languageFailure = (
      purpose: LanguageInput['purpose'],
      error: NonNullable<ModelSettlement['error']>,
    ): never => {
      throw new RuntimeFault(`Language ${purpose} failed (${error.code}): ${error.message}`)
    }
    let reviewCheckpointForAttempt: string | undefined
    const helper = async (
      input: LanguageInput & { purpose: 'parameters' | 'arbitration' },
    ): Promise<{
      request: RuntimeRecord & { kind: 'model.requested' }
      settlement: ModelSettlement
      attempt: AttemptId
    }> => {
      let nextInput = input
      for (let retries = 0; ; retries++) {
        if (input.purpose === 'arbitration' && reviewCheckpointForAttempt !== undefined) {
          const review = responseReviewState(records, turn, reviewCheckpointForAttempt)
          if (review.attempts >= config.maxResponseReviewAttempts)
            throw new RuntimeFault('Response review attempt budget exhausted')
        }
        const attempt = attemptNumber()
        if (input.purpose === 'arbitration' && reviewCheckpointForAttempt !== undefined) {
          await write(
            'resource.observed',
            turn,
            {
              resource: {
                kind: 'jev.response-review.v1',
                checkpoint: reviewCheckpointForAttempt,
                stage: 'requested',
              },
            },
            step,
            attempt,
          )
        }
        const result = await model(input.purpose, nextInput, turn, step, attempt)
        const error = result.settlement.error
        if (error === undefined) return { ...result, attempt }
        if (
          !error.retryable ||
          (error.code !== 'LANGUAGE_INVALID_JSON' && error.code !== 'LANGUAGE_TOOL_CALL') ||
          retries >= ports.language.maxFormatRetries
        )
          languageFailure(input.purpose, error)
        nextInput = {
          ...input,
          repair: { requested: result.request.id, error: { code: error.code, message: error.message } },
        }
      }
    }
    const decisionInput: DecisionInput = {
      purpose: 'decision',
      state: projection.state,
      questions: surface.questions,
      inputCursor,
    }
    const decisionAttempt = attemptNumber()
    const decided = await model('decision', decisionInput, turn, step, decisionAttempt)
    if (decided.settlement.error)
      throw new RuntimeFault(`Decision backend failed: ${decided.settlement.error.code}`)
    let selected: ReturnType<typeof parseDecision> | undefined
    let invalidDecision: string | undefined
    try {
      if (decided.settlement.output !== undefined)
        selected = parseDecision(decided.settlement.output, surface)
    } catch (error) {
      if (!(error instanceof InvalidDecision)) throw error
      invalidDecision = error.message
    }
    if (selected === undefined) {
      await feedback(
        turn,
        step,
        decisionAttempt,
        decided.request.id,
        'INVALID_DECISION',
        'decision',
        null,
        invalidDecision ?? 'Decision response has no usable selected path',
      )
      if (progressOf(records, turn).invalidDecisions >= config.maxRepeatedFailures) return 'no_progress'
    }
    const selectedTool =
      selected?.kind === 'tool' ? tools.find((item) => item.name === selected.operation) : undefined
    const reasons = selected
      ? [...operationGateReasons(selected, selectedTool, config, recoverable)]
      : ['invalid_decision']
    const describeObservation = ports.decisionContext.describeObservation?.bind(ports.decisionContext)
    const checkpoint =
      config.responseReviewMode === 'review'
        ? await responseCheckpoint(records, turn, projection.state, describeObservation)
        : undefined
    const reviewState = checkpoint === undefined ? undefined : responseReviewState(records, turn, checkpoint)
    if (selected?.kind === 'respond' && reviewState?.accepted === 'continue_call') return 'review_stalled'
    const reviewRequired =
      selected !== undefined &&
      requiresResponseReview(selected, config) &&
      reviewState?.accepted !== 'allow_response'
    if (reviewRequired) reasons.push('response_review')
    const escalation = reasons[0]
    let decisionRecord: RuntimeRecord | undefined
    if (selected)
      decisionRecord = await write(
        'decision.selected',
        turn,
        {
          requested: decided.request.id,
          phase: selected.purpose,
          operation: selected.operation,
          ...(selected.candidateId ? { candidateId: selected.candidateId } : {}),
          confidence: selected.operationPathConfidence,
          source: 'jev',
          ...(escalation ? { escalation } : {}),
        },
        step,
        decisionAttempt,
      )
    if (selected)
      await write(
        'resource.observed',
        turn,
        {
          resource: {
            kind: 'jev.decision.route.v1',
            requested: decided.request.id,
            decisionRecordId: decisionRecord?.id ?? null,
            purpose: selected.purpose,
            operation: selected.operation,
            purposeConfidence: selected.purposeConfidence,
            operationConfidence: selected.operationConfidence,
            operationPathConfidence: selected.operationPathConfidence,
            bindingConfidence: selected.bindingConfidence ?? null,
            equivalentSupport: selected.equivalentSupport,
            equivalentSupportThreshold: config.equivalentSupportThreshold,
            supportApplied: reasons.length === 0 && operationSupportUsed(selected, selectedTool, config),
            operationBranches: selected.operationBranches.map((branch) => ({ ...branch })),
            invalidOperationBranches: selected.invalidOperationBranches.map((branch) => ({ ...branch })),
            supportingQuestionIds: selected.operationBranches
              .filter(
                (branch) =>
                  branch.operation === selected.operation &&
                  (selected.purposeProbabilities[branch.purpose] ?? 0) > 0,
              )
              .map((branch) => branch.question),
            consumedQuestionIds: [...selected.consumedQuestionIds],
            reasons,
          },
        },
        step,
        decisionAttempt,
      )
    let chosen:
      | {
          kind: 'call'
          tool: ToolDescriptor
          arguments: { readonly [key: string]: JsonValue }
          candidate?: Candidate
          authoredRequest?: RecordId
          authoredAttempt?: AttemptId
        }
      | { kind: 'answer'; content?: readonly Content[] }
    let batch: { calls: ParsedCall[]; requested: RecordId; attempt: AttemptId } | undefined
    let batchInterrupted = false
    let reviewed = false
    const acceptReview = async (verdict: 'allow_response' | 'continue_call'): Promise<void> => {
      if (!reviewed || checkpoint === undefined) return
      await write(
        'resource.observed',
        turn,
        {
          resource: {
            kind: 'jev.response-review.v1',
            checkpoint,
            stage: 'accepted',
            verdict,
            decisionRecordId: decisionRecord?.id ?? null,
          },
        },
        step,
      )
    }
    if (escalation) {
      await write(
        'resource.observed',
        turn,
        {
          resource: {
            kind: 'jev.candidate.route.v1',
            requested: decided.request.id,
            decisionRecordId: decisionRecord?.id ?? null,
            selectedOperation: selected?.operation ?? null,
            candidateId: selected?.candidateId ?? null,
            bindingConfidence: selected?.bindingConfidence ?? null,
            threshold: config.bindingBelow,
            route: 'arbitration',
            reason: escalation,
            reasons,
          },
        },
        step,
        decisionAttempt,
      )
      // An arbitration that can allow an answer also consumes a bounded review attempt in review mode.
      reviewed = checkpoint !== undefined && reviewState?.accepted === undefined
      if (reviewed && checkpoint !== undefined) {
        if ((reviewState?.attempts ?? 0) >= config.maxResponseReviewAttempts) return 'review_stalled'
        reviewCheckpointForAttempt = checkpoint
      }
      const input: LanguageInput & { purpose: 'arbitration' } = {
        purpose: 'arbitration',
        state: stateInput,
        tools,
        history,
        records: [...records],
        inputCursor,
      }
      const { request, settlement, attempt } = await helper(input)
      let parsed: ReturnType<typeof parseArbitration>
      try {
        parsed = parseArbitration(settlement.output, tools)
        // Validate the complete proposal before allowing even the first side effect.
        if (parsed.kind === 'calls')
          for (const call of parsed.calls) await ports.environment.validate(call.tool, call.arguments)
      } catch (error) {
        if (!(error instanceof RuntimeFault) && !(error instanceof InvalidAuthoredArguments)) throw error
        await feedback(
          turn,
          step,
          attempt,
          request.id,
          'INVALID_ARBITRATION',
          'arbitration',
          selected?.operation ?? null,
          error.message,
        )
        return 'no_progress'
      }
      if (parsed.kind === 'calls') {
        batch = { calls: parsed.calls, requested: request.id, attempt }
        parsed = parsed.calls[0]!
      }
      if (parsed.kind === 'cannot_bind') {
        await feedback(
          turn,
          step,
          attempt,
          request.id,
          'BINDING_DECLINED',
          'arbitration',
          selected?.operation ?? null,
          parsed.reason,
        )
        return 'no_progress'
      }
      if (parsed.kind === 'answer' && reviewState?.accepted === 'continue_call') return 'review_stalled'
      chosen =
        parsed.kind === 'call' ? { ...parsed, authoredRequest: request.id, authoredAttempt: attempt } : parsed
      if (parsed.kind === 'answer' && parsed.content !== undefined) {
        await acceptReview('allow_response')
        reviewed = false
      }
      decisionRecord = await write(
        'decision.selected',
        turn,
        {
          requested: request.id,
          phase: parsed.kind === 'answer' ? 'RESPOND' : 'UNSPECIFIED',
          operation: parsed.kind === 'answer' ? 'RESPOND' : parsed.tool.name,
          source: 'llm_arbitration',
          ...(batch === undefined ? {} : { callIndex: 0 }),
          escalation,
        },
        step,
        attempt,
      )
    } else if (selected?.kind === 'respond') {
      chosen = { kind: 'answer' }
    } else if (selectedTool && selected) {
      const candidate = selected.candidateId ? surface.candidates.get(selected.candidateId) : undefined
      const noArguments = selected.parameterMode === 'no_arguments'
      const direct =
        noArguments ||
        (candidate !== undefined &&
          selected.bindingConfidence !== undefined &&
          selected.bindingConfidence >= config.bindingBelow)
      await write(
        'resource.observed',
        turn,
        {
          resource: {
            kind: 'jev.candidate.route.v1',
            requested: decided.request.id,
            decisionRecordId: decisionRecord?.id ?? null,
            selectedOperation: selectedTool.name,
            candidateId: candidate?.id ?? null,
            bindingConfidence: selected.bindingConfidence ?? null,
            parameterMode: selected.parameterMode ?? null,
            threshold: config.bindingBelow,
            route: direct ? 'direct' : 'parameters',
            reason: noArguments
              ? 'no_arguments'
              : candidate === undefined
                ? 'llm_parameters'
                : selected.bindingConfidence === undefined
                  ? 'no_binding_head'
                  : direct
                    ? 'binding_confident'
                    : 'binding_below_threshold',
          },
        },
        step,
        decisionAttempt,
      )
      if (noArguments) chosen = { kind: 'call', tool: selectedTool, arguments: {} }
      else if (direct && candidate !== undefined) {
        chosen = { kind: 'call', tool: selectedTool, arguments: candidate.arguments, candidate }
      } else {
        const input: LanguageInput & { purpose: 'parameters' } = {
          purpose: 'parameters',
          state: stateInput,
          tools,
          lockedOperation: selectedTool.name,
          ...(selected.purpose === 'RESPOND' ? {} : { lockedPurpose: selected.purpose }),
          history,
          records: [...records],
          inputCursor,
        }
        const result = await helper(input)
        let parsed: ReturnType<typeof parseCall>
        try {
          parsed = parseCall(result.settlement.output, tools, selectedTool.name)
        } catch (error) {
          if (!(error instanceof RuntimeFault)) throw error
          await feedback(
            turn,
            step,
            result.attempt,
            result.request.id,
            'INVALID_PARAMETERS',
            'parameters',
            selectedTool.name,
            error.message,
          )
          return 'no_progress'
        }
        if (parsed.kind !== 'call') {
          await feedback(
            turn,
            step,
            result.attempt,
            result.request.id,
            'BINDING_DECLINED',
            'parameters',
            selectedTool.name,
            parsed.kind === 'cannot_bind' ? parsed.reason : 'Parameter helper did not return a call',
          )
          return 'no_progress'
        }
        chosen = { ...parsed, authoredRequest: result.request.id, authoredAttempt: result.attempt }
      }
    } else throw new RuntimeFault('Selected operation has no current tool')

    if (chosen.kind === 'answer') {
      await acceptReview('allow_response')
      if (chosen.content !== undefined) return 'complete'
      const input: ModelInput = {
        purpose: 'answer',
        state: stateInput,
        tools,
        history,
        records: [...records],
        inputCursor,
      }
      const attempt = attemptNumber()
      const result = await model('answer', input, turn, step, attempt)
      if (result.settlement.error) languageFailure('answer', result.settlement.error)
      try {
        answerContent(result.settlement.output)
      } catch (error) {
        if (!(error instanceof RuntimeFault)) throw error
        await feedback(
          turn,
          step,
          attempt,
          result.request.id,
          'INVALID_ANSWER',
          'answer',
          'ANSWER',
          error.message,
        )
        return 'no_progress'
      }
      return 'complete'
    }
    const executeChosen = async (): Promise<'continue' | 'complete' | 'no_progress'> => {
      if (chosen.kind !== 'call') throw new RuntimeFault('Expected a selected tool call')
      if (!decisionRecord) throw new RuntimeFault('Tool call lacks a selected decision')
      let arguments_: { readonly [key: string]: JsonValue }
      try {
        arguments_ = await ports.environment.validate(
          chosen.tool,
          chosen.arguments,
          chosen.candidate?.preconditions,
        )
      } catch (error) {
        if (error instanceof StaleCandidate && chosen.candidate !== undefined) {
          await feedback(
            turn,
            step,
            decisionRecord.attempt,
            decisionRecord.id,
            'CANDIDATE_STALE',
            'preflight',
            chosen.tool.name,
            error.message,
          )
          return 'no_progress'
        }
        if (!(error instanceof InvalidAuthoredArguments)) throw error
        await feedback(
          turn,
          step,
          chosen.authoredAttempt ?? decisionRecord.attempt,
          chosen.authoredRequest ?? decisionRecord.id,
          'INVALID_PARAMETERS',
          escalation ? 'arbitration' : 'parameters',
          chosen.tool.name,
          error.message,
        )
        return 'no_progress'
      }
      const intent: FrozenIntent = {
        id: id('intent') as IntentId,
        tool: chosen.tool.name,
        toolRevision: chosen.tool.revision,
        arguments: arguments_,
        effectClass: chosen.tool.effectClass ?? 'external_write',
        environmentEpoch: snapshot.epoch,
        ...(chosen.candidate?.preconditions === undefined
          ? {}
          : { preconditions: chosen.candidate.preconditions }),
      }
      if (repeatedIntent(records, turn, intent)) {
        await feedback(
          turn,
          step,
          decisionRecord.attempt,
          decisionRecord.id,
          'DUPLICATE_NO_PROGRESS',
          'preflight',
          intent.tool,
          'The same invocation yielded the same substantive result twice',
        )
        return 'no_progress'
      }
      await acceptReview('continue_call')
      await write('action.intended', turn, { intent, decision: decisionRecord.id }, step)
      let current: Awaited<ReturnType<typeof ports.environment.snapshot>> | undefined
      let preparedOutcome: ToolOutcome | undefined
      try {
        const preparation = await ports.environment.prepare?.(intent, controller.signal)
        if (preparation?.kind === 'settled') preparedOutcome = preparation.outcome
        else {
          // Approval may have awaited a human. Recheck steering and every frozen binding.
          if (batch && (await ports.lifecycle?.hasPendingInput?.(turn, step)))
            throw new RuntimeFault('New input requires a new decision before batch dispatch')
          current = await ports.environment.snapshot()
          const currentTool = (await ports.environment.catalog()).find((item) => item.name === intent.tool)
          if (
            controller.signal.aborted ||
            current.epoch !== intent.environmentEpoch ||
            currentTool?.revision !== intent.toolRevision
          ) {
            throw new RuntimeFault('Environment or tool revision changed before dispatch')
          }
          await ports.environment.validate(currentTool, intent.arguments, intent.preconditions)
        }
      } catch (error) {
        preparedOutcome = failedOutcome('NOT_DISPATCHED', String(error))
      }
      if (preparedOutcome) {
        try {
          // Release authorization-only preparation even when no dispatch took place.
          await ports.environment.drain(intent.id)
        } catch (error) {
          poisoned = true
          throw error
        }
        const outcome = { ...preparedOutcome, effect: 'not_applied' as const }
        await retainContent(outcome.content)
        for (const addition of outcome.directive.additions) await retainContent(addition.content)
        await write(
          'action.settled',
          turn,
          {
            intentId: intent.id,
            outcome,
            effect: 'not_applied',
            observations: [],
          },
          step,
        )
        for (const addition of outcome.directive.additions)
          await write('input.admitted', turn, { input: addition }, step)
        return 'no_progress'
      }
      if (!current) throw new RuntimeFault('Dispatch preparation did not produce an environment snapshot')
      await write('action.dispatching', turn, { intentId: intent.id, epoch: current.epoch }, step)
      let outcome: ToolOutcome
      try {
        outcome = await ports.environment.execute(intent, controller.signal)
      } catch (error) {
        outcome = failedOutcome('EXECUTION_FAILURE', String(error))
      }
      try {
        await ports.environment.drain(intent.id)
      } catch (error) {
        poisoned = true
        throw error
      }
      let observations: Observation[]
      let contributed: EffectDisposition | undefined
      try {
        contributed = ports.semantics?.effectDisposition(chosen.tool, outcome)
        const supplied = ports.semantics?.observations(chosen.tool, outcome, intent) ?? []
        observations = supplied.length ? [...supplied] : [genericObservation(chosen.tool, outcome)]
      } catch (error) {
        observations = [
          genericObservation(chosen.tool, outcome),
          { kind: 'enrichment.error', source: chosen.tool.name, data: { message: String(error) } },
        ]
      }
      const effect = normalizeEffect(chosen.tool, outcome, contributed)
      try {
        await retainContent(outcome.content)
        for (const addition of outcome.directive.additions) await retainContent(addition.content)
      } catch (error) {
        poisoned = true
        throw error
      }
      await write('action.settled', turn, { intentId: intent.id, outcome, effect, observations }, step)
      for (const addition of outcome.directive.additions)
        await write('input.admitted', turn, { input: addition }, step)
      batchInterrupted = outcome.directive.additions.length > 0
      if (effect === 'unknown') return 'no_progress'
      if (outcome.kind === 'success' && outcome.directive.conclude) return 'complete'
      return outcome.kind === 'success' ? 'continue' : 'no_progress'
    }
    for (let index = 0; ; index++) {
      if (controller.signal.aborted || (batch && (await ports.lifecycle?.hasPendingInput?.(turn, step))))
        return 'no_progress'
      if (index > 0) {
        const call = batch?.calls[index]
        if (!call || !batch) return 'continue'
        const progress = progressOf(records, turn)
        if (
          progress.noProgress >= config.maxNoProgress ||
          progress.repeatedFailures >= config.maxRepeatedFailures
        )
          return 'no_progress'
        chosen = { ...call, authoredRequest: batch.requested, authoredAttempt: batch.attempt }
        decisionRecord = await write(
          'decision.selected',
          turn,
          {
            requested: batch.requested,
            phase: 'UNSPECIFIED',
            operation: call.tool.name,
            source: 'llm_arbitration',
            callIndex: index,
            ...(escalation === undefined ? {} : { escalation }),
          },
          step,
          batch.attempt,
        )
      }
      const result = await executeChosen()
      // A refusal, failure, uncertain effect, new input or conclusion invalidates the remaining plan.
      if (result !== 'continue' || !batch || batchInterrupted) return result
    }
  }

  const driver: JevRuntime = {
    run(turn, initialInputs) {
      if (active) throw new RuntimeFault('Another turn is active')
      if (poisoned || closed) throw new RuntimeFault('Driver must reopen after a failed commit or close')
      controller = new AbortController()
      active = (async (): Promise<RunResult> => {
        if (state.unresolved.length)
          return {
            status: 'blocked',
            reason: 'Unresolved dispatched mutation',
            unresolved: [...state.unresolved],
          }
        const completed = records.findLast((record) => record.kind === 'run.stopped' && record.turn === turn)
        if (completed?.kind === 'run.stopped' && completed.reason === 'completed') {
          return { status: 'completed', reason: completed.detail, unresolved: [...state.unresolved] }
        }
        const opened = records.find((record) => record.kind === 'run.opened' && record.turn === turn)
        if (opened?.kind === 'run.opened') {
          if (
            opened.runtimeVersion !== VERSION ||
            Object.keys(config).some((key) => {
              const name = key as keyof RuntimeConfig
              return opened.config[name] !== config[name]
            })
          )
            throw new RuntimeFault('Turn resumed with a different runtime configuration')
        } else {
          await write('run.opened', turn, { config, runtimeVersion: VERSION })
        }
        let attempts = records.filter(
          (record) => record.kind === 'model.requested' && record.turn === turn,
        ).length
        const previousSteps = new Set(
          records
            .filter((record) => record.turn === turn && record.step !== undefined)
            .map((record) => record.step),
        ).size
        const nextAttempt = (): AttemptId => {
          if (attempts >= config.maxModelAttempts) throw new RuntimeFault('Model attempt budget exhausted')
          attempts++
          return id('attempt') as AttemptId
        }
        try {
          const answers = new AcceptedAnswers()
          let pendingAnswer = false
          const concludingAdditions = new Set<string>()
          for (const record of records) {
            const accepted = answers.apply(record)
            if (record.turn !== turn) continue
            if (
              (record.kind === 'input.admitted' && !concludingAdditions.has(record.input.id)) ||
              record.kind === 'model.requested' ||
              record.kind === 'action.intended'
            )
              pendingAnswer = false
            if (
              record.kind === 'action.settled' &&
              record.outcome.kind === 'success' &&
              record.outcome.directive.conclude &&
              record.effect !== 'unknown'
            ) {
              pendingAnswer = true
              for (const addition of record.outcome.directive.additions) concludingAdditions.add(addition.id)
            }
            if (accepted !== undefined) {
              pendingAnswer = false
              try {
                answerContent(accepted.settled.settlement.output)
              } catch (error) {
                if (error instanceof RuntimeFault) continue
                throw error
              }
              pendingAnswer = true
            }
          }
          if (pendingAnswer && initialInputs.length === 0) {
            if (isCancelled())
              return await stop(turn, 'cancelled', 'Cancelled before completing the recorded answer')
            if (!(await ports.lifecycle?.beforeStop?.(turn)))
              return await stop(turn, 'completed', 'Recorded answer or concluding action already admitted')
          }
          for (let number = previousSteps + 1; number <= config.maxSteps; number++) {
            if (isCancelled()) return await stop(turn, 'cancelled', 'Cancelled before next decision')
            if (state.unresolved.length)
              return await stop(turn, 'blocked', 'Dispatched effect requires resolution')
            const before = progressOf(records, turn)
            if (before.invalidDecisions >= config.maxRepeatedFailures)
              return await stop(turn, 'budget', 'Repeated invalid decisions exhausted the recovery budget')
            if (
              before.noProgress >= config.maxNoProgress ||
              before.repeatedFailures >= config.maxRepeatedFailures
            ) {
              return await stop(turn, 'budget', 'Progress budget exhausted')
            }
            const step = id(`step-${number}`) as StepId
            let result: 'continue' | 'complete' | 'empty' | 'no_progress' | 'rejected' | 'review_stalled'
            try {
              result = await runStep(
                turn,
                step,
                number === previousSteps + 1 ? initialInputs : [],
                nextAttempt,
                pendingRecovery(records, turn) !== undefined,
              )
            } finally {
              await ports.lifecycle?.stepSettled(turn, step)
            }
            if (isCancelled()) return await stop(turn, 'cancelled', 'Cancelled after draining current step')
            if (result === 'empty') return await stop(turn, 'completed', 'Host completed empty turn')
            if (result === 'complete') {
              if (await ports.lifecycle?.beforeStop?.(turn)) continue
              return await stop(turn, 'completed', 'Answer or concluding tool settled')
            }
            if (result === 'review_stalled')
              return await stop(
                turn,
                'budget',
                'Response review cannot advance without new substantive evidence',
              )
            if (result === 'rejected') return await stop(turn, 'blocked', 'Host rejected next step')
            if (state.unresolved.length)
              return await stop(turn, 'blocked', 'Dispatched effect requires resolution')
            const after = progressOf(records, turn)
            if (after.invalidDecisions >= config.maxRepeatedFailures)
              return await stop(turn, 'budget', 'Repeated invalid decisions exhausted the recovery budget')
            if (
              after.noProgress >= config.maxNoProgress ||
              after.repeatedFailures >= config.maxRepeatedFailures
            )
              return await stop(turn, 'budget', 'Progress budget exhausted')
          }
          return await stop(turn, 'budget', 'Step budget exhausted')
        } catch (error) {
          if (isPoisoned()) throw error
          if (isCancelled()) return await stop(turn, 'cancelled', String(error))
          const status =
            error instanceof RuntimeFault && error.message.includes('budget') ? 'budget' : 'failed'
          return await stop(turn, status, String(error))
        }
      })()
      return active.finally(() => {
        active = undefined
      })
    },
    async resolveUnknown(intentId, resolution, actor, explanation, evidence) {
      if (active || poisoned || closed) throw new RuntimeFault('Resolution requires an idle open driver')
      if (!state.unresolved.includes(intentId) || !actor || !explanation || !evidence.length)
        throw new RuntimeFault('Invalid UNKNOWN resolution')
      const source = records.find(
        (record) => record.kind === 'action.intended' && record.intent.id === intentId,
      )
      if (!source) throw new InvalidLedger('Missing intent for UNKNOWN resolution')
      await write('action.resolved', source.turn, { intentId, resolution, actor, explanation, evidence })
    },
    cancel() {
      controller.abort()
    },
    async close() {
      controller.abort()
      try {
        if (active) await active
      } finally {
        closed = true
      }
    },
  }
  return driver
}
