import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'

/** Workspace-owned durable plan state. revision binds the exact file bytes, including the write nonce. */
export type PlanModeState = {
  active: boolean
  blocked?: boolean
  revision?: string
  instruction?: string
  pendingPlan?: string
  updatedAt: string
}
const inactive = (): PlanModeState => ({ active: false, updatedAt: '' })
const blocked = (): PlanModeState => ({ active: true, blocked: true, updatedAt: '' })
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
export function readPlanMode(workspaceRoot: string): PlanModeState {
  try {
    const raw = readFileSync(planModePath(workspaceRoot), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PlanModeState>
    if (
      !parsed ||
      typeof parsed.active !== 'boolean' ||
      typeof parsed.updatedAt !== 'string' ||
      (parsed.instruction !== undefined && typeof parsed.instruction !== 'string') ||
      (parsed.pendingPlan !== undefined && typeof parsed.pendingPlan !== 'string')
    )
      return blocked()
    return {
      active: parsed.active,
      updatedAt: parsed.updatedAt,
      revision: createHash('sha256').update(raw).digest('hex'),
      ...(parsed.instruction ? { instruction: parsed.instruction } : {}),
      ...(parsed.pendingPlan ? { pendingPlan: parsed.pendingPlan } : {}),
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? inactive() : blocked()
  }
}
/** All writers share the exclusive lock. A stale/busy lock refuses mutation; it never clears a plan. */
function mutate(workspaceRoot: string, change: () => PlanModeState | undefined): boolean {
  const path = planModePath(workspaceRoot)
  mkdirSync(join(canonicalPlanWorkspaceRoot(workspaceRoot), AGH_DIR), { recursive: true })
  const lock = `${path}.lock`
  const fd = openSync(lock, 'wx', 0o600)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const state = change()
    if (!state) return false
    const { revision: _revision, blocked: _blocked, ...value } = state
    writeFileSync(temp, `${JSON.stringify({ ...value, nonce: randomUUID() })}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
    return true
  } finally {
    try {
      rmSync(temp, { force: true })
    } finally {
      try {
        closeSync(fd)
      } finally {
        unlinkSync(lock)
      }
    }
  }
}
export function writePlanMode(workspaceRoot: string, state: PlanModeState): void {
  mutate(workspaceRoot, () => state)
}
/** Compare and clear under the same cross-process lock; approval A cannot clear plan B. */
export function clearPlanMode(workspaceRoot: string, expectedRevision: string, plan: string): boolean {
  return mutate(workspaceRoot, () => {
    const current = readPlanMode(workspaceRoot)
    if (!current.active || current.blocked || !expectedRevision || current.revision !== expectedRevision)
      return undefined
    return { active: false, pendingPlan: plan, updatedAt: new Date().toISOString() }
  })
}
/** Explicit human /plan off is a direct workspace control operation. */
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
  return { active: true, text: instruction ? `Plan mode is on: ${instruction}` : 'Plan mode is on' }
}
