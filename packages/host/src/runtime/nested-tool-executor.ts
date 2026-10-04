import {
  authorizeToolCall,
  buildToolContext,
  CoreError,
  dispatchPermittedTool,
  dispatchToolAttempt,
  ExecutePermitRegistry,
  humanWaitParent,
  managedHumanWaitSignal,
  persistedToolApproval,
  resolveValidatedToolCallPolicy,
  type SessionImpl,
  type ToolApprovalCall,
  type ToolContextDeps,
  toLedgerContent,
  toolVerifyInput,
  withManagedHumanWait,
} from '@agnes/core'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { FrozenIntent, JsonValue, ToolDescriptor, ToolOutcome } from '@agnes/jev-runtime'
import { readQuestionCancellation } from '../questions.js'
import { createJevChildRefusalReader } from './jev-child-refusal.js'
import {
  appendNestedToolJournal,
  type NestedToolBinding,
  type NestedToolEvidence,
} from './nested-tool-journal.js'

const failure = (code: string, message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  details: { code },
})
type Lease = NonNullable<Parameters<SessionImpl['runNestedTool']>[2]>
type Parent = {
  id: string
  depth: number
  open: boolean
  lease: Lease
  context: ToolContext
  pending: Set<Promise<unknown>>
}

export interface NestedToolExecutorOptions {
  session: SessionImpl
  intent: FrozenIntent
  rootDispatchSeq: number
  descriptor(name: string): ToolDescriptor | undefined
  validate(tool: ToolDescriptor, args: JsonValue): Promise<JsonValue>
  contextDeps(): Omit<ToolContextDeps, 'depth' | 'invoke' | 'fsOps' | 'workspace'>
  guardianModel(): string
  rootConcurrencySafe: boolean
  isQuestionTool?(tool: { name: string; revision: string }): boolean
  waitForApproval?(
    requestId: string,
    event: import('@agnes/core').EventInput,
    signal: AbortSignal,
  ): Promise<void>
  assertAuthority(): Promise<void>
}

/** This closure is issued only after the portable root dispatch receipt. It owns no Jev decisions. */
export function createNestedToolExecutor(options: NestedToolExecutorOptions) {
  const s = options.session
  const intent = structuredClone(options.intent)
  const step = s.state.openStep.get(s.lane)
  if (!step) throw new CoreError('E_RELATION', 'Nested execution requires an open root step')
  const writer = s.d.log.writerRunId
  const registryHash = s.currentTools().snapshot(s.lastSeq).hash
  const readChildRefusal = createJevChildRefusalReader(s)
  const parents = new Set<Parent>()
  const children: NestedToolEvidence[] = []
  const work = new Set<Promise<unknown>>()
  const permits = new ExecutePermitRegistry()
  const owner = Object.freeze({})
  let closed = false
  let fault: unknown
  const assertAuthority = async () => {
    const current = s.state.openStep.get(s.lane)
    if (
      closed ||
      s.d.log.writerRunId !== writer ||
      current?.turn !== step.turn ||
      current.step !== step.step ||
      s.currentTools().snapshot(s.lastSeq).hash !== registryHash
    )
      throw new CoreError('E_EXECUTE_PERMIT', 'Nested parent authority is no longer live')
    s.d.log.storage.assertSessionAdmitted?.(s.key)
    await options.assertAuthority()
  }
  const track = <T>(pending: Promise<T>, set = work): Promise<T> => {
    const observed = pending.then(
      () => undefined,
      () => undefined,
    )
    set.add(observed)
    void observed.then(() => set.delete(observed))
    void pending.catch(() => undefined)
    return pending
  }
  const drainSet = async (set: Set<Promise<unknown>>) => {
    while (set.size) await Promise.all([...set])
  }
  const authorize = async (call: ToolApprovalCall, signal: AbortSignal, parent: Parent) => {
    const consumed = new Set<string>()
    let decisionId = 'n/a'
    const commit = async (events: import('@agnes/core').EventInput[]) => {
      await s.locked(() => s.d.log.append(events))
    }
    for (;;) {
      await assertAuthority()
      signal.throwIfAborted()
      const definition = s.currentTools().snapshot(s.lastSeq).byName.get(call.name)
      if (!definition || definition.definitionFingerprint !== call.definitionFingerprint)
        throw new CoreError('E_EXECUTE_PERMIT', 'Nested tool definition changed')
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
          guardianModel: options.guardianModel,
          budgetCap: () => s.turn?.budgetCap ?? s.preset.budget.perRequestCap,
          markLedgerFailed: () => {
            if (s.turn) s.turn.ledgerFailed = true
          },
          scan: (query) => s.scan(query),
          event: (type, data, extra) => s.ev(type, data, extra),
          commit,
          persistedApproval: (input) => persistedToolApproval(s, input, { consumedRequests: consumed }),
          refuse: async (code, message, id) => {
            decisionId = id ?? 'n/a'
            return failure(code, message)
          },
          waitingApproval: async () => {},
          askApproval: (request) =>
            withManagedHumanWait(parent.context, (waitSignal) =>
              s.d.runtime.approvalAsk(request, AbortSignal.any([signal, waitSignal])),
            ),
        },
        call,
        definition.meta,
        signal,
      )
      if (!('result' in approved)) return approved
      const parked = approved.park
      const waitForApproval = options.waitForApproval
      if (!parked || !waitForApproval) {
        if (parked) await commit([parked])
        return { result: approved.result, decisionId }
      }
      await commit([parked])
      const requestId = (parked.data as { requestId: string }).requestId
      await withManagedHumanWait(parent.context, (waitSignal) =>
        waitForApproval(requestId, parked, AbortSignal.any([signal, waitSignal])),
      )
      if (!s.state.decisions.has(requestId))
        throw new CoreError('E_RELATION', 'Nested approval lacks a durable decision')
      consumed.add(requestId)
    }
  }
  const invoke =
    (parent: Parent): ToolContextDeps['invoke'] =>
    (name, authored, opts) => {
      if (closed || !parent.open)
        return Promise.reject(new CoreError('E_EXECUTE_PERMIT', 'Nested parent lifetime ended'))
      const depth = parent.depth + 1
      if (depth > s.preset.depthLimit)
        return Promise.reject(new CoreError('E_DEPTH_EXCEEDED', 'Nested tool depth exceeded'))
      const parentSignal = managedHumanWaitSignal(parent.context) ?? parent.context.signal
      const signal = opts.signal ? AbortSignal.any([parentSignal, opts.signal]) : parentSignal
      const pending = (async () => {
        await assertAuthority()
        signal.throwIfAborted()
        if (name === 'run_code')
          throw new CoreError('E_UNSUPPORTED', 'Jev nested invocation does not enable PTC')
        const tool = options.descriptor(name)
        if (!tool || (name === 'computer_use' && !s.computerUseAllowed()))
          throw new CoreError('E_UNSUPPORTED', `Unavailable nested tool ${name}`)
        const args = await options.validate(tool, authored as JsonValue)
        const definition = s.currentTools().snapshot(s.lastSeq).byName.get(name)
        if (!definition || definition.definitionFingerprint !== tool.revision)
          throw new CoreError('E_EXECUTE_PERMIT', 'Nested tool revision changed')
        const policy = resolveValidatedToolCallPolicy(definition, args)
        const cap = s.turn?.budgetCap ?? s.preset.budget.perRequestCap
        if (cap !== null && s.state.creditsUsed > cap)
          return failure('BUDGET_EXCEEDED', 'Nested tool budget exceeded')
        let call!: ToolApprovalCall
        let binding!: NestedToolBinding
        await s.locked(async () => {
          await assertAuthority()
          signal.throwIfAborted()
          const ordinal = [...s.state.toolCalls.values()].filter(
            (value) => value.turn === step.turn && value.step === step.step,
          ).length
          const toolUseId = s.d.ids.toolUseId(ordinal)
          const receipt = await s.d.log.append([
            s.ev(
              'tool/call',
              {
                toolUseId,
                name,
                args,
                depth,
                ordinal,
                parentEffectId: parent.id,
                ...policy,
              },
              { origin: 'system', sourceEventSeqs: [options.rootDispatchSeq] },
            ),
          ])
          call = { toolUseId, name, args, argsSeq: receipt.firstSeq, ...policy }
          binding = {
            version: 1,
            sessionKey: s.key,
            writerRunId: writer,
            lane: s.lane,
            turn: step.turn,
            step: step.step,
            rootIntentId: intent.id,
            rootDispatchSeq: options.rootDispatchSeq,
            registryHash,
            toolUseId,
            parentToolUseId: parent.id,
            depth,
            callSeq: receipt.firstSeq,
          }
        })
        const evidence: NestedToolEvidence = { ...binding }
        children.push(evidence)
        const settle = async (
          result: ToolResult,
          effect: NonNullable<ToolOutcome['effect']>,
          phase: NonNullable<NestedToolEvidence['phase']>,
          decisionId: string,
          flags: {
            timedOut?: boolean
            cancelled?: boolean
            observedResult?: ToolResult
            questionCancellation?: JsonValue
            childCreationRefusal?: JsonValue
          } = {},
          refused = false,
        ) => {
          const completed = { ...evidence, effect, phase, result: structuredClone(result), ...flags }
          const code = (result.details as { code?: unknown } | undefined)?.code
          const settledSeq = await appendNestedToolJournal(
            s,
            binding,
            'settled',
            completed,
            s.ev(
              'tool/result',
              {
                toolUseId: call.toolUseId,
                content: toLedgerContent(result.content),
                isError: result.isError === true,
                ...(typeof code === 'string' ? { code } : {}),
                ...(result.structured === undefined ? {} : { structured: result.structured }),
                enforcement: s.d.runtime.enforcement(),
                authz: { decisionId },
              },
              {
                origin: 'system',
                trust: refused || !policy.resolvedPolicy.isOpenWorld ? 'trusted' : 'untrusted',
                sourceEventSeqs: [call.argsSeq, ...(evidence.dispatchSeq ? [evidence.dispatchSeq] : [])],
              },
            ),
          )
          Object.assign(evidence, completed, { settledSeq })
          return result
        }
        try {
          if (
            intent.effectClass === 'read_only' &&
            (tool.effectClass !== 'read_only' || !policy.resolvedPolicy.isReadOnly)
          )
            return settle(
              failure('NESTED_MUTATION_REFUSED', 'A read-only Jev root cannot dispatch a mutation child'),
              'not_applied',
              'not_sent',
              'n/a',
              {},
              true,
            )
          const approved = await authorize(call, signal, parent)
          if ('result' in approved)
            return settle(approved.result, 'not_applied', 'not_sent', approved.decisionId, {}, true)
          if (
            policy.executionDomain === 'workspace' &&
            !policy.resolvedPolicy.isReadOnly &&
            !s.d.runtime.sandboxAllowed()
          )
            return settle(
              failure('SANDBOX_UNAVAILABLE', 'Workspace sandbox enforcement is unavailable'),
              'not_applied',
              'not_sent',
              approved.decisionId,
              {},
              true,
            )
          s.assertToolDispatchAvailable(policy.executionDomain)
          return await s.runNestedTool(
            policy.resolvedPolicy.isConcurrencySafe,
            async (lease) => {
              await assertAuthority()
              signal.throwIfAborted()
              const dispatchSeq = await appendNestedToolJournal(s, binding, 'dispatching')
              Object.assign(evidence, { dispatchSeq })
              const controller = new AbortController()
              const abort = () => controller.abort(signal.reason)
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
              const timeoutMs = s.preset.tools.timeouts[name] ?? s.preset.tools.timeoutMs
              const lifetimes = new Set<Promise<unknown>>()
              try {
                const waitParent = humanWaitParent(parent.context)
                const attempt = await dispatchToolAttempt({
                  name,
                  executionDomain: call.executionDomain,
                  timeoutMs,
                  signal: controller.signal,
                  ...(waitParent ? { humanWaitParent: waitParent } : {}),
                  ...(s.d.workspaceInvocation ? { workspaceInvocation: s.d.workspaceInvocation } : {}),
                  ...(s.d.workspacePublication ? { workspacePublication: s.d.workspacePublication } : {}),
                  track: (pending) => {
                    track(pending, lifetimes)
                  },
                  createContext: (fsOps, workspace) => {
                    let context!: ToolContext
                    context = buildToolContext(
                      {
                        ...options.contextDeps(),
                        depth,
                        fsOps,
                        ...(workspace ? { workspace } : {}),
                        invoke: (childName, childArgs, childOpts) => {
                          const scope = [...parents].find((candidate) => candidate.context === context)
                          if (!scope)
                            return Promise.reject(
                              new CoreError('E_EXECUTE_PERMIT', 'Nested scope is not issued'),
                            )
                          return invoke(scope)(childName, childArgs, childOpts)
                        },
                      },
                      {
                        toolUseId: call.toolUseId,
                        name,
                        signal: controller.signal,
                        timeoutMs,
                        outputMaxBytes: s.preset.tools.outputMaxBytes,
                      },
                    )
                    return context
                  },
                  dispatch: (context) =>
                    dispatchPermittedTool({
                      name,
                      args,
                      context,
                      executionDomain: call.executionDomain,
                      attempt: 1,
                      effectId: call.toolUseId,
                      startSeq: dispatchSeq,
                      owner,
                      permits,
                      ...(s.d.hostToolDispatch ? { hostPort: s.d.hostToolDispatch } : {}),
                      invoke: async () => {
                        await assertAuthority()
                        controller.signal.throwIfAborted()
                        const scope: Parent = {
                          id: call.toolUseId,
                          depth,
                          open: true,
                          lease,
                          context,
                          pending: new Set(),
                        }
                        parents.add(scope)
                        try {
                          return await definition.execute(args as never, context)
                        } finally {
                          scope.open = false
                          await drainSet(scope.pending)
                          parents.delete(scope)
                        }
                      },
                    }),
                })
                const observed = attempt.observation
                if (attempt.timedOut || attempt.cancelled) controller.abort(new Error('Nested attempt ended'))
                await drainSet(lifetimes)
                const cancellation =
                  observed.phase === 'may_have_sent' &&
                  !attempt.timedOut &&
                  !attempt.cancelled &&
                  options.isQuestionTool?.({ name, revision: definition.definitionFingerprint })
                    ? readQuestionCancellation(observed.error, s, call.toolUseId)
                    : undefined
                const childRefusal =
                  observed.phase === 'may_have_sent' && !attempt.timedOut && !attempt.cancelled
                    ? readChildRefusal(definition, observed.error, call.toolUseId, call.argsSeq)
                    : undefined
                const result = cancellation
                  ? failure('ASK_CANCELLED', 'The user cancelled the nested question; no answer was adopted.')
                  : childRefusal
                    ? failure(
                        childRefusal.code,
                        'Nested child creation was refused before creating a child or workspace.',
                      )
                    : observed.phase === 'responded' && !('deferred' in observed.result)
                      ? observed.result
                      : failure(
                          observed.phase === 'not_sent' ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN',
                          observed.phase === 'responded'
                            ? 'Deferred nested completion is unsupported'
                            : String(observed.error),
                        )
                const effect =
                  cancellation || childRefusal || observed.phase === 'not_sent'
                    ? 'not_applied'
                    : observed.phase !== 'responded' || (!policy.resolvedPolicy.isReadOnly && result.isError)
                      ? 'unknown'
                      : policy.resolvedPolicy.isReadOnly
                        ? 'none'
                        : 'acknowledged'
                const observedResult = structuredClone(
                  observed.phase === 'responded' ? observed.result : result,
                )
                const verdict = await s.d.runtime.verify(
                  'tool',
                  await toolVerifyInput(s, call, true),
                  controller.signal,
                )
                const hooked = await s.hooks.toolResult?.({
                  toolUseId: call.toolUseId,
                  name,
                  args,
                  result,
                  enforcement: s.d.runtime.enforcement(),
                })
                await s.locked(() =>
                  s.d.log.append([
                    s.ev('verifier/signal', {
                      scope: 'tool',
                      tier: s.preset.verifier.defaultTier,
                      verdict: verdict.verdict,
                      reasons: verdict.reasons,
                      toolUseId: call.toolUseId,
                    }),
                  ]),
                )
                return settle(hooked?.result ?? result, effect, observed.phase, approved.decisionId, {
                  timedOut: attempt.timedOut,
                  cancelled: attempt.cancelled,
                  observedResult,
                  ...(cancellation ? { questionCancellation: cancellation } : {}),
                  ...(childRefusal ? { childCreationRefusal: childRefusal } : {}),
                })
              } finally {
                signal.removeEventListener('abort', abort)
              }
            },
            parent.lease,
            signal,
          )
        } catch (error) {
          if (evidence.dispatchSeq !== undefined) {
            Object.assign(evidence, { effect: 'unknown' })
            try {
              return await settle(
                failure('TOOL_OUTCOME_UNKNOWN', String(error)),
                'unknown',
                'may_have_sent',
                'n/a',
              )
            } catch (journalError) {
              fault ??= journalError
              throw journalError
            }
          }
          return settle(
            failure('TOOL_NOT_STARTED', String(error)),
            'not_applied',
            'not_sent',
            'n/a',
            {},
            true,
          )
        }
      })()
      track(pending)
      track(pending, parent.pending)
      return pending
    }
  return {
    async runRoot(context: ToolContext, run: () => Promise<ToolResult>): Promise<ToolResult> {
      return s.runNestedTool(
        options.rootConcurrencySafe,
        async (lease) => {
          const parent: Parent = { id: intent.id, depth: 0, open: true, lease, context, pending: new Set() }
          parents.add(parent)
          try {
            return await run()
          } finally {
            parent.open = false
            await drainSet(parent.pending)
            parents.delete(parent)
          }
        },
        undefined,
        context.signal,
      )
    },
    invoke(
      context: ToolContext,
      name: string,
      args: unknown,
      opts: Parameters<ToolContextDeps['invoke']>[2],
    ) {
      const parent = [...parents].find((candidate) => candidate.context === context)
      if (!parent) return Promise.reject(new CoreError('E_EXECUTE_PERMIT', 'Root scope is not issued'))
      return invoke(parent)(name, args, opts)
    },
    closeAdmission() {
      closed = true
      for (const parent of parents) parent.open = false
    },
    async drain() {
      await drainSet(work)
      if (fault) throw fault
    },
    evidence(): JsonValue {
      return structuredClone(children) as unknown as JsonValue
    },
    unknown() {
      return children.some(
        (child) =>
          child.effect === 'unknown' || (child.dispatchSeq !== undefined && child.settledSeq === undefined),
      )
    },
    artifacts() {
      return children.flatMap((child) =>
        [child.result, child.observedResult].flatMap(
          (result) => result?.content.filter((block) => block.type !== 'text') ?? [],
        ),
      )
    },
  }
}
