import { isEventType, normalize, type SessionStart } from '@agnes/protocol'
import { isRegisterTombstone, registerKey } from '../log/storage.js'
import { CoreError, type Event, type Seq } from '../types.js'
import { ChunkedMap } from './chunked-map.js'
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
} from './shapes.js'
import { initialState, type LedgerState, type RegisterCell } from './state.js'

type Tables =
  | 'openTurn'
  | 'openStep'
  | 'lastTurn'
  | 'lastStep'
  | 'pendingEffects'
  | 'pendingApprovals'
  | 'taint'
type Registers = LedgerState['registers']
type Writable<T> = T extends ReadonlyMap<infer K, infer V> ? Map<K, V> : never

/**
 * The next state, sharing every table with `prev` until the row writes to it. `reduce` promises a new
 * state and an untouched input: a caller holding a state from `upto` must not see it change under a
 * later fold, and the relation check simulates a batch on top of live state. So a table is copied the
 * first time this row writes it, and a table the row does not write is shared, never changed.
 */
function successor(prev: LedgerState) {
  const s: LedgerState = { ...prev, registers: { ...prev.registers } }
  const copied = new Set<string>()
  const table = <K extends Tables>(name: K): Writable<LedgerState[K]> => {
    if (!copied.has(name)) {
      copied.add(name)
      ;(s as Record<K, unknown>)[name] = new Map(prev[name] as ReadonlyMap<unknown, unknown>)
    }
    return s[name] as Writable<LedgerState[K]>
  }
  const register = <K extends keyof Registers>(name: K): Writable<Registers[K]> => {
    const key = `registers.${name}`
    if (!copied.has(key)) {
      copied.add(key)
      ;(s.registers as Record<K, unknown>)[name] = new Map(
        prev.registers[name] as ReadonlyMap<unknown, unknown>,
      )
    }
    return s.registers[name] as Writable<Registers[K]>
  }
  const resumed = (): Set<string> => {
    if (!copied.has('resumedRequests')) {
      copied.add('resumedRequests')
      s.resumedRequests = new Set(prev.resumedRequests)
    }
    return s.resumedRequests as Set<string>
  }
  /**
   * Starts a table over for this row and marks it copied, so a later write in the same row lands in
   * the empty table instead of copying the old contents back in.
   */
  const reset = (name: Tables | `registers.${keyof Registers}` | 'resumedRequests'): void => {
    copied.add(name)
    if (name === 'resumedRequests') s.resumedRequests = new Set()
    else if (name.startsWith('registers.'))
      (s.registers as Record<string, unknown>)[name.slice('registers.'.length)] = new Map()
    else (s as Record<string, unknown>)[name] = new Map()
  }
  /** Removes `key` from a table, copying the table only when the key is there to remove. */
  const remove = <K extends Tables>(name: K, key: string): void => {
    if (s[name].has(key)) table(name).delete(key)
  }
  return { s, table, register, resumed, remove, reset }
}

/**
 * The five registers the fold materializes, whose payload nothing else checks. (The program counter
 * is not among them: it is a register cell written beside the rows, never folded from them.) These
 * reach the fold as an unchecked payload that is then presented under a precise type. The cast below cannot be made sound here — that is a schema's
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
  current: ReadonlyMap<string, RegisterCell<T>>,
  writable: () => Map<string, RegisterCell<T>>,
  register: string,
  key: string,
  seq: Seq,
  data: unknown,
): void {
  if (isRegisterTombstone(register, data)) {
    if (current.has(key)) writable().delete(key)
    return
  }
  if (OBJECT_REGISTERS.has(register) && (typeof data !== 'object' || Array.isArray(data)))
    throw new CoreError('E_ENVELOPE', `${register} data must be an object`, { register, key, seq })
  writable().set(key, { seq, value: data as T })
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
  const { s, table, register, resumed, remove, reset } = successor(prev)
  s.lastSeq = e.seq
  const lane = e.lane ?? 'main'
  const d = e.data as Record<string, unknown> | null
  if (e.register) {
    const key = registerKey(e)
    const reg = e.register
    switch (reg) {
      case 'plan.items':
        setRegister<PlanItems>(s.registers.planItems, () => register('planItems'), reg, key, e.seq, d)
        break
      case 'budget.state':
        setRegister<BudgetState>(s.registers.budgetState, () => register('budgetState'), reg, key, e.seq, d)
        break
      case 'artifact/job':
        setRegister<ArtifactJob>(s.registers.artifactJobs, () => register('artifactJobs'), reg, key, e.seq, d)
        break
      case 'inbox':
        setRegister<Inbox>(s.registers.inbox, () => register('inbox'), reg, key, e.seq, d)
        break
      case 'harness/entry':
        setRegister<HarnessEntry>(
          s.registers.harnessEntries,
          () => register('harnessEntries'),
          reg,
          key,
          e.seq,
          d,
        )
        break
    }
  }
  switch (e.type) {
    case 'session/start': {
      const start = d as unknown as SessionStart
      if (start.parent) {
        // A fork starts these over; lastTurn, planItems, artifactJobs, harnessEntries and the last
        // ledger tokens carry across from the parent.
        reset('registers.budgetState')
        reset('registers.inbox')
        reset('openTurn')
        reset('openStep')
        reset('lastStep')
        reset('pendingEffects')
        reset('pendingApprovals')
        reset('resumedRequests')
        reset('taint')
        s.decisions = ChunkedMap.empty()
        s.toolCalls = ChunkedMap.empty()
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
        resumed().add(requestId as string)
      }
      table('openTurn').set(lane, { turn: Number(d?.turn), startSeq: e.seq, trigger: String(d?.trigger) })
      table('lastTurn').set(lane, Number(d?.turn))
      table('taint').set(lane, false)
      break
    }
    case 'turn/end':
      remove('openTurn', lane)
      remove('openStep', lane)
      remove('lastStep', lane)
      break
    case 'step/start':
      table('openStep').set(lane, { turn: Number(d?.turn), step: Number(d?.step), startSeq: e.seq })
      table('lastStep').set(lane, Number(d?.step))
      break
    case 'step/end':
      remove('openStep', lane)
      break
    case 'request/header': {
      const turn = s.openTurn.get(lane)
      if (turn) table('openTurn').set(lane, { ...turn, lastHeaderSeq: e.seq })
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
      table('pendingEffects').set(pending.effectId, { ...pending, receiptSeq: e.seq })
      break
    }
    case 'assistant/output': {
      const effectId = typeof d?.effectId === 'string' ? d.effectId : undefined
      const pending = effectId === undefined ? undefined : s.pendingEffects.get(effectId)
      if (pending?.kind !== 'inference' || pending.lane !== lane) break
      const first = pending.firstOutputSeq === undefined
      const cut = d?.state === 'interrupted' && pending.interruptedSeq === undefined
      if (first || cut)
        table('pendingEffects').set(pending.effectId, {
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
      if (pending) table('pendingEffects').set(pending.effectId, { ...pending, firstOutputSeq: e.seq })
      break
    }
    case 'effect/intent': {
      const effectId = lifecycleId(d, 'effectId', e.type, e.seq)
      const i = d as unknown as EffectIntent
      table('pendingEffects').set(effectId, {
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
      remove('pendingEffects', lifecycleId(d, 'effectId', e.type, e.seq))
      break
    case 'approval/asked': {
      const requestId = lifecycleId(d, 'requestId', e.type, e.seq)
      const a = d as unknown as ApprovalAsked
      table('pendingApprovals').set(requestId, { ...a, requestId, seq: e.seq, lane })
      break
    }
    case 'approval/decided': {
      const requestId = lifecycleId(d, 'requestId', e.type, e.seq)
      const a = d as unknown as ApprovalDecided
      const askedSeq = s.pendingApprovals.get(requestId)?.seq
      remove('pendingApprovals', requestId)
      s.decisions = s.decisions.set(requestId, {
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
      s.toolCalls = s.toolCalls.set(String(d?.toolUseId), {
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
    table('taint').set(lane, true)
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

export { initialState }
