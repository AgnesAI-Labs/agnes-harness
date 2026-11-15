import { randomBytes } from 'node:crypto'
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

/**
 * Where trace lines go: an input parked for the owner is a warning, everything else is debug output;
 * `observe` (test fixtures, embedders) also gets every entry. A failing sink never changes the outcome.
 */
export function ownerInputTracer(deps: {
  warn: (message: string) => void
  debug?: (message: string) => void
  trace?: (entry: OwnerInputTrace) => void
  clock?: () => number
}) {
  const debug = deps.debug ?? ((message: string) => console.debug(message))
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
