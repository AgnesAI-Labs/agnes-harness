import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'

const STAGE = /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function marker(file: string, ready: boolean): void {
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, ready }), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}
export function claimStage(stage: string): void {
  marker(`${stage}.owner`, false)
}
export function readyStage(stage: string): void {
  if (!STAGE.test(basename(stage)) || !existsSync(`${stage}.owner`)) return
  const owner = readStaticJson(`${stage}.owner`)
  if (owner.pid !== process.pid || typeof owner.ready !== 'boolean' || Object.keys(owner).length !== 2)
    throw new PackageError('E_EXT_LOAD', 'staging owner differs')
  marker(`${stage}.owner`, true)
}
export function clearStage(stage: string): void {
  rmSync(stage, { recursive: true, force: true })
  rmSync(`${stage}.owner`, { force: true })
}
export function claimFetch(work: string): void {
  marker(join(work, '.owner'), false)
}
function dead(file: string): { dead: boolean; ready: boolean } {
  const data = readStaticJson(file)
  if (
    Object.keys(data).sort().join(',') !== 'pid,ready' ||
    typeof data.pid !== 'number' ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 0 ||
    typeof data.ready !== 'boolean'
  )
    throw new PackageError('E_EXT_LOAD', 'staging owner is invalid')
  try {
    process.kill(data.pid, 0)
    return { dead: false, ready: data.ready }
  } catch (error) {
    return { dead: (error as NodeJS.ErrnoException).code === 'ESRCH', ready: data.ready }
  }
}
/** Never delete a live inspector or infer that an unfinished external command has stopped. */
export function recoverStaging(root: string): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.endsWith('.owner') && STAGE.test(name.slice(0, -6))) {
      const owner = dead(path),
        stage = path.slice(0, -6)
      if (!owner.dead) continue
      if (!owner.ready && existsSync(stage))
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
