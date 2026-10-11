import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'

/** Workspace-owned durable plan-mode file. CLI, web, and the worker all read this path. */
export type PlanModeState = {
  active: boolean
  instruction?: string
  pendingPlan?: string
  updatedAt: string
}

const memory = new Map<string, PlanModeState>()
const inactive = (updatedAt = ''): PlanModeState => ({ active: false, updatedAt })

export function canonicalPlanWorkspaceRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function planModePath(workspaceRoot: string): string {
  return join(canonicalPlanWorkspaceRoot(workspaceRoot), AGH_DIR, 'plan-mode.json')
}

function parseState(raw: string): PlanModeState {
  const parsed = JSON.parse(raw) as Partial<PlanModeState>
  if (!parsed || typeof parsed.active !== 'boolean') return inactive()
  return {
    active: parsed.active,
    ...(typeof parsed.instruction === 'string' && parsed.instruction
      ? { instruction: parsed.instruction }
      : {}),
    ...(typeof parsed.pendingPlan === 'string' && parsed.pendingPlan
      ? { pendingPlan: parsed.pendingPlan }
      : {}),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  }
}

/** File wins when it exists. A missing file falls back to this process's last write. */
export function readPlanMode(workspaceRoot: string): PlanModeState {
  const key = canonicalPlanWorkspaceRoot(workspaceRoot)
  const path = join(key, AGH_DIR, 'plan-mode.json')
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

export function writePlanMode(workspaceRoot: string, state: PlanModeState): void {
  const key = canonicalPlanWorkspaceRoot(workspaceRoot)
  const path = join(key, AGH_DIR, 'plan-mode.json')
  mkdirSync(join(key, AGH_DIR), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state)}\n`)
  memory.set(key, state)
}

/** `/plan`, `/plan on`, `/plan off`, or `/plan <instruction>`. `/plan off` clears the stage directly. */
export function applyPlanCommand(workspaceRoot: string, line: string): { active: boolean; text: string } {
  const rest = line
    .trim()
    .replace(/^\/plan\b/, '')
    .trim()
  const updatedAt = new Date().toISOString()
  if (rest === 'off') {
    writePlanMode(workspaceRoot, { active: false, updatedAt })
    return { active: false, text: 'Plan mode is off' }
  }
  const instruction = rest === '' || rest === 'on' ? undefined : rest.slice(0, 4000)
  writePlanMode(workspaceRoot, { active: true, ...(instruction ? { instruction } : {}), updatedAt })
  return {
    active: true,
    text: instruction ? `Plan mode is on: ${instruction}` : 'Plan mode is on',
  }
}
