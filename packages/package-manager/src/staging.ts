import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'

const STAGE = /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** `copy`: only this process writes the stage. `fetch`: an adapter or external command may. */
export type StageKind = 'copy' | 'fetch'
function marker(file: string, ready: boolean, kind?: StageKind): void {
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, ready, ...(kind ? { kind } : {}) }), {
    mode: 0o600,
  })
  renameSync(`${file}.tmp`, file)
}
export function claimStage(stage: string, kind: StageKind = 'fetch'): void {
  marker(`${stage}.owner`, false, kind)
}
export function readyStage(stage: string): void {
  if (!STAGE.test(basename(stage)) || !existsSync(`${stage}.owner`)) return
  const owner = readStaticJson(`${stage}.owner`)
  if (owner.pid !== process.pid || typeof owner.ready !== 'boolean' || !ownerKeys(owner))
    throw new PackageError('E_EXT_LOAD', 'staging owner differs')
  marker(`${stage}.owner`, true, owner.kind as StageKind | undefined)
}
// A marker written before stage kinds existed has no kind and is treated as a fetch.
function ownerKeys(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data).sort().join(',')
  return (
    keys === 'pid,ready' || (keys === 'kind,pid,ready' && (data.kind === 'copy' || data.kind === 'fetch'))
  )
}
export function clearStage(stage: string): void {
  rmSync(stage, { recursive: true, force: true })
  rmSync(`${stage}.owner`, { force: true })
}
export function claimFetch(work: string): void {
  marker(join(work, '.owner'), false)
}
function dead(file: string): { dead: boolean; ready: boolean; copy: boolean } {
  const data = readStaticJson(file)
  if (
    !ownerKeys(data) ||
    typeof data.pid !== 'number' ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 0 ||
    typeof data.ready !== 'boolean'
  )
    throw new PackageError('E_EXT_LOAD', 'staging owner is invalid')
  const copy = data.kind === 'copy'
  try {
    process.kill(data.pid, 0)
    return { dead: false, ready: data.ready, copy }
  } catch (error) {
    return { dead: (error as NodeJS.ErrnoException).code === 'ESRCH', ready: data.ready, copy }
  }
}
/**
 * Never delete a live inspector or infer that an unfinished external command has stopped. A dead
 * owner's in-process copy had no other writer, so its partial stage is safe to delete.
 */
export function recoverStaging(root: string): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.endsWith('.owner') && STAGE.test(name.slice(0, -6))) {
      const owner = dead(path),
        stage = path.slice(0, -6)
      if (!owner.dead) continue
      if (!owner.ready && !owner.copy && existsSync(stage))
        throw new PackageError('E_EXT_LOAD', 'unfinished adapter staging requires recovery', {
          detail: { reason: 'staging-outcome-unknown' },
        })
      clearStage(stage)
    } else if (name.startsWith('.agnes-fetch-')) {
      const owner = join(path, '.owner')
      if (!existsSync(owner) || dead(owner).dead)
        throw new PackageError('E_EXT_LOAD', 'unfinished source acquisition requires recovery', {
          detail: { reason: 'fetch-outcome-unknown' },
        })
    } else if (STAGE.test(name) && !existsSync(`${path}.owner`)) {
      throw new PackageError('E_EXT_LOAD', 'unowned staging requires recovery', {
        detail: { reason: 'staging-owner-unknown' },
      })
    }
  }
}
