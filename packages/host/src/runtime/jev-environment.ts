import {
  authorizeToolCall,
  buildToolContext,
  CoreError,
  canonicalJson,
  dispatchPermittedTool,
  dispatchToolAttempt,
  type EventInput,
  ExecutePermitRegistry,
  type HostDispatchObservation,
  persistedToolApproval,
  type RegisteredTool,
  resolveValidatedToolCallPolicy,
  type SessionImpl,
  sha256Hex,
  type ToolApprovalCall,
  type ToolContextDeps,
  toLedgerContent,
  toolVerifyInput,
} from '@agnes/core'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import {
  type EnvironmentEpoch,
  type ExecutionEnvironment,
  type FrozenIntent,
  type IntentId,
  InvalidAuthoredArguments,
  type JsonValue,
  type RuntimeLedger,
  StaleCandidate,
  type ToolDescriptor,
  type ToolOutcome,
} from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { readQuestionCancellation } from '../questions.js'
import { createJevChildRefusalReader } from './jev-child-refusal.js'
import { observedBuiltinProcessDisposition } from './jev-process-observation.js'
import { type ChildFactoryRuntimeSupport, createJevToolAvailability } from './jev-tool-availability.js'
import {
  observedBuiltinWriteFailure,
  observedBuiltinWriteNotEntered,
  observedBuiltinWriteVersionRefusal,
} from './jev-tool-semantics.js'
import { observeJevWorkspace } from './jev-workspace-observation.js'
import { createNestedToolExecutor } from './nested-tool-executor.js'

export interface JevEnvironmentOptions {
  readonly effectClass?: (tool: { name: string; revision: string }) => 'external_write' | undefined
  readonly isQuestionTool?: (tool: { name: string; revision: string }) => boolean
  /** Private composition input; no Session capability escapes the environment port. */
  readonly session: SessionImpl
  readonly ledger: RuntimeLedger<number>
  readonly epoch?: () => string | Promise<string>
  readonly facts?: () => JsonValue | Promise<JsonValue>
  /** Bounds the recorded direct-root window; enumeration remains explicit and non-recursive. */
  readonly workspaceObservation?: { readonly maxEntries: number }
  readonly childFactoryRuntimeSupport?: ChildFactoryRuntimeSupport
  readonly guardianModel?: () => string
  readonly waitForApproval?: (
    input: {
      intent: FrozenIntent
      requestId: string
      event: EventInput
    },
    signal: AbortSignal,
  ) => Promise<void>
  readonly validatePreconditions?: (
    preconditions: JsonValue,
    tool: ToolDescriptor,
    args: JsonValue,
  ) => Promise<boolean>
  readonly observeExecution?: (
    intent: FrozenIntent,
    context: ToolContext,
    invoke: (context: ToolContext) => Promise<ToolResult>,
  ) => Promise<{ result: ToolResult; meta?: JsonValue }>
}

type Prepared = { intentKey: string; definition: RegisteredTool; call: ToolApprovalCall; decisionId: string }
const errorResult = (code: string, message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  details: { code },
})

function resultOutcome(result: ToolResult, effect: ToolOutcome['effect'], evidence: JsonValue): ToolOutcome {
  const content = result.content.map((block) =>
    block.type === 'text'
      ? { kind: 'text' as const, text: block.text }
      : {
          kind: 'artifact' as const,
          artifact: {
            id: block.ref.sha256,
            digest: block.ref.sha256,
            size: block.ref.size,
            mediaType: block.type === 'image' ? block.mime : (block.mime ?? block.ref.mime),
          },
        },
  )
  const details = result.details as { code?: unknown } | undefined
  return {
    kind: result.isError ? 'error' : 'success',
    content,
    ...(result.structured === undefined ? {} : { value: result.structured as JsonValue }),
    ...(result.isError
      ? {
          error: {
            code: typeof details?.code === 'string' ? details.code : 'TOOL_ERROR',
            message: result.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n'),
          },
        }
      : {}),
    snapshot: { codec: 'agnes-tool-result-v1', value: JSON.parse(JSON.stringify(result)) as JsonValue },
    directive: { conclude: result.terminate === true, additions: [] },
    ...(effect === undefined ? {} : { effect }),
    effectEvidence: evidence,
  }
}

/** Host adapter: prepare owns authorization; execute owns one attempt; Jev alone owns recovery. */
export function createJevEnvironment(
  options: JevEnvironmentOptions,
): ExecutionEnvironment & Required<Pick<ExecutionEnvironment, 'prepare'>> {
  const s = options.session
  const availability = createJevToolAvailability(s, options.childFactoryRuntimeSupport)
  const readChildRefusal = createJevChildRefusalReader(s)
  const maxWorkspaceEntries = options.workspaceObservation?.maxEntries ?? 256
  if (!Number.isSafeInteger(maxWorkspaceEntries) || maxWorkspaceEntries < 1)
    throw new TypeError('Workspace observation maxEntries must be a positive integer')
  const permits = new ExecutePermitRegistry()
  const owner = Object.freeze({})
  const prepared = new Map<IntentId, Prepared>()
  const inFlight = new Map<IntentId, Promise<unknown>>()
  const consumedApprovals = new Set<string>()
  // Only Host prepare refusals carry authority; tool errors cannot claim it by code or shape.
  const prepareRefusals = new WeakSet<ToolResult>()
  const registry = () => s.currentTools().snapshot(s.lastSeq)
  const position = () => {
    const step = s.state.openStep.get(s.lane)
    if (!step) throw new CoreError('E_RELATION', 'Jev tool execution requires an open common step')
    return step
  }
  const epoch = async (): Promise<EnvironmentEpoch> =>
    (options.epoch
      ? await options.epoch()
      : sha256Hex(
          canonicalJson({ workspace: s.d.workspaceIdentity ?? null, tools: registry().hash }),
        )) as EnvironmentEpoch
  const commit = async (events: EventInput[]) => {
    await s.locked(async () => {
      await s.d.log.append(events)
    })
  }
  const settledOutcome = (
    call: ToolApprovalCall,
    result: ToolResult,
    effect: ToolOutcome['effect'],
    evidence: JsonValue,
    decisionId?: string,
  ): ToolOutcome => {
    const code = (result.details as { code?: unknown } | undefined)?.code
    const outcome = resultOutcome(result, effect, evidence)
    return {
      ...outcome,
      snapshot: {
        codec: 'agnes-tool-result-v1',
        value: {
          result: JSON.parse(JSON.stringify(result)) as JsonValue,
          projection: {
            data: {
              toolUseId: call.toolUseId,
              content: toLedgerContent(result.content),
              isError: result.isError === true,
              ...(typeof code === 'string' ? { code } : {}),
              ...(result.structured === undefined ? {} : { structured: result.structured as JsonValue }),
              enforcement: s.d.runtime.enforcement(),
              authz: { decisionId: decisionId ?? 'n/a' },
            },
            trust: prepareRefusals.has(result) || !call.resolvedPolicy.isOpenWorld ? 'trusted' : 'untrusted',
          },
        } as JsonValue,
      },
    }
  }
  const descriptor = (definition: RegisteredTool): ToolDescriptor => ({
    name: definition.name,
    description: definition.description,
    parameters: JSON.parse(JSON.stringify(definition.parameters)) as JsonValue,
    output: { type: 'object' },
    revision: definition.definitionFingerprint,
    concurrencySafe: definition.meta.isConcurrencySafe === true,
    effectClass:
      options.effectClass?.({ name: definition.name, revision: definition.definitionFingerprint }) ??
      (definition.meta.isReadOnly
        ? 'read_only'
        : definition.executionDomain === 'workspace'
          ? 'workspace_mutation'
          : 'external_write'),
  })
  const validate = async (tool: ToolDescriptor, args: JsonValue, preconditions?: JsonValue) => {
    const definition = registry().byName.get(tool.name)
    if (!definition || definition.definitionFingerprint !== tool.revision)
      throw new StaleCandidate('Tool revision changed')
    if (args === null || typeof args !== 'object' || Array.isArray(args))
      throw new InvalidAuthoredArguments('Tool arguments must be an object')
    const checked = validateAgainst(definition.parameters, args)
    if (!checked.ok)
      throw new InvalidAuthoredArguments(`Invalid tool arguments: ${JSON.stringify(checked.errors)}`)
    availability.validate(definition, args)
    if (
      preconditions !== undefined &&
      (!options.validatePreconditions || !(await options.validatePreconditions(preconditions, tool, args)))
    )
      throw new StaleCandidate('Candidate preconditions cannot be verified')
    return structuredClone(args)
  }
  return {
    async snapshot() {
      const facts = options.facts ? await options.facts() : { cwd: s.d.cwd }
      return {
        epoch: await epoch(),
        facts: {
          ...(facts !== null && typeof facts === 'object' && !Array.isArray(facts)
            ? facts
            : { hostFacts: facts }),
          toolAvailability: availability.facts(registry().byName.values()),
        },
      }
    },
    async catalog() {
      return [...registry().byName.values()]
        .filter((definition) => definition.name !== 'computer_use' || s.computerUseAllowed())
        .flatMap((definition) => {
          const tool = availability.project(definition, descriptor(definition))
          return tool ? [tool] : []
        })
    },
    async observe(signal) {
      return [await observeJevWorkspace(s, await epoch(), maxWorkspaceEntries, signal)]
    },
    validate,
    async prepare(intent, signal) {
      if (signal.aborted) throw signal.reason ?? new Error('Cancelled')
      const entries = await options.ledger.read()
      const intended = entries.findLast(
        (entry) => entry.record.kind === 'action.intended' && entry.record.intent.id === intent.id,
      )
      if (
        intended?.record.kind !== 'action.intended' ||
        canonicalJson(intended.record.intent) !== canonicalJson(intent)
      )
        throw new CoreError('E_EXECUTE_PERMIT', 'Missing durable Jev action intent')
      if (
        entries.some(
          (entry) =>
            (entry.record.kind === 'action.dispatching' || entry.record.kind === 'action.settled') &&
            entry.record.intentId === intent.id,
        )
      )
        throw new CoreError('E_EXECUTE_PERMIT', 'Jev action was already dispatched or settled')
      if ((await epoch()) !== intent.environmentEpoch)
        throw new StaleCandidate('Environment authority changed')
      const definition = registry().byName.get(intent.tool)
      if (!definition || definition.definitionFingerprint !== intent.toolRevision)
        throw new StaleCandidate('Tool revision changed')
      if (intent.effectClass !== descriptor(definition).effectClass)
        throw new CoreError('E_EXECUTE_PERMIT', 'Intent effect class does not match its tool')
      await validate(descriptor(definition), intent.arguments, intent.preconditions)
      const policy = resolveValidatedToolCallPolicy(definition, intent.arguments)
      const step = position()
      let argsSeq = s.state.toolCalls.get(intent.id)?.seq
      if (argsSeq === undefined) {
        await s.locked(async () => {
          const receipt = await s.d.log.append([
            s.ev(
              'tool/call',
              {
                toolUseId: intent.id,
                name: intent.tool,
                args: intent.arguments,
                depth: 0,
                ordinal: [...s.state.toolCalls.values()].filter(
                  (call) => call.turn === step.turn && call.step === step.step,
                ).length,
                ...policy,
              },
              { origin: 'system', sourceEventSeqs: [intended.cursor] },
            ),
          ])
          argsSeq = receipt.firstSeq
        })
      }
      if (argsSeq === undefined) throw new CoreError('E_RELATION', 'Missing public call receipt')
      const call: ToolApprovalCall = {
        toolUseId: intent.id,
        name: intent.tool,
        args: intent.arguments,
        argsSeq,
        ...policy,
      }
      let refusedDecisionId: string | undefined
      const refuse = async (code: string, message: string, decisionId?: string) => {
        refusedDecisionId = decisionId
        const result = errorResult(code, message)
        prepareRefusals.add(result)
        return result
      }
      for (;;) {
        const approved = await authorizeToolCall(
          {
            sessionKey: s.key,
            lane: s.lane,
            turn: step.turn,
            step: step.step,
            actor: s.d.actor,
            taint: s.state.taint.get(s.lane) ?? false,
            fullAccess: s.yolo,
            approvalMode: s.d.approvalMode ?? 'manual',
            approvalTimeoutMs: s.preset.approval.timeoutMs,
            profileHash: s.d.resolvedProfileHash,
            lastSeq: s.lastSeq,
            hooks: s.hooks,
            seams: s.d.runtime,
            effects: s.effects,
            sessionAllows: s.sessionAllows,
            clock: s.d.clock,
            requestId: () => s.d.ids.requestId(),
            guardianModel: options.guardianModel ?? (() => s.preset.model.id.primary ?? 'default'),
            budgetCap: () => s.turn?.budgetCap ?? s.preset.budget.perRequestCap,
            markLedgerFailed: () => {
              if (s.turn) s.turn.ledgerFailed = true
            },
            scan: (query) => s.scan(query),
            event: (type, data, extra) => s.ev(type, data, extra),
            commit,
            persistedApproval: (input) =>
              persistedToolApproval(s, input, { consumedRequests: consumedApprovals }),
            refuse,
            waitingApproval: async () => {},
            askApproval: (request, approvalSignal) => s.d.runtime.approvalAsk(request, approvalSignal),
          },
          call,
          definition.meta,
          signal,
        )
        if ('result' in approved) {
          if (approved.park && options.waitForApproval) {
            const requestId = (approved.park.data as { requestId: string }).requestId
            await commit([approved.park])
            await options.waitForApproval({ intent, requestId, event: approved.park }, signal)
            if (!s.state.decisions.has(requestId))
              throw new CoreError('E_RELATION', 'Approval wait completed without a durable decision')
            consumedApprovals.add(requestId)
            continue
          }
          // A missing asynchronous continuation cannot authorize dispatch.
          if (approved.park) await commit([approved.park])
          return {
            kind: 'settled',
            outcome: settledOutcome(
              call,
              approved.result,
              'not_applied',
              { phase: 'not_sent' },
              refusedDecisionId,
            ),
          }
        }
        if (
          policy.executionDomain === 'workspace' &&
          !policy.resolvedPolicy.isReadOnly &&
          !s.d.runtime.sandboxAllowed()
        ) {
          const result = await refuse(
            'SANDBOX_UNAVAILABLE',
            'Workspace sandbox enforcement is unavailable',
            approved.decisionId,
          )
          return {
            kind: 'settled',
            outcome: settledOutcome(call, result, 'not_applied', { phase: 'not_sent' }, approved.decisionId),
          }
        }
        s.assertToolDispatchAvailable(policy.executionDomain)
        prepared.set(intent.id, {
          intentKey: canonicalJson(intent),
          definition,
          call,
          decisionId: approved.decisionId,
        })
        return {
          kind: 'ready',
          ...(descriptor(definition).effectClass === 'read_only' && !policy.resolvedPolicy.isReadOnly
            ? { readOnly: false }
            : {}),
          ...(policy.resolvedPolicy.isReadOnly && policy.resolvedPolicy.isConcurrencySafe
            ? { concurrencySafe: true }
            : {}),
        }
      }
    },
    async execute(intent, signal) {
      const pending = prepared.get(intent.id)
      if (!pending || pending.intentKey !== canonicalJson(intent))
        throw new CoreError('E_EXECUTE_PERMIT', 'Jev dispatch has no authorized preparation')
      prepared.delete(intent.id)
      const entries = await options.ledger.read()
      const barrier = entries.findLast(
        (entry) => entry.record.kind === 'action.dispatching' && entry.record.intentId === intent.id,
      )
      if (
        barrier?.record.kind !== 'action.dispatching' ||
        barrier.record.epoch !== intent.environmentEpoch ||
        entries.some((entry) => entry.record.kind === 'action.settled' && entry.record.intentId === intent.id)
      )
        throw new CoreError('E_EXECUTE_PERMIT', 'Jev dispatch barrier is missing or already settled')
      const { definition, call, decisionId } = pending
      if (
        (await epoch()) !== intent.environmentEpoch ||
        registry().byName.get(intent.tool)?.definitionFingerprint !== intent.toolRevision
      ) {
        const result = errorResult('TOOL_NOT_STARTED', 'Environment changed before dispatch')
        return settledOutcome(call, result, 'not_applied', { phase: 'not_sent' }, decisionId)
      }
      const step = position()
      const controller = new AbortController()
      const abort = () => controller.abort(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      const timeoutMs = s.preset.tools.timeouts[intent.tool] ?? s.preset.tools.timeoutMs
      let executionMeta: JsonValue | undefined
      const contextDeps = (): Omit<ToolContextDeps, 'depth' | 'invoke' | 'fsOps' | 'workspace'> => ({
        sessionKey: s.key,
        lane: s.lane,
        turn: step.turn,
        step: step.step,
        generationDepth: s.generationDepth,
        actor: s.d.actor,
        cwd: s.d.cwd,
        fullAccess: s.yolo,
        runtime: s.d.runtime,
        preset: s.preset,
        children: s.d.children,
        netFetch: s.d.netFetch,
        ...(s.d.publicFetch ? { publicFetch: s.d.publicFetch } : {}),
        log: s.d.logger,
        ...(s.d.toolQuestions ? { toolQuestions: s.d.toolQuestions } : {}),
        listTools: () => [...registry().defs],
        appendPlan: async (items) =>
          (await s.d.log.append([s.ev('plan.items', { items }, { register: 'plan.items' })])).firstSeq,
        requestCompaction: () => {
          throw new CoreError('E_UNSUPPORTED', 'Jev compaction is unavailable')
        },
        progress: () => {},
        artifactJobEvent: async (job) => {
          await commit([s.ev('artifact/job', job, { register: 'artifact/job' })])
        },
        lease: { remainingMs: () => s.d.log.leaseRemainingMs() },
      })
      const waitForApproval = options.waitForApproval
      const nested = createNestedToolExecutor({
        session: s,
        intent,
        rootDispatchSeq: barrier.cursor,
        contextDeps,
        descriptor: (name) => {
          const definition = registry().byName.get(name)
          return definition ? availability.project(definition, descriptor(definition)) : undefined
        },
        validate,
        guardianModel: options.guardianModel ?? (() => s.preset.model.id.primary ?? 'default'),
        rootConcurrencySafe: call.resolvedPolicy.isConcurrencySafe === true,
        ...(options.isQuestionTool ? { isQuestionTool: options.isQuestionTool } : {}),
        ...(waitForApproval
          ? {
              waitForApproval: (requestId: string, event: EventInput, signal: AbortSignal) =>
                waitForApproval({ intent, requestId, event }, signal),
            }
          : {}),
        async assertAuthority() {
          if ((await epoch()) !== intent.environmentEpoch)
            throw new CoreError('E_EXECUTE_PERMIT', 'Nested environment authority changed')
          const current = await options.ledger.read()
          if (
            !current.some(
              (entry) =>
                entry.cursor === barrier.cursor &&
                entry.record.kind === 'action.dispatching' &&
                entry.record.intentId === intent.id,
            ) ||
            current.some(
              (entry) =>
                (entry.record.kind === 'action.settled' || entry.record.kind === 'action.resolved') &&
                entry.record.intentId === intent.id,
            )
          )
            throw new CoreError('E_EXECUTE_PERMIT', 'Nested root dispatch receipt is no longer live')
        },
      })
      try {
        const attempt = await dispatchToolAttempt({
          name: intent.tool,
          executionDomain: call.executionDomain,
          timeoutMs,
          signal: controller.signal,
          ...(s.d.workspaceInvocation ? { workspaceInvocation: s.d.workspaceInvocation } : {}),
          ...(s.d.workspacePublication ? { workspacePublication: s.d.workspacePublication } : {}),
          track: (work) => {
            inFlight.set(
              intent.id,
              work.then(
                () => undefined,
                () => undefined,
              ),
            )
          },
          createContext: (fsOps, workspace) => {
            let context!: ToolContext
            context = buildToolContext(
              {
                ...contextDeps(),
                depth: 0,
                fsOps,
                ...(workspace ? { workspace } : {}),
                invoke: (name, args, opts) => nested.invoke(context, name, args, opts),
              },
              {
                toolUseId: intent.id,
                name: intent.tool,
                signal: controller.signal,
                timeoutMs,
                outputMaxBytes: s.preset.tools.outputMaxBytes,
              },
            )
            return context
          },
          dispatch: (context) => {
            s.d.log.storage.assertSessionAdmitted?.(s.key)
            return dispatchPermittedTool({
              name: intent.tool,
              args: intent.arguments,
              context,
              executionDomain: call.executionDomain,
              attempt: 1,
              effectId: intent.id,
              startSeq: barrier.cursor,
              owner,
              permits,
              ...(s.d.hostToolDispatch ? { hostPort: s.d.hostToolDispatch } : {}),
              invoke: () =>
                nested.runRoot(context, async () => {
                  const invoke = (scoped: ToolContext) => {
                    s.d.log.storage.assertSessionAdmitted?.(s.key)
                    return definition.execute(intent.arguments as never, scoped)
                  }
                  if (!options.observeExecution) return invoke(context)
                  try {
                    const observed = await options.observeExecution(intent, context, invoke)
                    executionMeta = observed.meta
                    return observed.result
                  } catch (error) {
                    executionMeta = observedBuiltinWriteFailure(error)
                    throw error
                  }
                }),
            })
          },
        })
        if (attempt.timedOut || attempt.cancelled) controller.abort(new Error('Jev tool attempt ended'))
        nested.closeAdmission()
        await nested.drain()
        const observation: HostDispatchObservation = attempt.observation
        const cancellation =
          observation.phase === 'may_have_sent' &&
          !attempt.timedOut &&
          !attempt.cancelled &&
          options.isQuestionTool?.({ name: definition.name, revision: definition.definitionFingerprint })
            ? readQuestionCancellation(observation.error, s, intent.id)
            : undefined
        const childRefusal =
          observation.phase === 'may_have_sent' && !attempt.timedOut && !attempt.cancelled
            ? readChildRefusal(definition, observation.error, intent.id, call.argsSeq)
            : undefined
        const compoundUnknown = nested.unknown()
        const result = compoundUnknown
          ? errorResult(
              'TOOL_OUTCOME_UNKNOWN',
              'A nested tool effect remains unknown; the compound root requires resolution.',
            )
          : cancellation
            ? errorResult('ASK_CANCELLED', 'The user cancelled the question; no answer was adopted.')
            : childRefusal
              ? errorResult(
                  childRefusal.code,
                  childRefusal.code === 'E_MODEL_UNKNOWN'
                    ? 'The explicit model override is not configured. Omit model to inherit the actual parent model. No child or workspace was created.'
                    : 'Child creation was refused before a child or workspace was created.',
                )
              : observation.phase === 'responded'
                ? observation.result
                : errorResult(
                    observation.phase === 'not_sent' ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN',
                    String(observation.error),
                  )
        // Deferred jobs require runtime-specific reconciliation; do not claim completion prematurely.
        // A durable user cancellation proves that no answer/business action was adopted. The
        // request may already have been displayed: retain its actual dispatch phase and receipt.
        // A factory preflight proof concerns child/workspace creation, not earlier tool observations.
        const nestedEvidence = nested.evidence()
        const observedProcess = observedBuiltinProcessDisposition(intent, executionMeta)
        const processEffect =
          observedProcess === undefined
            ? undefined
            : observation.phase !== 'responded' ||
                attempt.timedOut ||
                attempt.cancelled ||
                !Array.isArray(nestedEvidence) ||
                nestedEvidence.length !== 0 ||
                'deferred' in result
              ? 'unknown'
              : observedProcess
        const noBuiltinWrite =
          ((observation.phase === 'responded' && observation.result.isError === true) ||
            (observation.phase === 'may_have_sent' &&
              observedBuiltinWriteVersionRefusal(intent, executionMeta))) &&
          !attempt.timedOut &&
          !attempt.cancelled &&
          Array.isArray(nestedEvidence) &&
          nestedEvidence.length === 0 &&
          observedBuiltinWriteNotEntered(intent, executionMeta)
        const effect = compoundUnknown
          ? 'unknown'
          : cancellation || childRefusal || noBuiltinWrite || observation.phase === 'not_sent'
            ? 'not_applied'
            : intent.effectClass === 'read_only'
              ? 'none'
              : (processEffect ??
                (observation.phase === 'responded' && !result.isError && !('deferred' in result)
                  ? 'acknowledged'
                  : 'unknown'))
        const verdict = await s.d.runtime.verify(
          'tool',
          await toolVerifyInput(s, call, true),
          controller.signal,
        )
        const hooked = s.hooks.toolResult
          ? await s.hooks.toolResult({
              toolUseId: intent.id,
              name: intent.tool,
              args: intent.arguments,
              result,
              enforcement: s.d.runtime.enforcement(),
            })
          : undefined
        const finalResult = compoundUnknown ? result : (hooked?.result ?? result)
        // This adapter does not expose Native deferred-job recovery to Jev.
        const recordedResult =
          'deferred' in finalResult
            ? errorResult('DEFERRED_UNSUPPORTED', 'Deferred completion requires an explicit Jev reconciler')
            : finalResult
        await commit([
          s.ev('verifier/signal', {
            scope: 'tool',
            tier: s.preset.verifier.defaultTier,
            verdict: verdict.verdict,
            reasons: verdict.reasons,
            toolUseId: intent.id,
          }),
        ])
        const settled = settledOutcome(
          call,
          recordedResult,
          effect,
          {
            phase: observation.phase,
            timedOut: attempt.timedOut,
            cancelled: attempt.cancelled,
            nestedTools: nested.evidence(),
            ...(noBuiltinWrite ? { builtinWriteNotEntered: true } : {}),
            ...(cancellation ? { questionCancellation: cancellation } : {}),
            ...(childRefusal ? { childCreationRefusal: childRefusal } : {}),
          },
          decisionId,
        )
        const outcome = {
          ...settled,
          content: [
            ...settled.content,
            ...resultOutcome({ content: nested.artifacts() }, undefined, null).content,
          ],
          ...(!compoundUnknown && (cancellation || attempt.cancelled) ? { kind: 'cancelled' as const } : {}),
        }
        return executionMeta === undefined ? outcome : { ...outcome, meta: executionMeta }
      } finally {
        nested.closeAdmission()
        signal.removeEventListener('abort', abort)
      }
    },
    async drain(intentId) {
      await inFlight.get(intentId)
      inFlight.delete(intentId)
      prepared.delete(intentId)
    },
  }
}
