import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Durable plan-mode file. The canonical reader and writer live in the plan-mode extension.
 * This copy exists so the TUI can flip the file without importing `@agnes/base`.
 * Schema: `{ active, instruction?, pendingPlan?, updatedAt }` at `<cwd>/.agnes/plan-mode.json`.
 */
type PlanModeState = {
  active: boolean
  instruction?: string
  updatedAt: string
}

function canonicalPlanCwd(cwd: string): string {
  const resolved = resolve(cwd)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function writePlanMode(cwd: string, state: PlanModeState): void {
  const root = canonicalPlanCwd(cwd)
  mkdirSync(join(root, '.agnes'), { recursive: true })
  writeFileSync(join(root, '.agnes', 'plan-mode.json'), `${JSON.stringify(state)}\n`)
}

/** `/plan`, `/plan on`, `/plan off`, or `/plan <instruction>`. Turning on drops any pending plan. */
export function applyPlanCommand(cwd: string, line: string): { active: boolean; text: string } {
  const rest = line.trim().replace(/^\/plan\b/, '').trim()
  const updatedAt = new Date().toISOString()
  if (rest === 'off') {
    writePlanMode(cwd, { active: false, updatedAt })
    return { active: false, text: 'Plan mode is off' }
  }
  const instruction = rest === '' || rest === 'on' ? undefined : rest.slice(0, 4000)
  writePlanMode(cwd, { active: true, ...(instruction ? { instruction } : {}), updatedAt })
  return {
    active: true,
    text: instruction ? `Plan mode is on: ${instruction}` : 'Plan mode is on',
  }
}
