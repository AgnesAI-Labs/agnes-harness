import type { ComparisonPreparedReceipt, ComparisonTreeCuts, RuntimeIdentity } from '@agnes/protocol'
import type { ComparisonRecord, RunTiming, Side, TerminalCause } from '@agnes/runtime-comparison'

export type ComparisonJournalCuts = Record<Side, number>
export type ComparisonJournalBinding = { sessionId: string; runtime: RuntimeIdentity }
export type ComparisonJournalFact =
  | {
      kind: 'coordinator'
      revision: number
      creation: ComparisonRecord['creation']
      prepared?: Partial<Record<Side, ComparisonPreparedReceipt>>
      lanes: Partial<Record<Side, ComparisonJournalBinding & { phase: string }>>
      roundCount: number
      latestRound: {
        inputId: string
        permissionMode?: NonNullable<ComparisonRecord['permissionMode']>
        prepared?: Partial<Record<Side, ComparisonPreparedReceipt>>
        runs: Record<Side, string>
        terminalCauses: Record<Side, TerminalCause>
        acceptances: Record<Side, string>
        acceptedSeqs: Partial<Record<Side, number>>
        /** Absent on legacy facts. Present only for sides that reserved a clocked run. */
        timings?: Partial<Record<Side, RunTiming>>
        /** Absent until a settled observation publishes its session seq. */
        terminalSeqs?: Partial<Record<Side, number>>
      } | null
      cancellation: ComparisonRecord['cancellation']
      cleanup: ComparisonRecord['cleanup']
    }
  | { kind: 'lane'; side: Side; sessionId: string; localSeq: number; digest: string }
  | {
      kind: 'checkpoint'
      reason: 'baseline' | 'recovery' | 'legacy'
      coverage: 'unknown-interleaving' | 'per-lane-only'
    }

export interface ComparisonJournalEntry {
  seq: number
  cuts: ComparisonJournalCuts
  fact: ComparisonJournalFact
  treeCuts?: ComparisonTreeCuts
}

export interface ComparisonJournalHead {
  seq: number
  cuts: ComparisonJournalCuts
  coverage: 'ordered' | 'per-lane-only' | 'unknown-interleaving'
  bindings: Partial<Record<Side, ComparisonJournalBinding>>
}

export interface ComparisonJournalPage {
  entries: ComparisonJournalEntry[]
  afterSeq: number
  /** Inclusive upper bound, fixed for every subsequent page. */
  throughSeq: number
  nextAfterSeq: number
  complete: boolean
}

export interface ComparisonJournalStore {
  head(id: string): Promise<ComparisonJournalHead | undefined>
  appendLane(
    id: string,
    source: { side: Side; sessionId: string; localSeq: number; digest: string },
  ): Promise<ComparisonJournalEntry>
  checkpoint(
    id: string,
    checkpoint: {
      reason: 'baseline' | 'recovery' | 'legacy'
      cuts: ComparisonJournalCuts
      treeCuts?: ComparisonTreeCuts
    },
  ): Promise<ComparisonJournalEntry>
  read(
    id: string,
    options?: { afterSeq?: number; throughSeq?: number; limit?: number; maxBytes?: number },
  ): Promise<ComparisonJournalPage>
  cutsAt(id: string, seq: number): Promise<ComparisonJournalCuts>
  treeCutsAt(id: string, seq: number): Promise<ComparisonTreeCuts | undefined>
}

export class ComparisonJournalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ComparisonJournalError'
  }
}
