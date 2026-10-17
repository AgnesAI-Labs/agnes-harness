import type { GenericLoopPorts, LoopToolCallOptions, ToolResult } from '@agnes/extension-api'
import { classifyReadBatch, classifyResult } from './profile.js'
import type { Observation, PendingCall, Phase } from './types.js'
import { clip, errorCode } from './util.js'

/** Core refusals of an announced call that the step records as a recoverable refusal. */
export const REFUSAL_CODES = [
  'TOOL_ARGS_INVALID',
  'TOOL_NOT_FOUND',
  'TOOL_NOT_DISCLOSED',
  'TOOL_POLICY_INVALID',
] as const

export type DispatchDeps = {
  tools: GenericLoopPorts['tools']
  effects: GenericLoopPorts['effects']
  /** Records the calls about to be announced before anything is sent under their ids. */
  save(calls: PendingCall[]): Promise<void>
}

export type DispatchOutcome =
  | { kind: 'results'; calls: PendingCall[]; results: ToolResult[]; dropped: number; batchNote?: string }
  | {
      kind: 'refused'
      code: 'REFUSED_BY_CORE' | 'INTERNAL_RELATION'
      coreCode: string
      message: string
      calls: PendingCall[]
    }
  | { kind: 'budget'; message: string }
  | { kind: 'unknown'; calls: PendingCall[] }

/** Left for the driver: an approval wait, a revoked generation, or a refused admission. */
const RETHROWN = new Set(['PARKED', 'E_CLOSED', 'E_BUDGET'])
const RELATION = new Set(['E_RELATION', 'E_ENVELOPE'])

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message
  return String(error)
}

function optionsOf(call: PendingCall): LoopToolCallOptions {
  return call.announce === 'true' ? { announce: true } : { announce: { content: call.content ?? [] } }
}

/** All calls of one dispatch share the announce choice of the first. */
async function send(calls: PendingCall[], deps: DispatchDeps, signal: AbortSignal): Promise<ToolResult[]> {
  const first = calls[0]
  if (first === undefined) throw new Error('Jev loop dispatch needs at least one call')
  const wire = calls.map((call) => ({ invocationId: call.invocationId, name: call.name, args: call.args }))
  const options = optionsOf(first)
  if (wire.length === 1 && wire[0] !== undefined) return [await deps.tools.execute(wire[0], signal, options)]
  return [...(await deps.tools.batch(wire, signal, options))]
}

type Handled = { code: string; message: string; outcome: DispatchOutcome | null }

/** Maps a thrown dispatch error; `outcome: null` means the calls were refused and may be narrowed. */
function classify(error: unknown, calls: PendingCall[]): Handled {
  const code = errorCode(error)
  if (code === undefined || RETHROWN.has(code)) throw error
  const message = messageOf(error)
  if (code === 'BUDGET_EXCEEDED') return { code, message, outcome: { kind: 'budget', message } }
  if (RELATION.has(code)) {
    return {
      code,
      message,
      outcome: { kind: 'refused', code: 'INTERNAL_RELATION', coreCode: code, message, calls },
    }
  }
  return { code, message, outcome: null }
}

async function attempt(
  calls: PendingCall[],
  deps: DispatchDeps,
  signal: AbortSignal,
  onRelation?: (handled: Handled) => Promise<DispatchOutcome>,
): Promise<DispatchOutcome> {
  try {
    return { kind: 'results', calls, results: await send(calls, deps, signal), dropped: 0 }
  } catch (error) {
    const handled = classify(error, calls)
    if (handled.code === 'E_RELATION' && onRelation) return await onRelation(handled)
    if (handled.outcome !== null) return handled.outcome
    const first = calls[0]
    if (calls.length === 1 || first === undefined) {
      return {
        kind: 'refused',
        code: 'REFUSED_BY_CORE',
        coreCode: handled.code,
        message: handled.message,
        calls,
      }
    }
    // A refusal before the write leaves `t0` unused; a coded error after it (an approval or policy
    // classifier failure) leaves `t0` with a receipt. Reusing the id is safe either way: Core
    // replays a receipted call from its receipt. Saving the narrowed list first means a restart
    // replays exactly the call that was announced.
    const others = calls.length - 1
    const batchNote = `[runtime observation] ${others} other calls in the batch were not executed: ${handled.code} (dispatch); reason (data): ${JSON.stringify(clip(handled.message, 200))}`
    await deps.save([first])
    const single = await attempt([first], deps, signal, onRelation)
    return single.kind === 'results' ? { ...single, dropped: others, batchNote } : single
  }
}

/**
 * Announces the calls as one assistant message: `tools.execute` for one call, `tools.batch` for
 * several. A batch Core refuses falls back to its first call alone.
 */
export async function dispatchCalls(
  calls: PendingCall[],
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  await deps.save(calls)
  return await attempt(calls, deps, signal)
}

/**
 * Replays recorded calls with the same ids, names, arguments and announce choice. When Core refuses
 * the replay because the calls are already unsettled or settled, the receipts decide: any call that
 * may have been sent makes the outcome unknown; receipts for every call give their results.
 */
export async function replayCalls(
  calls: PendingCall[],
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  return await attempt(calls, deps, signal, async (handled) => {
    const statuses = await Promise.all(calls.map((call) => deps.effects.status(call.invocationId)))
    if (statuses.some((status) => status.status === 'may-have-sent')) return { kind: 'unknown', calls }
    const results: ToolResult[] = []
    for (const status of statuses) {
      if (status.status !== 'responded' || Array.isArray(status.result)) break
      results.push(status.result as ToolResult)
    }
    if (results.length === calls.length) return { kind: 'results', calls, results, dropped: 0 }
    return {
      kind: 'refused',
      code: 'INTERNAL_RELATION',
      coreCode: handled.code,
      message: handled.message,
      calls,
    }
  })
}

/** The one observation a dispatch leaves: one entry per step, a read batch included. */
export function observeDispatch(input: {
  phase: Phase | null
  calls: PendingCall[]
  results: ToolResult[]
  cwd: string
  confidence: number | null
  escalated: boolean
}): Observation {
  const { calls, results, ...common } = input
  if (calls.length > 1) {
    if (!calls.every((call) => call.name === 'read'))
      throw new Error('Jev loop dispatch batches only read calls')
    return classifyReadBatch({
      ...common,
      calls: calls.map((call) => ({ name: call.name, args: call.args })),
      results,
    })
  }
  const call = calls[0]
  const result = results[0]
  if (call === undefined || result === undefined)
    throw new Error('Jev loop dispatch has no result to observe')
  return classifyResult({ ...common, name: call.name, args: call.args, result })
}
