import type { ToolResult } from '@agnes/extension-api'
import { type JsonValue, type ThinkingLevel, validateAgainst } from '@agnes/protocol'
import { type NestedToolLease, NestedToolSchedulingError } from '../effects/scheduler.js'
import { resolveValidatedToolCallPolicy } from '../registry/tool-policy.js'
import { assertThinking } from '../request/derive.js'
import { CoreError, type EventInput, type Seq } from '../types.js'
import { withPhase } from './op-state.js'
import type { PresetView } from './preset.js'
import type {
  CoreReplacementInputMap,
  CoreReplacementOutputMap,
  OpContext,
  Operation,
  ReplacementContext,
  ReplacementOperation,
  SessionImpl,
  SlotOperation,
} from './session.js'
import { approveAndExecute, refuse } from './tools.js'

/** The six names a `{ replace: name }` Operation may stand in for. Closed, not a bare string. */
export const CORE_OPS = ['Inbox', 'Budget', 'Inference', 'Approval', 'ToolExecution', 'StopGate'] as const
export type CoreOpName = (typeof CORE_OPS)[number]

/**
 * A tool invoking another tool mid-execution (`ctx.tools.invoke`, depth > 0). `ToolContext`'s own
 * wrapper (`tool-context.ts`) already refuses a depth past the limit before this is ever reached, so
 * the check here is a second line of defense for a caller that reaches this function directly.
 *
 * A nested call mints its own `tool/call` and runs through the same `approveAndExecute` the batch
 * path uses, so it gets its own `effect/intent` (carrying `parentEffectId`) and its own
 * `tool/result` — a resume walking `pendingEffects()` sees the child as a root of its own tree, not
 * as part of the parent's.
 */
export async function invokeTool(
  s: SessionImpl,
  name: string,
  args: unknown,
  o: {
    signal?: AbortSignal
    depth: number
    parentEffectId?: string
    nestedLease?: NestedToolLease
    onPark?: (event: EventInput) => void
  },
): Promise<ToolResult> {
  if (o.depth > s.preset.depthLimit)
    throw new CoreError('E_DEPTH_EXCEEDED', `depth ${o.depth} exceeds ${s.preset.depthLimit}`)
  const op = s.op()
  const t = s.turn
  if (!op || !t || op.phase.kind !== 'tools')
    throw new CoreError('E_RELATION', 'tools.invoke outside the tools phase')
  const cap = s.turnBudgetCap()
  if (cap !== null && s.state.creditsUsed > cap)
    throw Object.assign(new Error('BUDGET_EXCEEDED'), { code: 'BUDGET_EXCEEDED' })
  if (name === 'computer_use' && !s.computerUseAllowed())
    throw Object.assign(new Error('tool was not disclosed for the current primary model'), {
      code: 'TOOL_NOT_DISCLOSED',
    })
  const ordinal = t.ordinal++
  const toolUseId = s.d.ids.toolUseId(ordinal)
  const def = t.snapshot.byName.get(name)
  if (!def) throw Object.assign(new Error(`unknown tool ${name}`), { code: 'TOOL_NOT_FOUND' })
  let valid = false
  try {
    valid = validateAgainst(def.parameters, args).ok
  } catch {
    // A malformed schema is a refusal, never permission to invoke the classifier.
  }
  if (!valid)
    throw Object.assign(new Error('tool arguments do not match the registered schema'), {
      code: 'TOOL_ARGS_INVALID',
    })
  const policy = resolveValidatedToolCallPolicy(def, args as JsonValue)
  const seqs = await s.transition(
    [
      s.ev(
        'tool/call',
        {
          toolUseId,
          name,
          args,
          ordinal,
          depth: o.depth,
          ...(o.parentEffectId ? { parentEffectId: o.parentEffectId } : {}),
          ...policy,
        },
        { origin: 'model' },
      ),
    ],
    (cur, argsSeq) => {
      if (cur?.phase.kind !== 'tools')
        throw new CoreError('E_RELATION', 'nested tool call lost its tools phase')
      return withPhase(cur, {
        ...cur.phase,
        batch: {
          ...cur.phase.batch,
          calls: [
            ...cur.phase.batch.calls,
            {
              toolUseId,
              name,
              ordinal,
              argsSeq,
              status: 'planned',
              replay: policy.resolvedPolicy.replay,
              depth: o.depth,
              ...(o.parentEffectId ? { parentEffectId: o.parentEffectId } : {}),
              ...policy,
            },
          ],
        },
      })
    },
  )
  const argsSeq = seqs[0]
  if (argsSeq === undefined) throw new CoreError('E_RELATION', 'nested tool call commit returned no sequence')
  let result: ToolResult
  let park: EventInput | undefined
  try {
    const outcome = await s.runNestedTool(
      policy.resolvedPolicy.isConcurrencySafe,
      (nestedLease) =>
        approveAndExecute(
          s,
          { toolUseId, name, args, ordinal, argsSeq, ...policy },
          {
            depth: o.depth,
            nestedLease,
            ...(o.parentEffectId ? { parentEffectId: o.parentEffectId } : {}),
            ...(o.signal ? { signal: o.signal } : {}),
          },
        ),
      o.nestedLease,
      o.signal ?? s.ac.signal,
    )
    result = outcome.result
    park = outcome.park
  } catch (error) {
    if (!(error instanceof NestedToolSchedulingError)) throw error
    const cancelled = error.reason === 'aborted'
    return refuse(
      s,
      toolUseId,
      cancelled ? 'CANCELLED' : 'TOOL_SCHEDULER_REFUSED',
      cancelled ? 'cancelled before nested tool admission' : 'nested tool parent already closed',
    )
  }
  if (park) {
    await s.transition([], (cur) => {
      if (cur?.phase.kind !== 'tools') return cur
      return withPhase(cur, {
        ...cur.phase,
        batch: {
          ...cur.phase.batch,
          calls: cur.phase.batch.calls.map((call) =>
            call.toolUseId === toolUseId ? { ...call, status: 'awaiting_approval' as const } : call,
          ),
        },
      })
    })
    o.onPark?.(park)
    throw Object.assign(new Error('PARKED'), { code: 'PARKED' })
  }
  return result
}

/** Ops in one slot, in the order they run: declared `order` first, then name, for a stable tie-break. */
export function sortedOps(ops: Operation[], slot: 'before-inference' | 'after-core'): SlotOperation[] {
  return ops
    .filter((o): o is SlotOperation => o.slot === slot)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
}

/**
 * Runs every applicable Operation in one slot against one already-built `OpContext`. The context is
 * supplied by the caller rather than built in here: `before-inference`'s caller (`runInference`) has
 * already resolved the model and the disclosed tool list for the request about to be sent, and
 * `after-core`'s caller (`stopGate`) is the only other site that knows which turn is ending — neither
 * fact is this module's to recompute, and duplicating either computation here is how the two answers
 * drift apart.
 *
 * An Operation throwing is not fatal to the slot: it is recorded as `x/core/operation-failed` and the
 * rest of the slot still runs, the same fail-open posture the rest of core takes with extensions.
 */
export async function runSlot(
  s: SessionImpl,
  slot: 'before-inference' | 'after-core',
  ctx: OpContext,
): Promise<void> {
  for (const o of sortedOps(s.d.operations, slot)) {
    try {
      if ((await o.applicable(ctx)) !== 'applied') continue
      const out = await o.run(ctx)
      if (out.effects?.length)
        await s.d.log.append(out.effects.map((e) => ({ ...e, lane: s.lane })) as EventInput[])
    } catch (err) {
      await s.diag('operation-failed', {
        name: o.name,
        slot,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Assembly-time guard for the closed replacement table. Two owners for one core segment are
 * ambiguous and order-dependent, so they are refused instead of letting `find()` pick a winner.
 */
export function validateReplacements(ops: Operation[]): void {
  const seen = new Map<CoreOpName, string>()
  for (const o of ops) {
    if (typeof o.slot !== 'object') continue
    if (!(CORE_OPS as readonly string[]).includes(o.slot.replace))
      throw new CoreError('E_REGISTRY_DUPLICATE', `unknown core op ${o.slot.replace}`)
    const name = o.slot.replace as CoreOpName
    if (typeof (o as Partial<ReplacementOperation>).replace !== 'function')
      throw new CoreError('E_ENVELOPE', `core op ${name} has no typed replace handler`)
    const prior = seen.get(name)
    if (prior) throw new CoreError('E_REGISTRY_DUPLICATE', `duplicate core op ${name}: ${prior}, ${o.name}`)
    seen.set(name, o.name)
  }
}

/** The Operation, if any, that stands in for one of core's own named segments. */
export function replacementFor<K extends CoreOpName>(
  ops: Operation[],
  name: K,
): ReplacementOperation<K> | undefined {
  return ops.find((o) => typeof o.slot === 'object' && o.slot.replace === name) as
    | ReplacementOperation<K>
    | undefined
}

/**
 * Dispatches one named core segment. Replacement failures are diagnostic but fail closed: unlike
 * additive slots, the built-in did not run, so swallowing the exception would report work that
 * never happened as success. `next()` is single-use and a delegating replacer must return the exact
 * value it received; this prevents a wrapper from committing a built-in transition and then
 * claiming a contradictory result.
 */
export async function runCoreReplacement<K extends CoreOpName>(
  s: SessionImpl,
  segment: K,
  ctx: OpContext,
  input: CoreReplacementInputMap[K],
  builtin: () => Promise<CoreReplacementOutputMap[K]>,
): Promise<CoreReplacementOutputMap[K]> {
  const replacement = s.d.segments?.[segment] as ReplacementOperation<K> | undefined
  if (!replacement) return builtin()

  try {
    if ((await replacement.applicable(ctx)) !== 'applied') return builtin()
    let delegated = false
    let delegatedValue: CoreReplacementOutputMap[K] | undefined
    const next = async (): Promise<CoreReplacementOutputMap[K]> => {
      if (delegated) throw new CoreError('E_RELATION', `replacement ${replacement.name} called next twice`)
      delegated = true
      delegatedValue = await builtin()
      return delegatedValue
    }
    const value = await replacement.replace({ ...ctx, segment, input, next } as ReplacementContext<K>)
    if (delegated && !Object.is(value, delegatedValue))
      throw new CoreError(
        'E_RELATION',
        `replacement ${replacement.name} changed ${segment} result after delegating`,
      )
    if (!validReplacementOutput(segment, value))
      throw new CoreError('E_ENVELOPE', `replacement ${replacement.name} returned invalid ${segment} output`)
    return value
  } catch (error) {
    await s.diag('operation-failed', {
      name: replacement.name,
      slot: { replace: segment },
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function validReplacementOutput<K extends CoreOpName>(
  segment: K,
  value: unknown,
): value is CoreReplacementOutputMap[K] {
  if (segment === 'Inference')
    return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === 'function'
  if (segment === 'Approval') {
    if (
      value === 'allowed-once' ||
      value === 'allowed-session' ||
      value === 'allowed-permanent' ||
      value === 'rejected' ||
      value === 'cancelled' ||
      value === 'unavailable'
    )
      return true
    const pending = value as { ticket?: unknown; expiresAt?: unknown } | null
    return typeof pending?.ticket === 'string' && typeof pending.expiresAt === 'string'
  }
  if (segment === 'ToolExecution') {
    const result = value as { content?: unknown } | null
    return Array.isArray(result?.content)
  }
  const decision = value as {
    action?: unknown
    itemId?: unknown
    note?: unknown
    reason?: unknown
    outcome?: unknown
  } | null
  if (segment === 'Inbox')
    return (
      decision?.action === 'none' ||
      (decision?.action === 'claim' && typeof decision.itemId === 'string' && decision.itemId.length > 0)
    )
  if (segment === 'Budget')
    return (
      decision?.action === 'allow' ||
      decision?.action === 'delegated' ||
      (decision?.action === 'end' &&
        (decision.reason === 'budget' || decision.reason === 'max_steps' || decision.reason === 'blocked') &&
        validDecisionEffects(value))
    )
  return (
    (decision?.action === 'continue' &&
      typeof decision.note === 'string' &&
      decision.note.length > 0 &&
      validDecisionEffects(value)) ||
    decision?.action === 'delegated' ||
    (decision?.action === 'end' &&
      (decision.reason === 'completed' || decision.reason === 'blocked') &&
      validDecisionEffects(value))
  )
}

function validDecisionEffects(value: unknown): boolean {
  const effects = (value as { effects?: unknown } | null)?.effects
  return (
    effects === undefined ||
    (Array.isArray(effects) &&
      effects.every((event) => {
        const e = event as Partial<EventInput> | null
        return (
          typeof e?.type === 'string' &&
          e.type.startsWith('x/') &&
          e.register === undefined &&
          e.surfaceOp === undefined
        )
      }))
  )
}

/**
 * Replacement decisions may carry audit/extension rows, but never core control rows or effect
 * intents. Core commits the decision and its rows together, so allowing a replacer to manufacture
 * `effect/intent`, `op.state`, or a second `turn/end` here would break recovery ownership.
 */
export function replacementEffects(s: SessionImpl, name: string, effects: EventInput[] = []): EventInput[] {
  return effects.map((event) => {
    if (!event.type.startsWith('x/') || event.register !== undefined || event.surfaceOp !== undefined)
      throw new CoreError(
        'E_ENVELOPE',
        `replacement ${name} effects must be non-register extension audit events`,
      )
    return { ...event, lane: s.lane }
  })
}

/**
 * Replaces the session's active preset view in memory and records the switch as an ignorable audit
 * row — not a new register, and not folded into `op.state`: the switch takes effect immediately for
 * whatever calls `deriveRequest` next, and a process that restarts has to replay this row itself
 * (host's job, not core's — see Task 32a's note on why cross-process recovery is out of scope here).
 *
 * Serialized through `s.locked()`, the same lock `enqueue`/`transition`/`appendExtensionEvent` already
 * share: without it, two concurrent switches (or a switch racing `setModel`) would each read the old
 * `s.preset`, compute their own replacement from that stale snapshot, and whichever assignment lands
 * last would win regardless of which one actually committed first on the ledger.
 */
export async function setPreset(s: SessionImpl, view: PresetView): Promise<Seq> {
  return s.locked(async () => {
    if (s.d.sessionOverlay) await s.d.sessionOverlay.apply(s.key, { preset: view.name })
    const r = await s.d.log.append([
      s.ev('x/core/preset-switch', { from: s.preset.name, to: view.name }, { ignorable: true }),
    ])
    s.preset = view
    s.d.runtime.preset = view
    return r.firstSeq
  })
}

/**
 * Switches one model slot's resolved route/model id in place; `resolveModel` (inference.ts) and
 * `contextWindowFor` (gate.ts) read `s.preset.model` fresh every call, so the next request sees it.
 * Only checks catalogue membership — profile/policy checks (minimal-rl freezes, safety ceilings)
 * are host's layer, expected to validate a `setModel` request before routing it here.
 */
export async function setModel(
  s: SessionImpl,
  sel: { slot: string; route: string; model: string; thinking?: ThinkingLevel },
): Promise<Seq> {
  return s.locked(async () => {
    const modelUnknown = (message: string, x?: Record<string, unknown>) =>
      new CoreError('E_MODEL_UNKNOWN', message, { slot: sel.slot, route: sel.route, model: sel.model, ...x })
    const known = s.d.provider.models().find((m) => m.route === sel.route && m.id === sel.model)
    if (!known) throw modelUnknown(`${sel.route}/${sel.model} is not in the provider's sealed catalogue`)
    if (sel.thinking !== undefined) {
      assertThinking(sel.thinking)
      if (!known.reasoning || (known.thinkingLevelMap && !(sel.thinking in known.thinkingLevelMap)))
        throw modelUnknown(`${sel.route}/${sel.model} does not support thinking level '${sel.thinking}'`, {
          thinking: sel.thinking,
        })
    }
    const priorThinking = s.preset.model.thinking[sel.slot]
    const from = {
      route: s.preset.model.route[sel.slot] ?? 'default',
      model: s.preset.model.id[sel.slot] ?? null,
      ...(priorThinking === undefined ? {} : { thinking: priorThinking }),
    }
    // `to` is a full state snapshot, not a diff: the effective thinking level after this call is
    // whatever was explicitly passed, else whatever the slot already carried — but only if the NEW
    // route/model (`known`) can actually honor that carried-forward level. Without the clamp, a call
    // that omits `thinking` while switching to a model that doesn't support it at all (or doesn't
    // support that specific level) would carry forward a now-incompatible value: on a cross-process
    // reopen, `replaySwitchesOnOpen`'s "latest row per slot" replay re-validates that snapshot against
    // `known` and throws `E_MODEL_UNSUPPORTED` from inside `createSession` itself — bricking the
    // session, since there is no live handle left to issue a corrective `setModel` from. Carrying the
    // validation block above's exact rule forward (`known.reasoning` and, if declared, membership in
    // `known.thinkingLevelMap`) keeps this clamp in lockstep with what a future explicit `thinking`
    // value on this same route/model would be allowed to hold.
    const thinkingCarriesForward =
      priorThinking !== undefined &&
      known.reasoning &&
      (!known.thinkingLevelMap || priorThinking in known.thinkingLevelMap)
    const effectiveThinking = sel.thinking ?? (thinkingCarriesForward ? priorThinking : undefined)
    const to = {
      route: sel.route,
      model: sel.model,
      ...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
    }
    const r = await s.d.log.append([
      s.ev('x/core/model-switch', { slot: sel.slot, from, to }, { ignorable: true }),
    ])
    s.preset = {
      ...s.preset,
      model: {
        ...s.preset.model,
        route: { ...s.preset.model.route, [sel.slot]: sel.route },
        id: { ...s.preset.model.id, [sel.slot]: sel.model },
        // Unconditional, unlike route/id above: this is what actually clears a stale incompatible
        // value out of memory when the new model can't honor it — leaving the key alone on omission
        // (the old conditional-spread pattern) would never clear it, only ever add or overwrite it.
        thinking: { ...s.preset.model.thinking, [sel.slot]: effectiveThinking },
      },
    }
    return r.firstSeq
  })
}
