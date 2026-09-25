// Ledger state as plain data, so tests and shared cases compare two states by content.
import type { LedgerState } from '../src/reduce/state.js'

export type EncodedLedgerState = Omit<
  LedgerState,
  | 'registers'
  | 'openTurn'
  | 'openStep'
  | 'lastTurn'
  | 'lastStep'
  | 'pendingEffects'
  | 'pendingApprovals'
  | 'decisions'
  | 'resumedRequests'
  | 'taint'
  | 'toolCalls'
> & {
  registers: {
    [K in keyof LedgerState['registers']]: Array<
      [string, LedgerState['registers'][K] extends ReadonlyMap<string, infer V> ? V : never]
    >
  }
  openTurn: Array<[string, LedgerState['openTurn'] extends ReadonlyMap<string, infer V> ? V : never]>
  openStep: Array<[string, LedgerState['openStep'] extends ReadonlyMap<string, infer V> ? V : never]>
  lastTurn: Array<[string, number]>
  lastStep: Array<[string, number]>
  pendingEffects: Array<
    [string, LedgerState['pendingEffects'] extends ReadonlyMap<string, infer V> ? V : never]
  >
  pendingApprovals: Array<
    [string, LedgerState['pendingApprovals'] extends ReadonlyMap<string, infer V> ? V : never]
  >
  decisions: Array<[string, LedgerState['decisions'] extends ReadonlyMap<string, infer V> ? V : never]>
  resumedRequests: string[]
  taint: Array<[string, boolean]>
  toolCalls: Array<[string, LedgerState['toolCalls'] extends ReadonlyMap<string, infer V> ? V : never]>
}

/** The state as plain data, maps and sets as entry arrays, so two states compare by content. */
export function encodeLedgerState(state: LedgerState): EncodedLedgerState {
  return {
    ...state,
    registers: {
      planItems: [...state.registers.planItems],
      budgetState: [...state.registers.budgetState],
      artifactJobs: [...state.registers.artifactJobs],
      inbox: [...state.registers.inbox],
      harnessEntries: [...state.registers.harnessEntries],
    },
    openTurn: [...state.openTurn],
    openStep: [...state.openStep],
    lastTurn: [...state.lastTurn],
    lastStep: [...state.lastStep],
    pendingEffects: [...state.pendingEffects],
    pendingApprovals: [...state.pendingApprovals],
    decisions: [...state.decisions],
    resumedRequests: [...state.resumedRequests],
    taint: [...state.taint],
    toolCalls: [...state.toolCalls],
  }
}
