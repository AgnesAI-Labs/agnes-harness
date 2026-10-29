import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const startToken = `${Math.trunc(Date.now() - process.uptime() * 1000)}-${randomUUID()}`
type LockOwner = { pid: number; startToken: string }
// Allow a creator time to publish its owner. Only an unreadable owner uses this fallback.
const INCOMPLETE_LOCK_AGE_MS = 30_000
function deadOwner(lock: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(lock, 'utf8')) as LockOwner
    if (
      !Number.isSafeInteger(owner?.pid) ||
      owner.pid <= 0 ||
      owner.pid > 2_147_483_647 ||
      typeof owner.startToken !== 'string' ||
      !/^\d{1,16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.startToken)
    )
      return undefined
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return owner
    }
  } catch {
    try {
      const stat = statSync(lock)
      if (!stat.isFile() || Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_AGE_MS) return undefined
      return { pid: 0, startToken: `incomplete:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}` }
    } catch {
      // Missing or unstatable files cannot be reclaimed from this observation.
    }
  }
  return undefined
}
function releaseLock(lock: string, fd: number): void {
  try {
    closeSync(fd)
  } finally {
    unlinkSync(lock)
  }
}
function acquireLock(lock: string): number {
  const create = () => {
    const fd = openSync(lock, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startToken })}\n`, { flush: true })
      return fd
    } catch (error) {
      releaseLock(lock, fd)
      throw error
    }
  }
  try {
    return create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = deadOwner(lock)
    if (!owner) throw error
    // Token-scoped reclaim locks serialize removers. They use the same recovery rule if killed.
    const reclaim = join(
      dirname(lock),
      `.plan-mode-reclaim-${createHash('sha256').update(`${lock}\0${owner.startToken}`).digest('hex')}`,
    )
    const fd = acquireLock(reclaim)
    try {
      const current = deadOwner(lock)
      if (!current || current.pid !== owner.pid || current.startToken !== owner.startToken) throw error
      unlinkSync(lock)
      return create() // One retry; a competing writer is never removed.
    } finally {
      releaseLock(reclaim, fd)
    }
  }
}
/** All writers share the exclusive lock; a proven-dead owner or an aged incomplete owner permits recovery. */
function mutate(workspaceRoot: string, change: () => PlanModeState | undefined): boolean {
  const path = planModePath(workspaceRoot)
  mkdirSync(join(canonicalPlanWorkspaceRoot(workspaceRoot), AGH_DIR), { recursive: true })
  const lock = `${path}.lock`
  const fd = acquireLock(lock)
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
      releaseLock(lock, fd)
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
  if (rest === 'status' || rest === 'pending') {
    const state = readPlanMode(workspaceRoot)
    return {
      active: state.active,
      text:
        rest === 'pending'
          ? (state.pendingPlan?.slice(0, 8192) ?? 'No pending plan')
          : state.active
            ? 'Plan mode is on'
            : 'Plan mode is off',
    }
  }
  const updatedAt = new Date().toISOString()
  if (rest === 'off') {
    writePlanMode(workspaceRoot, { active: false, updatedAt })
    return { active: false, text: 'Plan mode is off' }
  }
  const instruction = rest === '' || rest === 'on' ? undefined : rest.slice(0, 4000)
  writePlanMode(workspaceRoot, { active: true, ...(instruction ? { instruction } : {}), updatedAt })
  return { active: true, text: instruction ? `Plan mode is on: ${instruction}` : 'Plan mode is on' }
}
