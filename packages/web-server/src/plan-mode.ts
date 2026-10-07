import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Durable plan-mode file. The canonical reader and writer live in the plan-mode extension.
 * This copy exists so the static web server can flip the file without importing `@agnes/base`.
 * Schema: `{ active, instruction?, pendingPlan?, updatedAt }` at `<cwd>/.agnes/plan-mode.json`.
 */
type PlanModeState = {
  active: boolean
  instruction?: string
  updatedAt: string
}

export type PlanModeWrite =
  | { ok: true; active: boolean; text: string }
  | { ok: false; code: 'INVALID_REQUEST' }

function invalid(): PlanModeWrite {
  return { ok: false, code: 'INVALID_REQUEST' }
}

/**
 * Write plan mode for an absolute cwd that already exists. The cwd itself is never created.
 * Only `<realpath(cwd)>/.agnes/plan-mode.json` is written.
 */
export function applyPlanCommand(cwd: string, line: string): PlanModeWrite {
  if (cwd.length === 0 || cwd.length > 4096 || cwd.includes('\0') || !isAbsolute(cwd)) return invalid()
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 8192 || !/^\/plan(?:\s|$)/.test(trimmed)) return invalid()
  let root: string
  try {
    const resolved = resolve(cwd)
    if (!statSync(resolved).isDirectory()) return invalid()
    root = realpathSync(resolved)
  } catch {
    return invalid()
  }
  const rest = trimmed.replace(/^\/plan\b/, '').trim()
  const updatedAt = new Date().toISOString()
  const state: PlanModeState =
    rest === 'off'
      ? { active: false, updatedAt }
      : {
          active: true,
          ...(rest === '' || rest === 'on' ? {} : { instruction: rest.slice(0, 4000) }),
          updatedAt,
        }
  const dir = join(root, '.agnes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plan-mode.json'), `${JSON.stringify(state)}\n`)
  return {
    ok: true,
    active: state.active,
    text:
      state.active === false
        ? 'Plan mode is off'
        : state.instruction
          ? `Plan mode is on: ${state.instruction}`
          : 'Plan mode is on',
  }
}
