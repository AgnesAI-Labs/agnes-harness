import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { replaceFileAtomicSync } from '@agnes/system-node'
import { PackageError } from './errors.js'
import { readStaticJson } from './integrity.js'
import { type RecordRecovery, recordPackageRecovery } from './recovery-log.js'

const STAGE = /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** `copy`: only this process writes the stage. `fetch`: an adapter or external command may. */
export type StageKind = 'copy' | 'fetch'
// Replaced atomically, so a live reader never sees a torn owner file, but never flushed. A marker is
// only a cleanup hint: a stage is adopted solely through the transaction journal, which flushes the
// tree and checks its digest, and is recovered before staging. Power loss can leave a marker
// missing, empty or one state behind; recoverStaging treats each of those as an unknown or dead
// owner, so the leftover is removed, never published.
function marker(file: string, ready: boolean, kind?: StageKind): void {
  replaceFileAtomicSync(file, JSON.stringify({ pid: process.pid, ready, ...(kind ? { kind } : {}) }))
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
type Owner = { dead: boolean; ready: boolean; copy: boolean }
/** An owner marker this version cannot read (torn by power loss, or foreign) says nothing about liveness. */
function ownerOf(file: string): Owner | undefined {
  let data: Record<string, unknown>
  try {
    data = readStaticJson(file)
  } catch {
    return undefined
  }
  if (
    !ownerKeys(data) ||
    typeof data.pid !== 'number' ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 0 ||
    typeof data.ready !== 'boolean'
  )
    return undefined
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
/** A timestamp this far ahead of the clock is skew, not a recent write (file times can lead Date.now()). */
const FUTURE_SLACK_MS = 60_000
/** Entries looked at per leftover; a larger tree is judged by the part already seen. */
const NEWEST_BUDGET = 2000
/**
 * The latest change in a leftover. A timestamp from the future (clock skew, an archive built ahead)
 * says nothing about recent writes; an entry that cannot be read counts as just changed, so the
 * leftover is left for a later pass instead of failing this one.
 */
function newest(path: string, now: number, budget = { left: NEWEST_BUDGET }): number {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) return 0
    let latest = stat.mtimeMs > now + FUTURE_SLACK_MS ? 0 : stat.mtimeMs
    if (stat.isDirectory())
      for (const name of readdirSync(path)) {
        if (--budget.left < 0) break
        latest = Math.max(latest, newest(join(path, name), now, budget))
      }
    return latest
  } catch {
    return now
  }
}
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined
/** Paths whose failed removal was already recorded, so a held file is not logged on every operation. */
const keptPaths = new Set<string>()
/**
 * Never delete a live inspector. A dead owner's in-process copy had no other writer, so its partial
 * stage is deleted at once. An unfinished external fetch, a leftover with no owner, or one whose owner
 * marker cannot be read, may still have an orphaned child writing into it: it is removed once nothing in
 * it has changed for ABANDONED_AFTER_MS, and skipped until then. Neither is ever published, so nothing
 * here refuses the operation holding the lock; a removal that fails is retried by a later one.
 */
export function recoverStaging(root: string, record: RecordRecovery = () => {}, now = Date.now()): void {
  if (!existsSync(root)) return
  const drop = (paths: string[], reason: string, quiet: boolean): void => {
    const found = paths.filter(present)
    if (!found.length) return
    if (quiet && found.some((path) => now - newest(path, now) < ABANDONED_AFTER_MS)) return
    for (const path of found) {
      try {
        rmSync(path, { recursive: true, force: true })
        keptPaths.delete(path)
        record({ action: 'removed', path, reason })
      } catch {
        // A file an orphan or a scanner still holds open (Windows) is retried by a later operation.
        if (keptPaths.has(path)) continue
        keptPaths.add(path)
        record({ action: 'kept', path, reason: `${reason}:remove-failed` })
      }
    }
  }
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.endsWith('.owner') && STAGE.test(name.slice(0, -6))) {
      const owner = ownerOf(path),
        stage = path.slice(0, -6)
      if (!owner) drop([stage, path], 'staging-owner-unreadable', true)
      else if (!owner.dead) continue
      else if (!owner.ready && !owner.copy && existsSync(stage))
        drop([stage, path], 'staging-outcome-unknown', true)
      else
        drop(
          [stage, path],
          owner.copy ? 'staging-copy-dead' : owner.ready ? 'staging-ready-dead' : 'staging-owner-only',
          false,
        )
    } else if (name.startsWith('.agnes-fetch-')) {
      const owner = join(path, '.owner')
      const state = existsSync(owner) ? ownerOf(owner) : undefined
      if (!state || state.dead) drop([path], 'fetch-outcome-unknown', true)
    } else if (STAGE.test(name) && !existsSync(`${path}.owner`)) {
      drop([path], 'staging-owner-unknown', true)
    }
  }
}

/** recoverStaging for a profile, recording what it removed in the profile's recovery log. */
export function recoverProfileStaging(root: string, profileDir: string): void {
  recoverStaging(root, (event) => recordPackageRecovery(profileDir, event))
}
