import { createHash, randomBytes } from 'node:crypto'
import type { GateReport } from './managed-input-gates.js'
import type { ManagedInputRow } from './managed-session-inputs.js'

/**
 * What moved a held input: the startup or slow sweep, an idle report, the caller (`admit`,
 * `inputResult`), the owner (`decide`), an archive, or a revoke, prune or uninstall (`withdraw`).
 */
export type OwnerInputTrigger =
  | 'startup-sweep'
  | 'sweep'
  | 'idle'
  | 'admit'
  | 'inputResult'
  | 'decide'
  | 'archive'
  | 'withdraw'

/**
 * One diagnostic line where an owner input changes or is held: ids, states, gate names, codes and
 * booleans only. Never the input's text, a receipt, a credential or a workspace path.
 */
export interface OwnerInputTrace {
  event: 'transition' | 'held' | 'withdraw'
  /** Short id shared by every line of one pass over a session. */
  pass: string
  trigger: OwnerInputTrigger
  at: string
  sessionId: string
  key?: string
  from?: string
  to?: string
  version?: number
  /** The seq the core inbox gave the submission; 0 while unconfirmed, null when not submitted. */
  submittedSeq?: number | null
  /** What the session's gates said in this pass, before a refusal is folded into `grantRevoked`. */
  gate?: GateReport
  /** A withdrawal from the core inbox: what it found. */
  inbox?: 'withdrawn' | 'taken' | 'absent'
  /** `withdraw`: whether the revoke named one workspace, and how many of the owner's open inputs it matched. */
  scoped?: boolean
  rows?: number
  matched?: number
}

export interface TracePass {
  id: string
  trigger: OwnerInputTrigger
  gate?: GateReport
  inbox?: OwnerInputTrace['inbox']
}

export const formatTrace = (entry: OwnerInputTrace) => `owner-input ${JSON.stringify(entry)}`

/** The audit record kind the daemon writes to `<dataDir>/audit/owner-input.jsonl`. */
export const OWNER_INPUT_TRACE_KIND = 'owner-input.trace'

/** The short correlation id of an input in the audit file: sha256(`<sessionId>\0<key>`), first 12 hex. */
export const inputRef = (sessionId: string, key: string) =>
  createHash('sha256').update(`${sessionId}\0${key}`).digest('hex').slice(0, 12)

const pick = <T extends string>(value: unknown, allowed: ReadonlySet<T>) =>
  typeof value === 'string' && allowed.has(value as T) ? (value as T) : undefined
const word = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined)
const EVENTS = new Set(['transition', 'held', 'withdraw'])
const TRIGGERS = new Set<string>([
  'startup-sweep',
  'sweep',
  'idle',
  'admit',
  'inputResult',
  'decide',
  'archive',
  'withdraw',
])
const VERDICTS = new Set(['pass', 'refused', 'pending'])
const INBOX = new Set(['withdrawn', 'taken', 'absent'])
const STATE = /^[A-Za-z]{1,32}\/[A-Za-z]{1,32}$/
const CODE = /^[A-Za-z0-9_-]{1,64}$/
const LEVEL = /^[a-z-]{1,32}$/
/** Managed session ids are derived digests (`managed-<40 hex>`); the file keeps their first 12 hex, anything else is left out. */
const SESSION = /^managed-[0-9a-f]{40}$/

/**
 * The allowlisted fields of a trace entry, each checked against a fixed vocabulary or a bounded
 * pattern; the session id is shortened and the key replaced by `inputRef`. Anything else, text, a receipt or a credential
 * included, is dropped. Undefined for something that is not a trace entry.
 */
export function ownerInputAuditRecord(value: unknown): Record<string, unknown> | undefined {
  const entry = value as Partial<Record<keyof OwnerInputTrace, unknown>> | null
  const event = pick(entry?.event, EVENTS)
  if (!entry || !event) return undefined
  const out: Record<string, unknown> = { event }
  const set = (name: string, field: unknown) => {
    if (field !== undefined) out[name] = field
  }
  set('pass', word(entry.pass, /^(?:[0-9a-f]{8}|-)$/))
  set('trigger', pick(entry.trigger, TRIGGERS))
  set('at', word(entry.at, /^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/))
  // Short ids only: a full 40-hex session id would be redacted as token-shaped by the audit sink.
  set('session', word(entry.sessionId, SESSION)?.slice('managed-'.length, 'managed-'.length + 12))
  if (typeof entry.key === 'string' && typeof entry.sessionId === 'string')
    set('input', inputRef(entry.sessionId, entry.key))
  set('from', word(entry.from, STATE))
  set('to', word(entry.to, STATE))
  set('version', count(entry.version))
  set('submittedSeq', entry.submittedSeq === null ? null : count(entry.submittedSeq))
  set('inbox', pick(entry.inbox, INBOX))
  if (typeof entry.scoped === 'boolean') set('scoped', entry.scoped)
  set('rows', count(entry.rows))
  set('matched', count(entry.matched))
  const gate = entry.gate as Partial<Record<keyof GateReport, unknown>> | undefined
  const verdict = pick(gate?.verdict, VERDICTS)
  if (gate && verdict) {
    const g: Record<string, unknown> = { verdict }
    for (const name of ['gate', 'code', 'missing'] as const) {
      const field = word(gate[name], CODE)
      if (field !== undefined) g[name] = field
    }
    for (const name of ['l1', 'reopenedAfter'] as const) {
      const field = word(gate[name], LEVEL)
      if (field !== undefined) g[name] = field
    }
    const live = gate.live as Record<string, unknown> | undefined
    if (live)
      g.live = {
        fullAccess: live.fullAccess === true,
        osBoundary: live.osBoundary === true,
        outwardCheckpoint: live.outwardCheckpoint === true,
      }
    out.gate = g
  }
  return out
}

/**
 * Where trace lines go: an input parked for the owner is a warning, everything else is debug output
 * (dropped by default); `trace` (the daemon's audit file, fixtures) also gets every entry. A failing
 * sink never changes the outcome.
 */
export function ownerInputTracer(deps: {
  warn: (message: string) => void
  debug?: (message: string) => void
  trace?: (entry: OwnerInputTrace) => void
  clock?: () => number
}) {
  // Debug lines go nowhere unless a sink is given; the audit file (via `trace`) is the durable record.
  const debug = deps.debug ?? (() => undefined)
  const clock = deps.clock ?? Date.now
  const passes = new Map<string, TracePass>()
  const emit = (entry: Omit<OwnerInputTrace, 'at'>) => {
    const line = { ...entry, at: new Date(clock()).toISOString() }
    try {
      if (line.event === 'transition' && line.to?.startsWith('needsOwner/')) deps.warn(formatTrace(line))
      else debug(formatTrace(line))
      deps.trace?.(line)
    } catch {
      /* Diagnostics never change what happens to an input. */
    }
  }
  const ofPass = (sessionId: string) => {
    const pass = passes.get(sessionId)
    return { pass: pass?.id ?? '-', trigger: pass?.trigger ?? ('sweep' as const), sessionId }
  }
  return {
    emit,
    /** A row moved from `row` to `moved`, with what this pass read of the gates and the inbox. */
    transition(row: ManagedInputRow, moved: ManagedInputRow) {
      const pass = passes.get(row.sessionId)
      emit({
        event: 'transition',
        ...ofPass(row.sessionId),
        key: row.key,
        from: `${row.state}/${row.reason}`,
        to: `${moved.state}/${moved.reason}`,
        version: moved.version,
        submittedSeq: moved.submittedSeq,
        ...(pass?.gate ? { gate: pass.gate } : {}),
        ...(pass?.inbox ? { inbox: pass.inbox } : {}),
      })
    },
    /** A row the gates left as it was: they could not be read, or cannot answer yet. */
    held(row: ManagedInputRow, gate: GateReport) {
      emit({
        event: 'held',
        ...ofPass(row.sessionId),
        key: row.key,
        from: `${row.state}/${row.reason}`,
        version: row.version,
        gate,
      })
    },
    /** A revoke, prune or uninstall: per session, the owner's open inputs and how many it matched. */
    withdrawal(rows: readonly ManagedInputRow[], matched: readonly ManagedInputRow[], scoped: boolean) {
      for (const sessionId of new Set(rows.map((row) => row.sessionId)))
        emit({
          event: 'withdraw',
          pass: '-',
          trigger: 'withdraw',
          sessionId,
          scoped,
          rows: rows.filter((row) => row.sessionId === sessionId).length,
          matched: matched.filter((row) => row.sessionId === sessionId).length,
        })
    },
    /** The pass under way for a session; callers hold the session's lane, so one is open per session. */
    current: (sessionId: string) => passes.get(sessionId),
    /** Runs `work` as a pass; a pass already open for the session (a nested advance) is kept. */
    async within<T>(sessionId: string, trigger: OwnerInputTrigger, work: () => Promise<T>): Promise<T> {
      if (passes.has(sessionId)) return work()
      passes.set(sessionId, { id: randomBytes(4).toString('hex'), trigger })
      try {
        return await work()
      } finally {
        passes.delete(sessionId)
      }
    },
  }
}

export type OwnerInputTracer = ReturnType<typeof ownerInputTracer>
