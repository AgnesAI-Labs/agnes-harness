// The ledger reducer as it stood before the fold stopped copying every table on every row, kept
// verbatim as the reference the equivalence tests compare the product reducer against. Do not change
// it along with the product code; change it only when the ledger format itself changes, so it keeps
// describing the fold the product must still produce.
import { isEventType, normalize, type OpState, type SessionStart } from '@agnes/protocol'
import { isRegisterTombstone, registerKey } from '../../src/log/storage.js'
import type {
  ApprovalAsked,
  ApprovalDecided,
  ArtifactJob,
  BudgetState,
  CostLedger,
  EffectIntent,
  HarnessEntry,
  Inbox,
  PlanItems,
} from '../../src/reduce/shapes.js'
import type { EffectNode, RegisterCell } from '../../src/reduce/state.js'
import { CoreError, type Event, type Seq } from '../../src/types.js'

/** The ledger state as the reference folds it: every table a plain, writable Map or Set. */
export type LedgerState = {
  lastSeq: Seq
  session: SessionStart | null
  registers: {
    opState: Map<string, RegisterCell<OpState>>
    planItems: Map<string, RegisterCell<PlanItems>>
    budgetState: Map<string, RegisterCell<BudgetState>>
    artifactJobs: Map<string, RegisterCell<ArtifactJob>>
    inbox: Map<string, RegisterCell<Inbox>>
    harnessEntries: Map<string, RegisterCell<HarnessEntry>>
  }
  openTurn: Map<string, { turn: number; startSeq: Seq; trigger: string; lastHeaderSeq?: Seq }>
  openStep: Map<string, { turn: number; step: number; startSeq: Seq }>
  // The last turn number seen on the lane, and the last step number opened inside the current turn.
  // Both outlive the open* maps on purpose: the step machine numbers the next turn from lastTurn,
  // and the relation check numbers the next step from lastStep, which openStep can no longer answer
  // once step/end has closed it — reading openStep there numbers every second step back to 1.
  lastTurn: Map<string, number>
  lastStep: Map<string, number>
  pendingEffects: Map<string, Omit<EffectNode, 'children'>>
  pendingApprovals: Map<string, ApprovalAsked & { seq: Seq; lane: string }>
  decisions: Map<string, ApprovalDecided & { seq: Seq; lane: string; askedSeq?: Seq }>
  resumedRequests: Set<string>
  taint: Map<string, boolean>
  toolCalls: Map<string, { seq: Seq; name: string; turn: number; step: number; lane: string }>
  creditsUsed: number
  // The most recent non-interrupted `cost/ledger` entry's token total, with the seq it landed at,
  // and that same entry's cache-read/input breakdown. `contextTokens` starts counting surface nodes
  // after this seq instead of from the top of the ledger, so a long session's preflight cost stays
  // bounded by what changed since the last request; `cacheRead`/`input` are what the compaction
  // trigger's hysteresis reads to tell whether the cache it is about to discard is currently warm.
  lastLedgerTokens: { seq: Seq; total: number; cacheRead: number; input: number } | null
}

/**
 * Copies the collections a fold writes to. `reduce` promises a new state and an untouched input, so
 * every Map is rebuilt rather than aliased: a caller holding a state from `upto` must not see it
 * change under a later fold, and the relation check simulates a batch on top of live state.
 */
function cloneMaps(s: LedgerState): LedgerState {
  return {
    ...s,
    registers: {
      opState: new Map(s.registers.opState),
      planItems: new Map(s.registers.planItems),
      budgetState: new Map(s.registers.budgetState),
      artifactJobs: new Map(s.registers.artifactJobs),
      inbox: new Map(s.registers.inbox),
      harnessEntries: new Map(s.registers.harnessEntries),
    },
    openTurn: new Map(s.openTurn),
    openStep: new Map(s.openStep),
    lastTurn: new Map(s.lastTurn),
    lastStep: new Map(s.lastStep),
    pendingEffects: new Map(s.pendingEffects),
    pendingApprovals: new Map(s.pendingApprovals),
    decisions: new Map(s.decisions),
    resumedRequests: new Set(s.resumedRequests),
    taint: new Map(s.taint),
    toolCalls: new Map(s.toolCalls),
  }
}

/**
 * The five registers whose payload nothing else checks. `op.state` is left out because its data has
 * a schema and is validated on the way in; these five reach the fold as an unchecked payload that is
 * then presented under a precise type. The cast below cannot be made sound here — that is a schema's
 * job, and until these five have one, a cell can still read back as a shape it does not have: an
 * `inbox` of `{}` whose `.items` is undefined, a `harness/entry` whose `version` is a string. What
 * is refused here is only the cheap half, a payload that is not even an object, which turns a
 * scalar, a string or an array into a rejection carrying the register, the key and the seq.
 */
const OBJECT_REGISTERS = new Set(['plan.items', 'budget.state', 'artifact/job', 'inbox', 'harness/entry'])

/**
 * Reads the id a lifecycle row is keyed by. These four rows open or close an entry in a map that
 * only the matching row can clear, so a payload that does not name one is refused rather than
 * folded: an intent keyed under `undefined` is a pending effect no `effect/settled` can ever reach,
 * and an ask keyed the same way is an approval that stays pending for the life of the session.
 */
function lifecycleId(data: unknown, field: string, type: string, seq: Seq): string {
  const v = (data as Record<string, unknown> | null)?.[field]
  if (typeof v !== 'string' || v.length === 0)
    throw new CoreError('E_ENVELOPE', `${type} data.${field} must be a non-empty string`, {
      type,
      field,
      seq,
    })
  return v
}

function setRegister<T>(
  map: Map<string, RegisterCell<T>>,
  register: string,
  key: string,
  seq: Seq,
  data: unknown,
): void {
  if (isRegisterTombstone(register, data)) {
    map.delete(key)
    return
  }
  if (OBJECT_REGISTERS.has(register) && (typeof data !== 'object' || Array.isArray(data)))
    throw new CoreError('E_ENVELOPE', `${register} data must be an object`, { register, key, seq })
  map.set(key, { seq, value: data as T })
}

/**
 * The one place ledger state is computed. Pure: the input state is never touched and a fresh one is
 * returned. Rows are normalized to the current shape first, so a fold reads one vocabulary no matter
 * which version wrote the row. An unknown type without `ignorable` stops the rebuild rather than
 * being skipped — a state folded past a row nobody understands is not the session's state.
 */
export function reduce(prev: LedgerState, raw: Event): LedgerState {
  const known = isEventType(raw.type)
  if (!known && raw.ignorable !== true) throw new CoreError('E_UNKNOWN_EVENT', raw.type, { seq: raw.seq })
  // An ignorable row of an unknown type has no migration path to walk, so it skips normalize, which
  // would reject it on the same unknown type.
  const e = known ? normalize(raw) : raw
  const s = cloneMaps(prev)
  s.lastSeq = e.seq
  const lane = e.lane ?? 'main'
  const d = e.data as Record<string, unknown> | null
  if (e.register) {
    const key = registerKey(e)
    const reg = e.register
    switch (reg) {
      case 'op.state':
        setRegister<OpState>(s.registers.opState, reg, key, e.seq, d)
        break
      case 'plan.items':
        setRegister<PlanItems>(s.registers.planItems, reg, key, e.seq, d)
        break
      case 'budget.state':
        setRegister<BudgetState>(s.registers.budgetState, reg, key, e.seq, d)
        break
      case 'artifact/job':
        setRegister<ArtifactJob>(s.registers.artifactJobs, reg, key, e.seq, d)
        break
      case 'inbox':
        setRegister<Inbox>(s.registers.inbox, reg, key, e.seq, d)
        break
      case 'harness/entry':
        setRegister<HarnessEntry>(s.registers.harnessEntries, reg, key, e.seq, d)
        break
    }
  }
  switch (e.type) {
    case 'session/start': {
      const start = d as unknown as SessionStart
      if (start.parent) {
        s.registers.opState.clear()
        s.registers.budgetState.clear()
        s.registers.inbox.clear()
        s.openTurn.clear()
        s.openStep.clear()
        s.lastStep.clear()
        s.pendingEffects.clear()
        s.pendingApprovals.clear()
        s.decisions.clear()
        s.resumedRequests.clear()
        s.taint.clear()
        s.toolCalls.clear()
        s.creditsUsed = 0
      }
      s.session = start
      break
    }
    case 'turn/start': {
      // A rebuild that meets a second turn/start on an open lane stops: the append path rejects that
      // batch before it is written, so a ledger holding one is not a history this reducer can fold.
      if (s.openTurn.has(lane)) throw new CoreError('E_RELATION', 'turn already open', { seq: e.seq, lane })
      const requestId = (d?.continues as { requestId?: unknown } | undefined)?.requestId
      if (requestId !== undefined) {
        const decision = typeof requestId === 'string' ? s.decisions.get(requestId) : undefined
        if (
          d?.trigger !== 'approval-resume' ||
          !decision ||
          decision.via === 'sync' ||
          decision.lane !== lane
        )
          throw new CoreError('E_RELATION', 'continuation requires a decision on this lane', {
            seq: e.seq,
            lane,
          })
        if (s.resumedRequests.has(requestId as string))
          throw new CoreError('E_RELATION', 'approval decision already consumed', { seq: e.seq, lane })
        s.resumedRequests.add(requestId as string)
      }
      s.openTurn.set(lane, { turn: Number(d?.turn), startSeq: e.seq, trigger: String(d?.trigger) })
      s.lastTurn.set(lane, Number(d?.turn))
      s.taint.set(lane, false)
      break
    }
    case 'turn/end':
      s.openTurn.delete(lane)
      s.openStep.delete(lane)
      s.lastStep.delete(lane)
      break
    case 'step/start':
      s.openStep.set(lane, { turn: Number(d?.turn), step: Number(d?.step), startSeq: e.seq })
      s.lastStep.set(lane, Number(d?.step))
      break
    case 'step/end':
      s.openStep.delete(lane)
      break
    case 'request/header': {
      const turn = s.openTurn.get(lane)
      if (turn) s.openTurn.set(lane, { ...turn, lastHeaderSeq: e.seq })
      break
    }
    case 'request/sent': {
      const sources = e.sourceEventSeqs ?? []
      const [headerSeq, intentSeq] = sources
      const turn = s.openTurn.get(lane)
      const invalidBinding =
        sources.length !== 2 ||
        headerSeq === undefined ||
        intentSeq === undefined ||
        !(headerSeq < intentSeq && intentSeq < e.seq) ||
        turn?.lastHeaderSeq !== headerSeq ||
        !s.openStep.has(lane)
      if (invalidBinding) break
      const pending = [...s.pendingEffects.values()].find(
        (effect) => effect.intentSeq === intentSeq && effect.kind === 'inference' && effect.lane === lane,
      )
      if (!pending || pending.receiptSeq !== undefined) break
      s.pendingEffects.set(pending.effectId, { ...pending, receiptSeq: e.seq })
      break
    }
    case 'assistant/output': {
      const effectId = typeof d?.effectId === 'string' ? d.effectId : undefined
      const pending = effectId === undefined ? undefined : s.pendingEffects.get(effectId)
      if (pending?.kind !== 'inference' || pending.lane !== lane) break
      const first = pending.firstOutputSeq === undefined
      const cut = d?.state === 'interrupted' && pending.interruptedSeq === undefined
      if (first || cut)
        s.pendingEffects.set(pending.effectId, {
          ...pending,
          ...(first ? { firstOutputSeq: e.seq } : {}),
          ...(cut ? { interruptedSeq: e.seq } : {}),
        })
      break
    }
    case 'assistant/message': {
      const pending = [...s.pendingEffects.values()].find(
        (effect) =>
          effect.kind === 'inference' && effect.lane === lane && effect.firstOutputSeq === undefined,
      )
      if (pending) s.pendingEffects.set(pending.effectId, { ...pending, firstOutputSeq: e.seq })
      break
    }
    case 'effect/intent': {
      const effectId = lifecycleId(d, 'effectId', e.type, e.seq)
      const i = d as unknown as EffectIntent
      s.pendingEffects.set(effectId, {
        effectId,
        lane,
        ...(i.parentEffectId === undefined ? {} : { parentEffectId: i.parentEffectId }),
        kind: i.kind,
        ...(i.tool === undefined ? {} : { tool: i.tool }),
        replay: i.replay,
        intentSeq: e.seq,
        ...(i.argsSeq === undefined ? {} : { argsSeq: i.argsSeq }),
        ...(i.slot === undefined ? {} : { slot: i.slot }),
      })
      break
    }
    case 'effect/settled':
      s.pendingEffects.delete(lifecycleId(d, 'effectId', e.type, e.seq))
      break
    case 'approval/asked': {
      const requestId = lifecycleId(d, 'requestId', e.type, e.seq)
      const a = d as unknown as ApprovalAsked
      s.pendingApprovals.set(requestId, { ...a, requestId, seq: e.seq, lane })
      break
    }
    case 'approval/decided': {
      const requestId = lifecycleId(d, 'requestId', e.type, e.seq)
      const a = d as unknown as ApprovalDecided
      const askedSeq = s.pendingApprovals.get(requestId)?.seq
      s.pendingApprovals.delete(requestId)
      s.decisions.set(requestId, {
        ...a,
        requestId,
        seq: e.seq,
        lane,
        ...(askedSeq === undefined ? {} : { askedSeq }),
      })
      break
    }
    case 'tool/call': {
      const step = s.openStep.get(lane)
      const turn = s.openTurn.get(lane)
      s.toolCalls.set(String(d?.toolUseId), {
        seq: e.seq,
        name: String(d?.name),
        turn: turn?.turn ?? 0,
        step: step?.step ?? 0,
        lane,
      })
      break
    }
    case 'cost/ledger': {
      const c = d as unknown as CostLedger
      const inherited = s.session?.parent !== undefined && e.seq <= s.session.parent.boundarySeq
      if (!inherited) {
        if (!c.adjustment || !s.session?.parent || c.adjustment.of > s.session.parent.boundarySeq)
          s.creditsUsed += c.adjustment?.delta ?? c.credits ?? 0
      }
      if (
        c.purpose !== 'title' &&
        c.purpose !== 'approval-guardian' &&
        c.purpose !== 'media' &&
        !c.interrupted &&
        !c.adjustment
      )
        s.lastLedgerTokens = {
          seq: e.seq,
          total: c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheWrite,
          cacheRead: c.tokens.cacheRead,
          input: c.tokens.input,
        }
      break
    }
    case 'subagent/cost':
      break
  }
  // Taint is a property of the turn in progress, so a row arriving outside one taints nothing, and
  // turn/start above clears it for the turn it opens.
  if (
    (e.type === 'user/message' || e.type === 'tool/result') &&
    e.trust === 'untrusted' &&
    s.openTurn.has(lane)
  )
    s.taint.set(lane, true)
  return s
}

export function foldEvents(events: Iterable<Event>, upto?: Seq): LedgerState {
  let s = initialState()
  for (const e of events) {
    if (upto !== undefined && e.seq > upto) break
    s = reduce(s, e)
  }
  return s
}

/** The empty state the reference folds from: plain Maps and Sets throughout. */
export function initialState(): LedgerState {
  return {
    lastSeq: 0,
    session: null,
    registers: {
      opState: new Map(),
      planItems: new Map(),
      budgetState: new Map(),
      artifactJobs: new Map(),
      inbox: new Map(),
      harnessEntries: new Map(),
    },
    openTurn: new Map(),
    openStep: new Map(),
    lastTurn: new Map(),
    lastStep: new Map(),
    pendingEffects: new Map(),
    pendingApprovals: new Map(),
    decisions: new Map(),
    resumedRequests: new Set(),
    taint: new Map(),
    toolCalls: new Map(),
    creditsUsed: 0,
    lastLedgerTokens: null,
  }
}
