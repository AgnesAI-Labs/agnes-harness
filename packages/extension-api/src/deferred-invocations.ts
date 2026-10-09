import type { Actor, JsonValue } from '@agnes/protocol'
import type { LoopContext, LoopFactory, LoopStepOutcome } from './loop.js'
import type { ToolResult } from './tool.js'

/** Durable plugin-agnostic work. Validation is not authorization: execute/resume still owns policy. */
export interface DeferredToolInvocation {
  id: string
  sessionKey: string
  lane: string
  source: string
  sourceSeq: number
  actor: Actor
  tool: string
  args: JsonValue
}
export type DeferredInvocationState = 'queued' | 'executing' | 'pending-approval' | 'succeeded' | 'failed'
export interface DeferredInvocationReceipt {
  invocation: DeferredToolInvocation
  state: DeferredInvocationState
  seq: number
  resultSeq?: number
  toolCallSeq?: number
  approvalId?: string
  result?: ToolResult
  error?: { code: string; message: string; outcomeUnknown: boolean; retryable: boolean }
}
/** Host-owned durable ports. Scan includes only this lane's trusted invocation facts. */
export interface DeferredInvocationLedgerPort {
  scan(): Promise<readonly import('@agnes/protocol').EventEnvelope[]>
  append(type: string, data: JsonValue, actor: Actor, sourceSeq?: number): Promise<number>
  outcome(
    id: string,
  ): Promise<{ resultSeq?: number; toolCallSeq?: number; approvalId?: string; result?: ToolResult }>
  wake(id: string, actor: Actor, signal: AbortSignal): Promise<void>
}
/** One lane, bound by Host; every mutation is durable before returning. Never an authorization port. */
export interface DeferredToolInvocationQueue {
  readonly sessionKey: string
  readonly lane: string
  enqueue(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<DeferredInvocationReceipt>
  /** Returns the oldest unfinished invocation. Terminal receipts remain readable after notification. */
  next(signal: AbortSignal): Promise<DeferredInvocationReceipt | null>
  read(id: string, signal: AbortSignal): Promise<DeferredInvocationReceipt | null>
  transition(
    id: string,
    expectedSeq: number,
    state: DeferredInvocationState,
    outcome?: Pick<DeferredInvocationReceipt, 'result' | 'error'>,
  ): Promise<DeferredInvocationReceipt>
  /** Idempotent producer notification; retry missing delivery after restart without rerunning tools. */
  notify(signal: AbortSignal): Promise<void>
}
/** Producer callbacks receive an owner-bound session, never another plugin's queue authority. */
export interface DeferredInvocationProducer {
  source: string
  validate(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<void>
  changed(receipt: DeferredInvocationReceipt, signal: AbortSignal): Promise<void>
}
export interface DeferredInvocationRegistryPort {
  register(producer: DeferredInvocationProducer): () => void
  forSession(sessionKey: string, lane: string): DeferredToolInvocationQueue | undefined
}

const receiptPending = (receipt: DeferredInvocationReceipt) =>
  receipt.state === 'queued' || receipt.state === 'executing'
const failure = (code: string, message: string, unknown = false) => ({
  code,
  message,
  outcomeUnknown: unknown,
  retryable: !unknown,
})
const codeOf = (error: unknown) =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'DEFERRED_TOOL_FAILED'

/**
 * Drain one invocation at a safe step boundary. No queue means no reads, writes or scheduling changes.
 * Queued work never interrupts a planned tool batch, compaction or failed/cancelled turn.
 */
export async function drainDeferredToolInvocations(
  ctx: LoopContext,
  signal: AbortSignal,
): Promise<LoopStepOutcome | null> {
  const queue = ctx.deferredInvocations
  if (!queue) return null
  signal.throwIfAborted()
  await queue.notify(signal)
  const previous = await queue.next(signal)
  if (!previous) return null
  const call = previous.invocation
  if (call.sessionKey !== ctx.sessionKey || call.lane !== ctx.lane)
    throw new Error('Deferred invocation belongs to another session or lane')
  const continuation = ctx.turn.continuation()
  if (!continuation) {
    if (receiptPending(previous) && !previous.approvalId) await queue.enqueue(call, signal)
    return null
  }
  if (ctx.turn.cancelled() || signal.aborted) return null
  if (previous.state === 'queued' && continuation !== 'model' && continuation !== 'failure') return null
  if (previous.state !== 'queued' && !['model', 'tools', 'failure'].includes(continuation)) return null
  let receipt = previous
  const set = async (
    state: DeferredInvocationState,
    outcome?: Pick<DeferredInvocationReceipt, 'result' | 'error'>,
  ) => {
    receipt = await queue.transition(call.id, receipt.seq, state, outcome)
    await queue.notify(signal)
  }
  const complete = async (result: ToolResult) => {
    if (Object.hasOwn(result, 'deferred')) result = await ctx.jobs.join(call.id, signal)
    const original = await queue.read(call.id, signal)
    const details = result.details ?? original?.result?.details
    const detailCode =
      details && typeof details === 'object' && !Array.isArray(details) && typeof details.code === 'string'
        ? details.code
        : 'DEFERRED_TOOL_ERROR'
    const notDispatched = [
      'TOOL_NOT_FOUND',
      'TOOL_DISPATCH_NOT_SENT',
      'HOOK_DENIED',
      'AUTHZ_DENIED',
      'POLICY_DENIED',
      'APPROVAL_REJECTED',
      'APPROVAL_TIMEOUT',
      'APPROVAL_UNAVAILABLE',
      'SANDBOX_UNAVAILABLE',
      'E_FS_DENIED',
    ].includes(detailCode)
    await set(result.isError ? 'failed' : 'succeeded', {
      result,
      ...(result.isError ? { error: failure(detailCode, 'The tool returned an error', !notDispatched) } : {}),
    })
    await queue.notify(signal)
  }
  try {
    const effect = await ctx.effects.status(call.id)
    if (effect.status === 'responded') {
      if (Array.isArray(effect.result)) throw new Error('Deferred invocation receipt is not a tool result')
      await complete(
        await ctx.tools.execute({ invocationId: call.id, name: call.tool, args: call.args }, signal),
      )
    } else if (receipt.state === 'pending-approval' || receipt.approvalId !== undefined) {
      // Default/custom Loops reopen the original parked turn before entering this boundary.
      if (receipt.state === 'pending-approval') await set('executing')
      await complete(await ctx.tools.resume(call.id, signal))
    } else if (effect.status === 'may-have-sent') {
      await set('failed', {
        error: failure(
          'DEFERRED_OUTCOME_UNKNOWN',
          'Reconcile the original tool effect before retrying',
          true,
        ),
      })
      await queue.notify(signal)
    } else if (continuation === 'failure') {
      await set('failed', {
        error: failure('DEFERRED_NOT_DISPATCHED', 'The original turn ended before tool dispatch'),
      })
      await queue.notify(signal)
    } else {
      if (receipt.state === 'queued') await set('executing')
      // The queue carries arguments, never a callable function or an approval decision.
      await complete(
        await ctx.tools.execute({ invocationId: call.id, name: call.tool, args: call.args }, signal),
      )
    }
  } catch (error) {
    signal.throwIfAborted()
    const code = codeOf(error)
    if (code === 'PARKED' || code === 'E_LANE_BUSY') {
      if (receipt.state !== 'pending-approval') await set('pending-approval')
      return { outcome: 'parked', phase: 'deferred-tool-approval', reason: 'parked' }
    }
    // Persistence/notification failures after a terminal commit must be retried as delivery, not tools.
    if (receipt.state === 'succeeded' || receipt.state === 'failed') throw error
    const status = await ctx.effects.status(call.id)
    if (status.status === 'responded') throw error
    await set('failed', {
      error: failure(
        code,
        'Deferred tool execution failed; inspect its original receipt',
        status.status !== 'not-sent',
      ),
    })
    await queue.notify(signal)
  }
  return { outcome: 'running', phase: 'deferred-tool-result' }
}

/** Host attaches the optional queue without changing Core or the selected Loop's identity/codec. */
export function withDeferredToolInvocations(
  factory: LoopFactory,
  resolve: DeferredInvocationRegistryPort['forSession'],
): LoopFactory {
  const context = (ctx: LoopContext): LoopContext =>
    Object.defineProperty(Object.create(ctx), 'deferredInvocations', {
      get: () => resolve(ctx.sessionKey, ctx.lane),
      enumerable: true,
    })
  return {
    ...factory,
    create: (ctx, signal) => factory.create(context(ctx), signal),
    resume: (ctx, checkpoint, signal) => factory.resume(context(ctx), checkpoint, signal),
  }
}
