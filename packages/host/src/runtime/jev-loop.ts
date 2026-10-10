import {
  budgetOverrideEvent,
  CoreError,
  canonicalJson,
  captureModelPriceQuote,
  claimFrom,
  harnessSections,
  inboxEvent,
  KernelChildren,
  mergeContributions,
  resolveModel,
  type SessionImpl,
  type SessionLoop,
  scanAll,
  sha256Hex,
  TURN_BUDGET_EVENT,
  type TurnOutcome,
} from '@agnes/core'
import {
  type ArtifactPort,
  type Content,
  type DecisionInputPolicy,
  type InputFact,
  type JevRuntime,
  type JsonValue,
  openJevRuntime,
  type RunResult,
  type RuntimeConfig,
  type RuntimeLedger,
  type RuntimePorts,
  replayRecords,
  type TurnId,
} from '@agnes/jev-runtime'
import type { Actor, ContentBlock, SessionRuntimeState } from '@agnes/protocol'
import { createDecisionContext, createLanguageBackend } from '@agnes/runtime-jev'
import { bindPreparedRuntime } from './comparison-prepared.js'
import { createJevAnswerPreview } from './jev-answer-preview.js'
import { parseJevResolution } from './jev-control.js'
import { createJevDecisionPool, decisionCoordinates, type JevDecisionPool } from './jev-decision-pool.js'
import { createJevEnvironment } from './jev-environment.js'
import { jevLanguageSlots } from './jev-language-slots.js'
import { createJevLedger } from './jev-ledger.js'
import { createJevModelPolicy } from './jev-model-policy.js'
import {
  JEV_INSTRUCTION_ORDER,
  jevSystemPromptPolicy,
  promptProjectionChanged,
  systemPromptFact,
} from './jev-prompt-facts.js'
import { claimJevRecoveryTurn } from './jev-recovery-turn.js'
import { jevRuntimeContextPolicy, runtimeContextFact } from './jev-runtime-facts.js'
import { jevSkillCandidateCatalog } from './jev-skill-facts.js'
import { JEV_TOOL_MOUNT, mountJevTools } from './jev-tool-mount.js'
import { createJevToolSemantics } from './jev-tool-semantics.js'
import { assertJevNestedResolution } from './nested-tool-journal.js'

export const JEV_IDENTITY = Object.freeze({ id: 'jevloop', version: '1' })

export interface JevLoopOptions extends JevDecisionPool {
  config?: Partial<RuntimeConfig>
}

const DEFAULTS: RuntimeConfig = {
  maxSteps: 64,
  maxModelAttempts: 256,
  maxNoProgress: 3,
  maxRepeatedFailures: 3,
  maxCandidates: 64,
  maxHistory: 4096,
  maxQuestionBytes: 512 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  escalateBelow: 0.6,
  equivalentSupportThreshold: 0.8,
  bindingBelow: 0.6,
  mutationEscalateBelow: 0.6,
  ambiguityGate: null,
  responseReviewMode: 'diagnostic',
  answerProgressFloor: null,
  maxResponseReviewAttempts: 2,
}

const turnReason = (result: RunResult): TurnOutcome['reason'] =>
  (
    ({
      completed: 'completed',
      cancelled: 'aborted',
      failed: 'error',
      blocked: 'blocked',
      budget: 'budget',
    }) as const
  )[result.status]

/**
 * Fixed public text for a classified runtime failure, or `undefined` for the generic message. Each
 * branch names the operator action that removes the cause; none of them copies provider text.
 */
export function jevFailureMessage(failureReason: string): string | undefined {
  if (
    /^(?:RuntimeFault: Language (?:answer|arbitration|parameters) failed \(MODEL_FAILURE\): )?LanguageMediaError: LANGUAGE_IMAGE_MODEL_UNSUPPORTED:/.test(
      failureReason,
    )
  )
    return '当前模型未声明支持工具返回的图片。请选择支持图像输入的模型后重试。'
  if (
    /Ordered system history requires an explicitly supported|Host action history is unsupported for this API/.test(
      failureReason,
    )
  )
    return '当前模型未声明支持会话中插入 system 消息。请在“模型与账户”中为该账户勾选该兼容项，测试并保存后重启后台重试。'
  return undefined
}

/** Public failure text is a fixed classification, never a copy of runtime/provider diagnostics. */
function publicOutcome(result: RunResult, budgetReason?: string): Pick<TurnOutcome, 'reason' | 'error'> {
  if (result.unresolved.length || result.status === 'blocked') return { reason: 'blocked' }
  const failureReason = budgetReason ?? result.reason
  const budgetRefusal =
    result.status === 'failed' &&
    (budgetReason !== undefined || result.reason.startsWith('CoreError: E_BUDGET:'))
  const reason = budgetRefusal ? 'budget' : turnReason(result)
  if (reason !== 'error' && reason !== 'budget') return { reason }
  if (reason === 'error')
    return {
      reason,
      error: {
        code: 'E_RUNTIME_FAILED',
        message: jevFailureMessage(failureReason) ?? 'Jev 执行失败，请查看运行记录获取诊断信息。',
      },
    }
  let message = '本轮运行额度已用尽，请缩小任务范围后重试。'
  if (budgetRefusal) {
    message = '预算检查未通过，已停止模型请求。请检查预算、计费及请求计数配置。'
    if (/price is unknown|price projection is unavailable|billable model identity/.test(failureReason))
      message = '无法获取本次模型请求的可信费用估算，已停止执行。请配置费用上界或可用的计费服务后重试。'
    else if (/exceeds its cap/.test(failureReason))
      message = '本次模型请求预计费用超过预算上限，已停止执行。请调整预算或缩小任务范围后重试。'
    else if (/pending Jev cost delivery/.test(failureReason))
      message = '费用记录尚未同步到账本，已暂停新的模型请求。请恢复计费服务后重试。'
    else if (/tree-budget reservation|Tree model reservation|tree request/i.test(failureReason))
      message = '树预算预留未通过，已停止模型请求。请检查树额度和可信费用上界配置。'
  }
  return { reason, error: { code: 'E_BUDGET', message } }
}

/** Agnes owns durable sessions and capabilities; the portable runtime exclusively owns its loop. */
export async function openJevLoop(session: SessionImpl, options: JevLoopOptions): Promise<SessionLoop> {
  mountJevTools(session)
  const decisions = createJevDecisionPool(options, () => session.d.clock())
  const answerPreview = createJevAnswerPreview(session)
  await answerPreview.recover()
  const durableLedger = await createJevLedger(session, { acceptedAnswerSources: answerPreview.sources })
  const ledger: RuntimeLedger<number> = {
    read: durableLedger.read,
    cursorText: durableLedger.cursorText,
    async commit(record) {
      try {
        const cursor = await durableLedger.commit(record)
        if (record.kind === 'model.requested') await answerPreview.requested(record, cursor)
        return cursor
      } finally {
        await answerPreview.settled(record)
      }
    },
  }
  const artifacts = artifactPort(session)
  let runtime: JevRuntime
  let running: Promise<TurnOutcome> | undefined
  let maintenance: Promise<unknown> | undefined
  let phase: SessionRuntimeState['phase'] = 'idle'
  let closed = false
  let drained = false
  let cancellationRequested = false
  let stepAdmitted = false
  let pendingInputs: InputFact[] = []
  let skillCandidateCatalog: JsonValue = { kind: 'jev.skill-catalog.v1', entries: [] }
  let activeTurn: number | undefined
  let activeRuntimeTurn: number | undefined
  let turnBudget: number | undefined
  const turnId = (turn: number): TurnId => `${session.key}:${session.lane}:${turn}` as TurnId
  const position = () => ({
    turn: session.state.openTurn.get(session.lane)?.turn ?? activeTurn ?? session.lastTurnNumber(),
    step: session.state.openStep.get(session.lane)?.step ?? session.state.lastStep.get(session.lane) ?? 0,
  })
  const baseConfig: RuntimeConfig = { ...DEFAULTS, ...options.config }
  const newTurnConfig = (): RuntimeConfig => ({
    ...baseConfig,
    maxSteps: session.preset.budget.maxSteps ?? baseConfig.maxSteps,
  })
  async function effectiveTurnConfig(): Promise<RuntimeConfig> {
    const current = session.state.openTurn.get(session.lane)
    const logical = current
      ? (activeRuntimeTurn ?? (await logicalTurn(current.turn, current.startSeq)))
      : undefined
    const opened =
      logical === undefined
        ? undefined
        : (await ledger.read()).find(
            (entry) => entry.record.kind === 'run.opened' && entry.record.turn === turnId(logical),
          )?.record
    // A preset switch governs the next turn. A restored unfinished turn retains its admitted
    // step budget; portable replay still checks runtime version and every other config field.
    return {
      ...newTurnConfig(),
      ...(opened?.kind === 'run.opened' ? { maxSteps: opened.config.maxSteps } : {}),
    }
  }
  let config = await effectiveTurnConfig()
  bindPreparedRuntime(session, () => {
    const effective = session.state.openTurn.has(session.lane) ? config : newTurnConfig()
    return {
      decision: decisionCoordinates(options),
      decisionChoices: decisions.choices(),
      config: {
        maxSteps: effective.maxSteps,
        maxModelAttempts: effective.maxModelAttempts,
        maxNoProgress: effective.maxNoProgress,
        maxRepeatedFailures: effective.maxRepeatedFailures,
        maxCandidates: effective.maxCandidates,
        maxHistory: effective.maxHistory,
        maxQuestionBytes: effective.maxQuestionBytes,
        maxOutputBytes: effective.maxOutputBytes,
        escalateBelow: effective.escalateBelow,
        equivalentSupportThreshold: effective.equivalentSupportThreshold,
        bindingBelow: effective.bindingBelow,
        mutationEscalateBelow: effective.mutationEscalateBelow,
        ambiguityGate: effective.ambiguityGate,
        responseReviewMode: effective.responseReviewMode,
        answerProgressFloor: effective.answerProgressFloor,
        maxResponseReviewAttempts: effective.maxResponseReviewAttempts,
      },
    }
  })

  const companions = createJevToolSemantics({ session, ledger })
  const childFactory = session.d.children
  const environment = createJevEnvironment({
    facts: () => ({ cwd: session.d.cwd, toolMountPolicy: JEV_TOOL_MOUNT.id }),
    ...(childFactory instanceof KernelChildren
      ? {
          childFactoryRuntimeSupport: {
            factory: childFactory,
            supportsRuntime: (identity) => childFactory.supportsRuntime(identity),
          },
        }
      : {}),
    effectClass: companions.effectClass,
    isQuestionTool: companions.isQuestionTool,
    validatePreconditions: companions.validatePreconditions,
    observeExecution: companions.observeExecution,
    session,
    ledger,
    guardianModel: () => session.operationContext().model.model,
    async waitForApproval({ requestId }, signal) {
      phase = 'waiting'
      try {
        await waitForDecision(session, requestId, signal)
      } finally {
        phase = signal.aborted ? 'recovering' : 'running'
      }
    },
  })
  const inputPolicies = {
    user: { kind: 'task' },
    'system-prompt': { kind: 'instructions', replaceKey: 'agnes-system' },
    'runtime-context': { kind: 'context', replaceKey: 'agnes-runtime-context' },
  } satisfies Record<string, DecisionInputPolicy>
  const language = createLanguageBackend({
    provider: session.d.provider,
    // The getter follows an authorized model switch between turns, never a caller-supplied route.
    // A session stage binding (setJevStages) resolves its route/model — and thinking, when set —
    // directly; otherwise the stage resolves through its preset-bound slot, so a setModel on that
    // slot takes effect for the stage's next request. Both read the live preset view per call.
    selection(purpose) {
      const slot = jevLanguageSlots(session.preset)[purpose]
      const binding = session.preset.model.jevStageBindings?.[purpose]
      const target = binding ?? resolveModel(session, slot)
      return {
        slot,
        route: target.route,
        model: target.model,
        contractId: session.d.contractForModel?.(target)?.contract_id ?? session.d.contract.contract_id,
      }
    },
    sampling(purpose) {
      const slot = jevLanguageSlots(session.preset)[purpose]
      const binding = session.preset.model.jevStageBindings?.[purpose]
      const thinking =
        binding === undefined || binding.thinking === undefined
          ? session.preset.model.thinking[slot]
          : (binding.thinking ?? undefined)
      return thinking === undefined ? {} : { thinking }
    },
    pricing: (request) => captureModelPriceQuote(session.d.provider, request, session.d.clock()),
    sessionKey: session.key,
    system: '',
    artifacts,
    maxImageRequestBytes: 64 * 1024 * 1024,
    inputPolicies,
    maxFormatRetries: 2,
    maxResponseBytes: config.maxOutputBytes,
    hashRequest: (request) => sha256Hex(canonicalJson(request)),
    onEvent: answerPreview.event,
  })

  let modelBudgetRefusal: string | undefined
  const models = createJevModelPolicy({
    session,
    onBudgetRefusal: (error) => {
      modelBudgetRefusal = error.message
    },
    language,
    decision: decisions.backend,
    async projectCost(call) {
      const credits = decisions.credits(call)
      return credits === undefined ? undefined : { credits, creditSource: 'estimated' as const }
    },
  })
  const ports: RuntimePorts<number> = {
    effectRecovery: { reconcile: companions.reconcileEffect },
    ledger,
    artifacts,
    environment,
    ...models,
    semantics: companions.semantics,
    decisionContext: createDecisionContext({
      describeTool: companions.describeTool,
      config: {
        maxStateBytes: config.maxQuestionBytes,
        recentActions: 16,
        observationCount: 64,
        maxEvidenceBytes: 64 * 1024,
        excerptBytes: 4096,
      },
      instructionOrder: JEV_INSTRUCTION_ORDER,
      sources: {
        ...inputPolicies,
        'system-prompt': jevSystemPromptPolicy,
        'runtime-context': jevRuntimeContextPolicy,
      },
    }),
    lifecycle: {
      async hasPendingInput() {
        return session.locked(
          async () =>
            pendingInputs.length > 0 ||
            claimFrom(session.latest('inbox') as Parameters<typeof claimFrom>[0], 'next-step') !== null,
        )
      },
      async admitStep(_turn, _step, initial) {
        if (closed || cancellationRequested || session.ac.signal.aborted) return { kind: 'reject' }
        const current = session.state.openTurn.get(session.lane)
        if (!current) throw new CoreError('E_RELATION', 'Jev step has no owning turn')
        // A prior process may have left a presentation step open; the runtime ledger decides recovery.
        await closeStep()
        await session.d.quiet?.enter(session.d.quietGroup ?? session.key)
        stepAdmitted = true
        const step = (session.state.lastStep.get(session.lane) ?? 0) + 1
        const gate = await session.hooks.beforeStep({
          turn: current.turn,
          step,
          depth: session.generationDepth,
        })
        if (gate.block) return { kind: 'reject' }
        await session.d.log.append([session.ev('step/start', { turn: current.turn, step })])
        session.turn = session.freshTurn()
        if (turnBudget !== undefined) session.turn.budgetCap = turnBudget
        const inputs = [...initial, ...pendingInputs]
        pendingInputs = []
        inputs.push(...(await acceptSteering()))
        const history = await ledger.read()
        const changed: InputFact[] = []
        for (const fact of await promptFacts()) {
          const previous = history.findLast(
            (entry) => entry.record.kind === 'input.admitted' && entry.record.input.source === fact.source,
          )
          if (
            previous?.record.kind !== 'input.admitted' ||
            promptProjectionChanged(previous.record.input, fact)
          )
            changed.push(fact)
        }
        inputs.unshift(...changed)
        const previousCatalog = history.findLast(
          ({ record }) =>
            record.kind === 'resource.observed' &&
            record.resource !== null &&
            typeof record.resource === 'object' &&
            !Array.isArray(record.resource) &&
            record.resource.kind === 'jev.skill-catalog.v1',
        )
        const resources =
          previousCatalog?.record.kind === 'resource.observed' &&
          canonicalJson(previousCatalog.record.resource) === canonicalJson(skillCandidateCatalog)
            ? []
            : [skillCandidateCatalog]
        return { kind: 'enter', inputs, resources }
      },
      async stepSettled() {
        await answerPreview.finish()
        try {
          await closeStep()
        } finally {
          if (stepAdmitted) session.d.quiet?.leave(session.d.quietGroup ?? session.key)
          stepAdmitted = false
        }
      },
      async beforeStop() {
        const inputs = await acceptSteering()
        if (inputs.length) {
          pendingInputs.push(...inputs)
          return true
        }
        const decision = await session.hooks.turnStopping({ ...position(), proposedReason: 'completed' })
        session.ac.signal.throwIfAborted()
        // The asynchronous hook may enqueue steering instead of returning a continuation.
        inputs.push(...(await acceptSteering()))
        if (decision.action === 'continue')
          inputs.push({
            id: `continue:${session.lastSeq}`,
            source: 'host-context',
            content: [{ kind: 'text', text: decision.note }],
          })
        pendingInputs.push(...inputs)
        return inputs.length > 0
      },
    },
  }
  runtime = await openJevRuntime(ports, config)
  phase = replayRecords(await ledger.read()).unresolved.length
    ? 'parked'
    : session.state.openTurn.has(session.lane)
      ? 'recovering'
      : 'idle'

  async function closeStep() {
    const step = session.state.openStep.get(session.lane)
    if (step) await session.d.log.append([session.ev('step/end', { turn: step.turn, step: step.step })])
  }

  async function promptFacts(): Promise<InputFact[]> {
    const context = session.operationContext()
    const snapshot = session.currentTools().snapshot(session.lastSeq)
    const fullContext = { ...context, snapshot, disclosed: snapshot.defs.map((tool) => tool.name) }
    const contributions = session.d.operations.flatMap((operation) =>
      operation.contribute ? [{ op: operation.name, ...operation.contribute(fullContext) }] : [],
    )
    const merged = mergeContributions(contributions, snapshot)
    merged.sections.push(
      ...harnessSections([...session.state.registers.harnessEntries.values()].map((entry) => entry.value)),
    )
    const transformed = await session.hooks.context(merged.sections)
    // A disabled skill loader cannot satisfy the built-in catalog's usage instructions. Keep
    // workspace/user instructions intact; omit only the Host-owned discovery section.
    const sections = transformed.sections.filter(
      (section) => section.source !== 'agnes/skills' || section.id !== 'skills',
    )
    skillCandidateCatalog = jevSkillCandidateCatalog(sections)
    return [
      systemPromptFact(sections, transformed.additionalContext, session.lastSeq),
      runtimeContextFact(
        merged.runtimeContext,
        session.lastSeq,
        contributions.find((contribution) => contribution.op === 'code:prompts')?.runtimeContext,
      ),
    ]
  }

  async function acceptSteering(): Promise<InputFact[]> {
    return session.locked(async () => {
      const inputs: InputFact[] = []
      for (;;) {
        const claimed = claimFrom(session.latest('inbox') as Parameters<typeof claimFrom>[0], 'next-step')
        if (!claimed) break
        const input = await inputFact(claimed.item.content, `input:${claimed.item.itemId}`, artifacts)
        const receipt = await session.d.log.append([
          inboxEvent(session.lane, session.d.actor, claimed.rest),
          session.ev(
            'user/message',
            {
              itemId: claimed.item.itemId,
              content: claimed.item.content,
              kind: claimed.item.kind ?? 'steer',
            },
            {
              origin: 'principal',
              actor: claimed.item.actor,
              trust: claimed.item.trust ?? 'trusted',
              surfaceOp: 'append',
            },
          ),
        ])
        inputs.push({ ...input, id: `message:${receipt.seqs[1]}` })
      }
      return inputs
    })
  }

  async function logicalTurn(turn: number, startSeq: number): Promise<number> {
    const rows = (
      await scanAll((query) => session.scan(query), {
        type: 'x/host/jev-loop/turn-decision',
        fromSeq: startSeq,
        toSeq: session.lastSeq,
      })
    ).filter((row) => (row.data as { turn?: number }).turn === turn)
    if (rows.length > 1 || rows.some((row) => row.origin !== 'system' || row.trust !== 'trusted'))
      throw new CoreError('E_RELATION', 'Invalid runtime turn decision binding')
    const number = (rows[0]?.data as { runtimeTurn?: number } | undefined)?.runtimeTurn ?? turn
    if (!Number.isSafeInteger(number) || number < 1 || number > turn)
      throw new CoreError('E_RELATION', 'Invalid runtime continuation binding')
    return number
  }

  async function claimTurn(
    signal: AbortSignal,
  ): Promise<{ turn: number; runtimeTurn: number; inputs: InputFact[] } | undefined> {
    return session.locked(async () => {
      if (closed || signal.aborted || cancellationRequested) return undefined
      const current = session.state.openTurn.get(session.lane)
      if (current) {
        const runtimeTurn = await logicalTurn(current.turn, current.startSeq)
        const selections = await scanAll((query) => session.scan(query), {
          type: 'x/host/jev-loop/turn-decision',
          fromSeq: current.startSeq,
          toSeq: session.lastSeq,
        })
        const selected = selections.filter((row) => (row.data as { turn?: number }).turn === current.turn)
        if (selected.length > 1 || selected.some((row) => row.origin !== 'system' || row.trust !== 'trusted'))
          throw new CoreError('E_RELATION', 'Invalid runtime turn decision binding')
        let selection = (selected[0]?.data as { selection?: JsonValue } | undefined)?.selection
        if (!selection && selected.length)
          throw new CoreError('E_ENVELOPE', 'Missing runtime turn decision binding')
        if (selection === undefined) {
          const previous = (await ledger.read()).find(
            (entry) =>
              entry.record.turn === turnId(runtimeTurn) &&
              entry.record.kind === 'model.requested' &&
              entry.record.call.purpose === 'decision',
          )?.record
          if (previous?.kind === 'model.requested')
            selection = {
              backend: previous.call.backend,
              endpoint: previous.call.endpoint,
              model: previous.call.requestedModel,
            }
        }
        decisions.select(selection)
        const budgets = await scanAll((query) => session.scan(query), {
          type: TURN_BUDGET_EVENT,
          fromSeq: current.startSeq,
          toSeq: session.lastSeq,
        })
        const matching = budgets.filter((row) => (row.data as { turn?: number }).turn === current.turn)
        if (matching.length > 1) throw new CoreError('E_RELATION', 'duplicate runtime turn budget')
        turnBudget = (matching[0]?.data as { creditsCap?: number } | undefined)?.creditsCap
        if (turnBudget !== undefined && (!Number.isFinite(turnBudget) || turnBudget < 0))
          throw new CoreError('E_ENVELOPE', 'invalid runtime turn budget')
        const messages = await scanAll((query) => session.scan(query), {
          type: 'user/message',
          fromSeq: Math.max(1, current.startSeq - 1),
          toSeq: session.lastSeq,
        })
        const admitted = new Set(
          (await ledger.read()).flatMap((entry) =>
            entry.record.kind === 'input.admitted' && entry.record.turn === turnId(runtimeTurn)
              ? [entry.record.input.id]
              : [],
          ),
        )
        const inputs: InputFact[] = []
        for (const message of messages) {
          const id = `message:${message.seq}`
          if (!admitted.has(id))
            inputs.push(await inputFact((message.data as { content: ContentBlock[] }).content, id, artifacts))
        }
        return { turn: current.turn, runtimeTurn, inputs }
      }
      if (replayRecords(await ledger.read()).unresolved.length) {
        const recovered = await claimJevRecoveryTurn(session, ledger, signal)
        if (!recovered) return undefined
        decisions.select(recovered.selection)
        turnBudget = recovered.budget
        session.hooks.resetTurn?.()
        return { turn: recovered.turn, runtimeTurn: recovered.runtimeTurn, inputs: [] }
      }
      const claimed = claimFrom(session.latest('inbox') as Parameters<typeof claimFrom>[0], 'next-turn')
      if (!claimed) return undefined
      const runtimeSelection = claimed.item.runtimeSelection ?? decisions.selection()
      decisions.select(runtimeSelection)
      const input = await inputFact(claimed.item.content, `input:${claimed.item.itemId}`, artifacts)
      const turn = session.lastTurnNumber() + 1
      turnBudget = await session.inboxBudget(claimed.item.itemId)
      // Cancellation while reading the input must not consume an unadmitted inbox item.
      if (closed || signal.aborted || cancellationRequested) return undefined
      const receipt = await session.d.log.append([
        inboxEvent(session.lane, session.d.actor, claimed.rest),
        session.ev(
          'user/message',
          { itemId: claimed.item.itemId, content: claimed.item.content, kind: claimed.item.kind ?? 'prompt' },
          {
            origin: 'principal',
            actor: claimed.item.actor,
            trust: claimed.item.trust ?? 'trusted',
            surfaceOp: 'append',
          },
        ),
        session.ev('turn/start', { turn, trigger: claimed.item.kind ?? 'prompt' }),
        session.ev(
          'x/host/jev-loop/turn-decision',
          { turn, itemId: claimed.item.itemId, selection: runtimeSelection },
          { ignorable: true },
        ),
        ...(turnBudget === undefined
          ? []
          : [
              budgetOverrideEvent(TURN_BUDGET_EVENT, session.d.actor, {
                turn,
                itemId: claimed.item.itemId,
                creditsCap: turnBudget,
              }),
            ]),
      ])
      session.hooks.resetTurn?.()
      return { turn, runtimeTurn: turn, inputs: [{ ...input, id: `message:${receipt.seqs[1]}` }] }
    })
  }

  async function closeTurn(reason: TurnOutcome['reason'], error?: TurnOutcome['error']) {
    await closeStep()
    const current = session.state.openTurn.get(session.lane)
    if (!current) return
    const [last] = await session.scan({
      type: 'assistant/message',
      fromSeq: current.startSeq,
      toSeq: session.lastSeq,
      order: 'desc',
      limit: 1,
    })
    await session.d.log.append([
      session.ev('turn/end', { reason, lastAssistantSeq: last?.seq ?? null, ...(error ? { error } : {}) }),
    ])
    session.turn = null
  }

  async function abort(by: Actor) {
    cancellationRequested = true
    const current = session.state.openTurn.get(session.lane)
    let seq: number | null = null
    try {
      let target = current ? turnId(current.turn) : undefined
      if (!target) {
        const state = replayRecords(await ledger.read())
        const turns = new Set(state.unresolved.map((intentId) => state.actions.get(intentId)?.turn))
        if (turns.size > 1 || turns.has(undefined))
          throw new CoreError('E_RELATION', 'Cannot cancel an ambiguous Jev recovery turn')
        target = [...turns][0]
      }
      if (target)
        seq = (
          await session.d.log.append([
            session.ev('runtime/cancel', {
              runtime: JEV_IDENTITY,
              turnId: target,
              by,
            }),
          ])
        ).firstSeq
    } finally {
      runtime.cancel()
      session.ac.abort()
    }
    if (!running && current) {
      await session.locked(() => closeTurn('aborted'))
      phase = replayRecords(await ledger.read()).unresolved.length ? 'parked' : 'idle'
    }
    return { seq, alreadyTerminal: !current }
  }

  return {
    identity: JEV_IDENTITY,
    prepareInput(target, runtimeOptions) {
      if (target !== 'next-turn') return undefined
      return decisions.selection(runtimeOptions)
    },
    state: () => ({
      runtime: JEV_IDENTITY,
      phase: closed ? 'closed' : phase,
      revision: session.lastSeq,
      decisionBackend: decisions.current().decision.backend,
    }),
    control(input) {
      if (closed) return Promise.reject(new CoreError('E_CLOSED', 'runtime is closed'))
      if (running || maintenance)
        return Promise.reject(new CoreError('E_LANE_BUSY', 'Jev control requires an idle runtime'))
      if (input.operation !== 'jev.resolveUnknown')
        return Promise.reject(new CoreError('E_UNSUPPORTED', 'unknown Jev runtime control operation'))
      const payload = parseJevResolution(input.payload)
      const operation = (async () => {
        if (!replayRecords(await ledger.read()).unresolved.includes(payload.intentId))
          throw new CoreError('E_FORMAT', 'intent is not unresolved')
        await assertJevNestedResolution(session, payload)
        await runtime.resolveUnknown(
          payload.intentId,
          payload.resolution,
          `${input.actor.org}/${input.actor.id}`,
          payload.explanation,
          payload.evidence,
        )
        const committed = await ledger.read()
        phase = replayRecords(committed).unresolved.length ? 'parked' : 'idle'
        const resolution = committed.findLast(
          (entry) => entry.record.kind === 'action.resolved' && entry.record.intentId === payload.intentId,
        )
        if (!resolution) throw new CoreError('E_LEDGER_INTEGRITY', 'missing committed resolution')
        return {
          result: { intentId: payload.intentId, resolution: payload.resolution },
          effectiveFromSeq: resolution.cursor,
        }
      })()
      maintenance = operation
      return operation
        .catch((error: unknown) => {
          if (!(error instanceof CoreError)) phase = 'failed'
          throw error
        })
        .finally(() => {
          maintenance = undefined
        })
    },
    async resume() {
      if (maintenance) throw new CoreError('E_LANE_BUSY', 'runtime maintenance is active')
      const current = session.state.openTurn.get(session.lane)
      if (!current) return { state: 'idle', actions: [] }
      const cancelled = (
        await scanAll((query) => session.scan(query), {
          type: 'runtime/cancel',
          fromSeq: current.startSeq,
          toSeq: session.lastSeq,
        })
      ).some((row) => (row.data as { turnId: string }).turnId === turnId(current.turn))
      if (cancelled) {
        await closeTurn('aborted')
        phase = replayRecords(await ledger.read()).unresolved.length ? 'parked' : 'idle'
      } else phase = replayRecords(await ledger.read()).unresolved.length ? 'parked' : 'recovering'
      return { state: 'resumed', phase, actions: [] }
    },
    run(runOptions) {
      const runSignal = runOptions.signal ?? new AbortController().signal
      if (closed) return Promise.reject(new CoreError('E_CLOSED', 'runtime is closed'))
      if (running || maintenance) return Promise.reject(new CoreError('E_LANE_BUSY', 'runtime is active'))
      if (!session.state.openTurn.has(session.lane)) cancellationRequested = false
      session.ac = new AbortController()
      const onAbort = () => {
        void abort(session.d.actor).catch(() => runtime.cancel())
      }
      runSignal.addEventListener('abort', onAbort, { once: true })
      running = (async (): Promise<TurnOutcome> => {
        phase = 'running'
        for (;;) {
          // close may arrive while claimTurn is awaiting storage. Drain this wrapper before
          // closing the portable driver, so it cannot start a turn on an already closed driver.
          if (closed) {
            await closeTurn('aborted')
            return { reason: 'aborted', lastSeq: session.lastSeq }
          }
          const existing = session.state.openTurn.get(session.lane)
          if (existing) {
            const cancelled = (
              await scanAll((query) => session.scan(query), {
                type: 'runtime/cancel',
                fromSeq: existing.startSeq,
                toSeq: session.lastSeq,
              })
            ).some((row) => (row.data as { turnId: string }).turnId === turnId(existing.turn))
            if (cancelled) {
              await closeTurn('aborted')
              phase = replayRecords(await ledger.read()).unresolved.length ? 'parked' : 'idle'
              return { reason: 'aborted', lastSeq: session.lastSeq }
            }
          }
          const work = await claimTurn(runSignal)
          if (closed || runSignal.aborted || cancellationRequested) {
            await abort(session.d.actor)
            await closeTurn('aborted')
            phase = replayRecords(await ledger.read()).unresolved.length ? 'parked' : 'idle'
            return { reason: 'aborted', lastSeq: session.lastSeq }
          }
          if (!work) {
            const unresolved = replayRecords(await ledger.read()).unresolved.length > 0
            phase = unresolved ? 'parked' : 'idle'
            return { reason: unresolved ? 'blocked' : 'completed', lastSeq: session.lastSeq }
          }
          activeTurn = work.turn
          activeRuntimeTurn = work.runtimeTurn
          modelBudgetRefusal = undefined
          const nextConfig = await effectiveTurnConfig()
          if (nextConfig.maxSteps !== config.maxSteps) {
            await runtime.close()
            runtime = await openJevRuntime(ports, nextConfig)
            config = nextConfig
          }
          // Reopening a driver can await durable recovery. Do not revive a cancelled wrapper.
          if (closed || runSignal.aborted || cancellationRequested) {
            await abort(session.d.actor)
            await closeTurn('aborted')
            return { reason: 'aborted', lastSeq: session.lastSeq }
          }
          const result = await runtime.run(turnId(work.runtimeTurn), work.inputs)
          const outcome = publicOutcome(result, modelBudgetRefusal)
          await closeTurn(outcome.reason, outcome.error)
          phase = result.unresolved.length ? 'parked' : outcome.reason === 'error' ? 'failed' : 'idle'
          if (runOptions.until === 'turn-end' || outcome.reason !== 'completed')
            return { ...outcome, lastSeq: session.lastSeq }
        }
      })()
        .catch((error: unknown) => {
          phase = 'failed'
          throw error
        })
        .finally(async () => {
          await answerPreview.finish()
          runSignal.removeEventListener('abort', onAbort)
          running = undefined
          activeTurn = undefined
          activeRuntimeTurn = undefined
        })
      return running
    },
    async step() {
      throw new CoreError('E_UNSUPPORTED', 'this runtime exposes turn execution, not Native phase stepping')
    },
    abort,
    async close() {
      if (drained) return
      closed = true
      cancellationRequested = true
      await maintenance?.catch(() => undefined)
      runtime.cancel()
      await running
      await runtime.close()
      await answerPreview.finish()
      drained = true
    },
  }
}

async function waitForDecision(session: SessionImpl, requestId: string, signal: AbortSignal): Promise<void> {
  if (session.state.decisions.has(requestId)) return
  await new Promise<void>((resolve, reject) => {
    const done = (error?: unknown) => {
      off()
      signal.removeEventListener('abort', aborted)
      error === undefined ? resolve() : reject(error)
    }
    const aborted = () => done(signal.reason ?? new Error('approval cancelled'))
    const off = session.onAppended(() => {
      if (session.state.decisions.has(requestId)) done()
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (session.state.decisions.has(requestId)) done()
  })
}

function artifactPort(session: SessionImpl): ArtifactPort {
  const read: ArtifactPort['read'] = async (ref) => {
    const bytes = await session.d.runtime.artifactGet({
      sha256: ref.digest,
      size: ref.size,
      mime: ref.mediaType,
    })
    if (bytes.length !== ref.size || sha256Hex(bytes) !== ref.digest)
      throw new CoreError('E_ENVELOPE', 'artifact integrity mismatch')
    return bytes
  }
  return {
    async put(bytes, mediaType) {
      const ref = await session.d.runtime.artifactPut(bytes, { mime: mediaType })
      return { id: ref.sha256, digest: ref.sha256, size: ref.size, mediaType: ref.mime }
    },
    read,
    async retain(ref) {
      await read(ref)
    },
    // Agnes' immutable artifact store retains session objects; it has no per-read deletion API.
    async release() {},
  }
}

async function inputFact(
  content: readonly ContentBlock[],
  id: string,
  artifacts: ArtifactPort,
): Promise<InputFact> {
  const blocks: Content[] = []
  for (const block of content) {
    if (block.type === 'text') blocks.push({ kind: 'text', text: block.text })
    else if (block.type === 'image')
      blocks.push({
        kind: 'artifact',
        artifact: await artifacts.put(Buffer.from(block.data, 'base64'), block.mimeType),
      })
    else blocks.push({ kind: 'text', text: `${block.name ?? 'Resource'}: ${block.uri}` })
  }
  return {
    id,
    source: 'user',
    content: blocks,
    snapshot: { codec: 'agnes-content-v1', value: structuredClone([...content]) as JsonValue },
  }
}
