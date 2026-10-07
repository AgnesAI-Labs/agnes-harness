import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Durable plan-mode file. CLI, web, and the worker all read this path. */
export type PlanModeState = {
  active: boolean
  instruction?: string
  pendingPlan?: string
  updatedAt: string
}

const memory = new Map<string, PlanModeState>()
const inactive = (updatedAt = ''): PlanModeState => ({ active: false, updatedAt })

export function canonicalPlanCwd(cwd: string): string {
  const resolved = resolve(cwd)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function planModePath(cwd: string): string {
  return join(canonicalPlanCwd(cwd), '.agnes', 'plan-mode.json')
}

function parseState(raw: string): PlanModeState {
  const parsed = JSON.parse(raw) as Partial<PlanModeState>
  if (!parsed || typeof parsed.active !== 'boolean') return inactive()
  return {
    active: parsed.active,
    ...(typeof parsed.instruction === 'string' && parsed.instruction ? { instruction: parsed.instruction } : {}),
    ...(typeof parsed.pendingPlan === 'string' && parsed.pendingPlan ? { pendingPlan: parsed.pendingPlan } : {}),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  }
}

/** File wins when it exists. A missing file falls back to this process's last write. */
export function readPlanMode(cwd: string): PlanModeState {
  const key = canonicalPlanCwd(cwd)
  const path = join(key, '.agnes', 'plan-mode.json')
  try {
    const state = parseState(readFileSync(path, 'utf8'))
    memory.set(key, state)
    return state
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return memory.get(key) ?? inactive()
    const cleared = inactive()
    memory.set(key, cleared)
    return cleared
  }
}

export function writePlanMode(cwd: string, state: PlanModeState): void {
  const key = canonicalPlanCwd(cwd)
  const path = join(key, '.agnes', 'plan-mode.json')
  mkdirSync(join(key, '.agnes'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state)}\n`)
  memory.set(key, state)
}

/** `/plan`, `/plan on`, `/plan off`, or `/plan <instruction>`. `/plan off` clears the stage directly. */
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
