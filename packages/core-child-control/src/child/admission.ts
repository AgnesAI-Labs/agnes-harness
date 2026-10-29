import type { ChildExecutionState } from './types.js'
import { isActiveChildState } from './types.js'

export type GenerationAdmission = { ok: true; childDepth: number } | { ok: false; message: string }

export function admitGeneration(parentDepth: number, generationLimit: number): GenerationAdmission {
  if (!Number.isSafeInteger(parentDepth) || parentDepth < 0)
    return { ok: false, message: 'parent generationDepth is not a non-negative integer' }
  if (!Number.isSafeInteger(generationLimit) || generationLimit < 0)
    return { ok: false, message: 'generation limit is not a non-negative integer' }
  const childDepth = parentDepth + 1
  if (childDepth > generationLimit)
    return {
      ok: false,
      message: `generation ${childDepth} exceeds limit ${generationLimit}`,
    }
  return { ok: true, childDepth }
}

export type FanOutAdmission = { ok: true } | { ok: false; message: string }

export function admitFanOut(parentActive: number, rootActive: number, maxFanOut: number): FanOutAdmission {
  if (!Number.isSafeInteger(maxFanOut) || maxFanOut < 0)
    return { ok: false, message: 'max_fan_out is not a non-negative integer' }
  if (parentActive >= maxFanOut)
    return { ok: false, message: `fan-out limit ${maxFanOut} reached for parent` }
  if (rootActive >= maxFanOut) return { ok: false, message: `fan-out limit ${maxFanOut} reached for root` }
  return { ok: true }
}

export function countActive(states: readonly ChildExecutionState[]): number {
  return states.filter(isActiveChildState).length
}

export function inheritAncestorScopeIds(
  parent: { ancestorScopeIds: readonly string[]; budgetScopeId: string } | null,
  rootScopeId: string,
): string[] {
  const ids = parent ? [...parent.ancestorScopeIds] : [rootScopeId]
  if (parent && !ids.includes(parent.budgetScopeId)) ids.push(parent.budgetScopeId)
  if (!ids.includes(rootScopeId)) ids.unshift(rootScopeId)
  return ids
}

export type BudgetModeAdmission = { ok: true } | { ok: false; message: string }

export function admitBudgetMode(mode: string | undefined): BudgetModeAdmission {
  if (mode === undefined || mode === 'aggregate') return { ok: true }
  if (mode === 'own') return { ok: false, message: 'unsupported budget mode own' }
  return { ok: false, message: `unsupported budget mode ${mode}` }
}
