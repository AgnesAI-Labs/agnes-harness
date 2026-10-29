import type { GenericLoopPorts, LoopToolCallOptions, ToolResult } from '@agnes/extension-api'
import { normalizeView } from './observations.js'
import { classifyReadBatch, classifyResult, normalizePath, resultText, targetOf } from './profile.js'
import { extractReferences, SEARCH_TOOLS } from './references.js'
import type {
  JsonObject,
  Observation,
  ObservationView,
  PendingCall,
  Phase,
  ReferenceSource,
  ViewReference,
} from './types.js'
import { clip, errorCode } from './util.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

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

const SEARCH = new Set<string>(SEARCH_TOOLS)
const TARGETED = new Set(['read', 'write', 'edit'])

/** What a view is about: the searched path, the file acted on (a batch lists them all), else the root. */
function scopeOf(calls: PendingCall[], cwd: string): string {
  const first = calls[0]
  if (first === undefined) return '.'
  if (SEARCH.has(first.name)) {
    const path = isRecord(first.args) ? first.args.path : undefined
    return normalizePath(path ?? '.', cwd) ?? '.'
  }
  if (!TARGETED.has(first.name)) return '.'
  const targets = calls.flatMap((call) => {
    const target = targetOf(call.name, call.args, cwd)
    return target === null ? [] : [target]
  })
  return targets.length === 0 ? '.' : targets.join(', ')
}

/**
 * The one view a dispatch leaves: the first call names it, the results' text is its evidence, and
 * the references come from every call's result (a read batch yields each file that was read).
 * Takes one call or a read batch (observeDispatch rejects a mixed batch first); `refs.count` is
 * the number extracted, before the view's caps.
 */
export function viewForDispatch(input: { calls: PendingCall[]; results: ToolResult[]; cwd: string }): {
  view: ObservationView
  refs: { source: ReferenceSource; count: number }
} {
  const { calls, results, cwd } = input
  const first = calls[0]
  if (first === undefined) throw new Error('Jev loop dispatch has no call to view')
  const references: ViewReference[] = []
  let source: ReferenceSource = 'none'
  let truncated = false
  calls.forEach((call, index) => {
    const result = results[index]
    if (result === undefined) return
    const found = extractReferences({ name: call.name, args: call.args, result, cwd })
    if (source === 'none') source = found.source
    references.push(...found.references)
    truncated ||= found.truncated
  })
  const view = normalizeView({
    operation: first.name,
    callId: first.invocationId,
    scope: scopeOf(calls, cwd),
    evidence: results.map(resultText).join('\n'),
    references,
    truncated,
    ...(calls.length === 1 && isRecord(first.args) ? { invocation: first.args as JsonObject } : {}),
  })
  return { view, refs: { source, count: references.length } }
}

/** The one observation a dispatch leaves: one entry per step, a read batch included, and its view. */
export function observeDispatch(input: {
  phase: Phase | null
  calls: PendingCall[]
  results: ToolResult[]
  cwd: string
  confidence: number | null
  escalated: boolean
  /** Whether the tool is read-only; reaches `classifyResult` for a tool without a profile. */
  readOnly?: boolean
}): Observation {
  const { calls, results, ...common } = input
  let observed: Observation
  if (calls.length > 1) {
    if (!calls.every((call) => call.name === 'read'))
      throw new Error('Jev loop dispatch batches only read calls')
    observed = classifyReadBatch({
      ...common,
      calls: calls.map((call) => ({ name: call.name, args: call.args })),
      results,
    })
  } else {
    const call = calls[0]
    const result = results[0]
    if (call === undefined || result === undefined)
      throw new Error('Jev loop dispatch has no result to observe')
    observed = classifyResult({ ...common, name: call.name, args: call.args, result })
  }
  return Object.assign(observed, viewForDispatch({ calls, results, cwd: input.cwd }))
}
