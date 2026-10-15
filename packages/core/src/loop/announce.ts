import { type OpStateObj, withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { LoopToolCall, LoopToolCallOptions, ToolResult } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { PlannedCall } from '../execution/turn/tools.js'
import {
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
  type PersistedToolPolicyFields,
  toolPolicyBindingProblem,
} from '../registry/tool-policy.js'
import {
  callableTool,
  plannedCallState,
  runPlannedTool,
  toolCallRows,
  validatedCallPolicy,
} from '../step/reentry.js'
import type { SessionImpl } from '../step/session.js'
import type { LoopInvocations } from './invocations.js'

type Announce = NonNullable<LoopToolCallOptions['announce']>
type Call = LoopToolCall & { invocationId: string }
/** A planned call with the receipt it settles. */
type Planned = { call: PlannedCall; invocationId: string; input: ReturnType<typeof receiptInput> }

/** What the announce path shares with the loop context that owns it. */
export interface AnnounceDeps {
  readonly invocations: LoopInvocations
  prepareTools(signal: AbortSignal): Promise<void>
  closeParked(events: EventInput[]): Promise<void>
}

/**
 * `tools.execute` and `tools.batch` with `announce`. The calls are recorded as one new assistant
 * message that asked for them, in the same transaction as the call rows and before anything runs,
 * so the history never holds the message without its calls or a call without its message, and a
 * call never attaches to an earlier message that did not ask for it. Each call then goes through
 * the same approval and execution path as any other.
 */
export function announcedTools(s: SessionImpl, deps: AnnounceDeps) {
  // A replay writes no new fence, so this keeps two replays of one id from running it twice.
  const resuming = new Set<string>()
  const run = async (
    calls: readonly LoopToolCall[],
    signal: AbortSignal,
    announce: Announce,
    single: boolean,
  ) => {
    const releaseEffect = await s.controls.beginEffect()
    const done = s.beginLoopOperation()
    try {
      if (!calls.length) return []
      signal = AbortSignal.any([signal, s.ac.signal])
      const owned = structuredClone(calls).map((call) => ({
        ...call,
        invocationId: call.invocationId ?? s.d.ids.effectId(),
      }))
      const ids = owned.map((call) => call.invocationId)
      // Refused before any receipt is read or written: two calls under one id cannot be told apart,
      // and the second one's fence would leave the id refused for good.
      if (new Set(ids).size !== ids.length)
        throw new CoreError('E_RELATION', 'An announced batch names the same invocationId more than once')
      const receipts = []
      for (const call of owned) receipts.push(await deps.invocations.status(call.invocationId))
      if (receipts.every((receipt) => receipt.status === 'not-sent'))
        return await announceNew(s, deps, owned, signal, announce, single)
      if (receipts.some((receipt) => receipt.status === 'not-sent'))
        throw new CoreError('E_RELATION', 'An announced batch mixes new and recorded invocations')
      if (ids.some((id) => resuming.has(id)))
        throw new CoreError('E_RELATION', 'Announced invocation is already resuming')
      for (const id of ids) resuming.add(id)
      try {
        return await replay(s, deps, owned, receipts, signal, single)
      } finally {
        for (const id of ids) resuming.delete(id)
      }
    } finally {
      done()
      releaseEffect()
    }
  }
  return {
    async execute(call: LoopToolCall, signal: AbortSignal, announce: Announce): Promise<ToolResult> {
      const [result] = await run([call], signal, announce, true)
      if (!result) throw new CoreError('E_RELATION', 'Announced call returned no result')
      return result
    },
    batch: (calls: readonly LoopToolCall[], signal: AbortSignal, announce: Announce) =>
      run(calls, signal, announce, false),
  }
}

/** The receipt input: `announce` is part of it, so the same id cannot be replayed without it. */
function receiptInput(call: Pick<LoopToolCall, 'name' | 'args'>) {
  return { name: call.name, args: call.args, announce: true }
}

async function announceNew(
  s: SessionImpl,
  deps: AnnounceDeps,
  calls: readonly Call[],
  signal: AbortSignal,
  announce: Announce,
  single: boolean,
): Promise<ToolResult[]> {
  const op = s.op()
  if (!op) throw new Error('Loop operation requires an accepted input')
  if (!s.turn) await s.rehydrateTurn(op)
  // Everything is checked before the first row, so a refused batch leaves nothing behind.
  const content = announcedContent(announce)
  const policies = checkedPolicies(s, calls)
  await deps.prepareTools(signal)
  assertQuiet(s, s.op())
  for (const call of calls)
    if ((await deps.invocations.claim(call.invocationId, receiptInput(call))) !== undefined)
      throw new CoreError('E_RELATION', 'Announced invocation was recorded concurrently')
  const t = s.turn
  if (!t) throw new CoreError('E_RELATION', 'Announced tool calls lost their turn')
  const plans = calls.map((call, i) => {
    const policy = policies[i]
    if (!policy) throw new CoreError('E_RELATION', 'Announced call lost its policy')
    const ordinal = t.ordinal++
    const { name, args, invocationId } = call
    return { toolUseId: s.d.ids.toolUseId(ordinal), name, args, ordinal, policy, invocationId }
  })
  const rows: EventInput[] = [
    s.ev(
      'assistant/message',
      {
        content,
        stopReason: 'tool_use',
        ...(announce !== true && t.lastHeaderSeq ? { requestSeq: t.lastHeaderSeq } : {}),
      },
      { origin: 'model' },
    ),
  ]
  // Where each call row lands, read off the rows as written: after the message, every call is a
  // call row and its link row, so call i is committed at the message's seq + 1 + 2i.
  const offsets = plans.map((plan) => {
    const at = rows.length
    rows.push(...toolCallRows(s, plan, { depth: 0, invocationId: plan.invocationId }))
    return at
  })
  const at = (assistantSeq: Seq, i: number) => (assistantSeq + (offsets[i] ?? 0)) as Seq
  const [assistantSeq] = await s.transition(rows, (cur, seq) => {
    const calls = plans.map((plan, i) => plannedCallState(plan, at(seq, i), { depth: 0 }))
    return withPhase(
      assertQuiet(s, cur),
      { kind: 'tools', batch: { assistantSeq: seq, calls } },
      { latestAssistantSeq: seq },
    )
  })
  if (assistantSeq === undefined)
    throw new CoreError('E_RELATION', 'Announced call commit returned no sequence')
  const planned = plans.map(({ policy, invocationId, ...plan }, i) => ({
    call: { ...plan, argsSeq: at(assistantSeq, i), ...policy },
    invocationId,
    input: receiptInput(plan),
  }))
  return runPlanned(s, deps, planned, signal, single)
}

/**
 * A recorded batch replays call by call: a responded call returns its result, and an announced call
 * that was planned but never dispatched runs now without writing its rows again. Anything else is
 * refused as before, so the loop reconciles it.
 */
async function replay(
  s: SessionImpl,
  deps: AnnounceDeps,
  calls: readonly Call[],
  receipts: readonly { status: string }[],
  signal: AbortSignal,
  single: boolean,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  const pending: Array<Planned & { index: number }> = []
  for (const [index, call] of calls.entries()) {
    const input = receiptInput(call)
    const planned =
      receipts[index]?.status === 'may-have-sent' &&
      (await deps.invocations.claimedFor(call.invocationId, input))
        ? await undispatched(s, deps.invocations, call.invocationId)
        : undefined
    if (planned) {
      pending.push({ index, call: planned, invocationId: call.invocationId, input })
      continue
    }
    const cached = await deps.invocations.claim(call.invocationId, input)
    if (!cached || Array.isArray(cached))
      throw new CoreError('E_RELATION', 'Invocation result is not a tool response')
    results[index] = cached as ToolResult
  }
  if (pending.length) {
    // The calls finish in the step that planned them (a result may not land in another step), so
    // no step is opened or closed here: the turn is only checked the way a new step would be.
    signal.throwIfAborted()
    const op = s.op()
    if (s.closingOrClosed || !op || op.control.status === 'cancel_requested')
      throw new CoreError('E_CLOSED', 'Loop operation was closed or cancelled')
    if (!s.turn) await s.rehydrateTurn(op)
    const ran = await runPlanned(s, deps, pending, signal, single)
    for (const [k, item] of pending.entries()) {
      const result = ran[k]
      if (result) results[item.index] = result
    }
  }
  return results
}

/**
 * The planned call of an announced invocation that never reached dispatch: still `planned` in the
 * batch, with no effect and no result. Core writes a call's effect intent only after its approval
 * and immediately before dispatch, so such a call has not run and may run now, provided the step
 * that planned it is still open: its result has to land in that step.
 */
async function undispatched(
  s: SessionImpl,
  invocations: LoopInvocations,
  id: string,
): Promise<PlannedCall | undefined> {
  const toolUseId = await invocations.toolUseId(id)
  const op = s.op()
  const call =
    toolUseId && op?.phase.kind === 'tools'
      ? op.phase.batch.calls.find((candidate) => candidate.toolUseId === toolUseId)
      : undefined
  if (!toolUseId || call?.status !== 'planned' || call.effectId !== undefined) return undefined
  if (!hasCompleteToolPolicyEnvelope(call)) return undefined
  const origin = s.state.toolCalls.get(toolUseId)
  const step = s.state.openStep.get(s.lane)
  if (!origin || !step || origin.turn !== step.turn || origin.step !== step.step) return undefined
  const [row] = await s.d.log.scan({ fromSeq: call.argsSeq, toSeq: call.argsSeq, limit: 1 })
  const data = row?.data as (PersistedToolPolicyFields & { toolUseId?: unknown; args?: unknown }) | undefined
  if (!row || !hasTrustedToolCallProvenance(row) || data?.toolUseId !== toolUseId) return undefined
  if (toolPolicyBindingProblem(call, data)) return undefined
  const results = await scanAll((query) => s.d.log.scan(query), {
    fromSeq: call.argsSeq,
    toSeq: s.lastSeq,
    type: 'tool/result',
    lane: s.lane,
  })
  if (results.some((result) => (result.data as { toolUseId?: unknown }).toolUseId === toolUseId))
    return undefined
  const { name, ordinal, argsSeq, resolvedPolicy, executionDomain, definitionFingerprint, policyHash } = call
  return {
    toolUseId,
    name,
    args: data.args,
    ordinal,
    argsSeq,
    resolvedPolicy,
    executionDomain,
    definitionFingerprint,
    policyHash,
  }
}

/** Runs planned calls the way `execute` and `batch` run theirs, settling each receipt. */
async function runPlanned(
  s: SessionImpl,
  deps: AnnounceDeps,
  planned: readonly Planned[],
  signal: AbortSignal,
  single: boolean,
): Promise<ToolResult[]> {
  const parked: EventInput[] = []
  const runOne = async (item: Planned, callSignal: AbortSignal) => {
    const result = await runPlannedTool(s, item.call, {
      signal: callSignal,
      depth: 0,
      onPark: (event) => {
        parked.push(event)
      },
    })
    await deps.invocations.settle(item.invocationId, item.input, result)
    return result
  }
  const [only] = planned
  if (single && only) {
    try {
      return [await runOne(only, signal)]
    } catch (error) {
      if (parked.length) await deps.closeParked(parked)
      throw error
    }
  }
  const runtime = await s.toolRuntime()
  let failed = false
  let failure: unknown
  const results = await runtime.batch(
    planned.map((item, index) => ({
      id: String(index),
      name: item.call.name,
      args: structuredClone(item.call.args) as JsonValue,
      concurrencySafe: item.call.resolvedPolicy.isConcurrencySafe === true,
    })),
    {
      dispatch: async (input, callSignal) => {
        try {
          const item = planned[Number(input.id)]
          if (!item) throw new CoreError('E_RELATION', 'runtime dispatched an unknown call')
          return await runOne(item, callSignal)
        } catch (error) {
          if (!failed) failure = error
          failed = true
          return { content: [{ type: 'text', text: 'Tool dispatch failed' }], isError: true }
        }
      },
    },
    signal,
  )
  // Drain every sibling before closing the turn or surfacing a failure.
  if (parked.length) await deps.closeParked(parked)
  if (failed) throw failure
  return [...results]
}

/** Only text and thinking blocks, as the assistant message row allows. */
function announcedContent(announce: Announce) {
  if (announce === true) return []
  const content = (announce as { content?: unknown }).content
  const valid =
    Array.isArray(content) &&
    content.every((block: { type?: unknown; text?: unknown } | null) => {
      const keys = block && typeof block === 'object' ? Object.keys(block) : []
      return (
        (block?.type === 'text' || block?.type === 'thinking') &&
        typeof block.text === 'string' &&
        keys.length === 2
      )
    })
  if (!valid) throw new CoreError('E_ENVELOPE', 'Announced content may hold only text and thinking blocks')
  return structuredClone(content) as Exclude<Announce, true>['content']
}

/** The checks `tools.invoke` makes before it writes a call, made for every call up front. */
function checkedPolicies(s: SessionImpl, calls: readonly Call[]) {
  const t = s.turn
  if (!t) throw new CoreError('E_RELATION', 'Announced tool calls require an accepted input')
  const cap = s.turnBudgetCap()
  if (cap !== null && s.state.creditsUsed > cap)
    throw Object.assign(new Error('BUDGET_EXCEEDED'), { code: 'BUDGET_EXCEEDED' })
  return calls.map((call) => validatedCallPolicy(callableTool(s, t, call.name), call.args))
}

/** A new assistant message opens a new batch, so nothing from the previous one may still be open. */
function assertQuiet(s: SessionImpl, op: OpStateObj | null): OpStateObj {
  if (op?.phase.kind !== 'tools')
    throw new CoreError('E_RELATION', 'Announced tool calls require the tools phase')
  if (s.pendingEffects().length || op.phase.batch.calls.some((call) => call.status !== 'completed'))
    throw new CoreError('E_RELATION', 'Announced tool calls require settled effects and calls')
  return op
}
