import { existsSync, lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'
import { type RecordRecovery, recordPackageRecovery } from './recovery-log.js'

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
    throw new PackageError('E_EXT_LOAD', 'staging owner is invalid', {
      detail: {
        reason: 'staging-owner-invalid',
        path: file,
        repair:
          'If no package operation is running, delete this owner file and the staging directory beside it.',
      },
    })
  const copy = data.kind === 'copy'
  try {
    process.kill(data.pid, 0)
    return { dead: false, ready: data.ready, copy }
  } catch (error) {
    return { dead: (error as NodeJS.ErrnoException).code === 'ESRCH', ready: data.ready, copy }
  }
}
/** Nothing in a dead operation's leftover has changed for this long, so no orphaned child still writes it. */
export const ABANDONED_AFTER_MS = 10 * 60_000
function newest(path: string): number {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return 0
  let latest = stat.mtimeMs
  if (stat.isDirectory())
    for (const name of readdirSync(path)) latest = Math.max(latest, newest(join(path, name)))
  return latest
}
/**
 * Never delete a live inspector. A dead owner's in-process copy had no other writer, so its partial
 * stage is deleted at once. An unfinished external fetch, or a leftover with no owner, may still have
 * an orphaned child writing into it: it is removed once nothing in it has changed for
 * ABANDONED_AFTER_MS, and skipped until then. Neither is ever published, so skipping it never blocks
 * the operation holding the lock.
 */
export function recoverStaging(root: string, record: RecordRecovery = () => {}, now = Date.now()): void {
  if (!existsSync(root)) return
  const remove = (paths: string[], reason: string): void => {
    if (paths.some((path) => now - newest(path) < ABANDONED_AFTER_MS)) return
    for (const path of paths) {
      try {
        rmSync(path, { recursive: true, force: true })
        record({ action: 'removed', path, reason })
      } catch {
        // A file an orphan still holds open (Windows) is retried by a later operation.
        record({ action: 'kept', path, reason: `${reason}:remove-failed` })
      }
    }
  }
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.endsWith('.owner') && STAGE.test(name.slice(0, -6))) {
      const owner = dead(path),
        stage = path.slice(0, -6)
      if (!owner.dead) continue
      if (!owner.ready && !owner.copy && existsSync(stage)) remove([stage, path], 'staging-outcome-unknown')
      else {
        clearStage(stage)
        const reason = owner.copy
          ? 'staging-copy-dead'
          : owner.ready
            ? 'staging-ready-dead'
            : 'staging-owner-only'
        record({ action: 'removed', path: stage, reason })
      }
    } else if (name.startsWith('.agnes-fetch-')) {
      const owner = join(path, '.owner')
      if (!existsSync(owner) || dead(owner).dead) remove([path], 'fetch-outcome-unknown')
    } else if (STAGE.test(name) && !existsSync(`${path}.owner`)) {
      remove([path], 'staging-owner-unknown')
    }
  }
}

/** recoverStaging for a profile, recording what it removed in the profile's recovery log. */
export function recoverProfileStaging(root: string, profileDir: string): void {
  recoverStaging(root, (event) => recordPackageRecovery(profileDir, event))
}
