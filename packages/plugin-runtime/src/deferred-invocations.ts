import type { LoopContext, LoopFactory, LoopStepOutcome, ToolResult } from '@agnes/extension-api'
import {
  deferredQueueKind,
  type DeferredInvocationReceipt,
  type DeferredInvocationState,
  type DeferredToolInvocationQueue,
} from './deferred-contract.js'

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
  const queue = await ctx.services?.get(deferredQueueKind)
  if (!queue) return null
  signal.throwIfAborted()
  await queue.notify(signal)
  const previous = await queue.next(signal)
  if (!previous) return null
  const call = previous.invocation
  if (call.sessionKey !== ctx.sessionKey || call.lane !== ctx.lane)
    throw new Error('Deferred invocation belongs to another session or lane')
  let continuation = ctx.turn.continuation()
  if (!continuation && previous.approvalId) {
    // Approval rejection can settle the original receipt without reopening a turn.
    const resumed = await ctx.input.resumeParked()
    if (resumed === 'waiting' || resumed === false)
      return { outcome: 'parked', phase: 'deferred-tool-approval', reason: 'parked' }
    continuation = ctx.turn.continuation()
  }
  if (!continuation && (await ctx.effects.status(call.id)).status !== 'responded') {
    if (receiptPending(previous) && !previous.approvalId) await queue.enqueue(call, signal)
    return null
  }
  if (ctx.turn.cancelled() || signal.aborted) return null
  if (previous.state === 'queued' && continuation !== 'model' && continuation !== 'failure') return null
  if (continuation && previous.state !== 'queued' && !['model', 'tools', 'failure'].includes(continuation))
    return null
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
      // Resume the original ticket; never create a replacement approval or tool call.
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

/** Host attaches the session queue through the generic services reader. */
export function withDeferredToolInvocations(
  factory: LoopFactory,
  resolve: (sessionKey: string, lane: string) => DeferredToolInvocationQueue | undefined,
): LoopFactory {
  const context = (ctx: LoopContext): LoopContext => {
    const services = {
      get(kind: Parameters<NonNullable<LoopContext['services']>['get']>[0]) {
        return kind === deferredQueueKind ? resolve(ctx.sessionKey, ctx.lane) : ctx.services?.get(kind)
      },
    }
    return Object.defineProperty(Object.create(ctx), 'services', {
      value: services,
      enumerable: true,
    })
  }
  return {
    ...factory,
    create: (ctx, signal) => factory.create(context(ctx), signal),
    resume: (ctx, checkpoint, signal) => factory.resume(context(ctx), checkpoint, signal),
  }
}
