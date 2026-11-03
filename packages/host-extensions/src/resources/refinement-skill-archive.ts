import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import {
  buildInstallBundle,
  type InstallBundle,
  type InstallSkillRoot,
  installError,
  readInstallBundle,
  type SkillDiscovery,
  safeName,
  unlinked,
} from './skill-install-files.js'
import { publishInstallBundle } from './skill-install-publish.js'

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/
/** Lower-case ASCII only: one spelling per folder on every platform, no device names, no traversal. */
export const isSavedSkillName = (name: string): boolean =>
  SKILL_NAME.test(name) && !name.endsWith('.') && !DEVICE_NAME.test(name) && safeName(name)

/** Archived revisions kept per skill besides the one in use. */
export const SKILL_ARCHIVE_KEEP = 5
const REVISION = /^[a-f0-9]{64}$/
const JOURNAL_ID = /^[a-f0-9]{64}$/
const MAX_JOURNAL_BYTES = 64 * 1024

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * An unfinished install or replacement, written before the first change to the workspace and removed
 * once the registry holds the result. It names the files only by revision: their bytes are in the
 * archive, so a restart can finish the work from there.
 */
export type SkillJournal = {
  id: string
  kind: 'install' | 'replace'
  name: string
  /** The revision being written; its files are in the archive. */
  toRevision: string
  /** For a replacement, the revision that must still be in place before it is removed. */
  fromRevision?: string
  /** Install only: the receipt the caller will retry with. */
  receiptId?: string
  /**
   * The registry source to record, kept so a resumed operation records the same one. A replacement
   * without one keeps the source the skill had.
   */
  source?: unknown
  phase: 'prepared' | 'removed' | 'published'
  /** Whether the skill ends enabled; missing means enabled. */
  enable?: boolean
  at: number
}

const ensureDirectory = (path: string): string => {
  const target = unlinked(path)
  const missing: string[] = []
  for (let cursor = target; !existsSync(cursor); cursor = dirname(cursor)) {
    missing.unshift(cursor)
    if (dirname(cursor) === cursor) break
  }
  for (const directory of missing) {
    try {
      createPrivateDirectorySync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return unlinked(target)
}

/**
 * What the saved-skill installer keeps for one workspace, all under the profile's data directory and so
 * outside anything the agent can write: earlier revisions of each installed skill (for rollback, and as
 * the source a resumed install publishes from) and the journal of unfinished operations. Paths are built only from checked skill names and revision hashes.
 */
export function refinementSkillArchive(dataDir: string, workspaceRoot: string) {
  const base = join(dataDir, 'refinement')
  const workspaceKey = sha256(workspaceRoot)
  const archiveRoot = join(base, 'skill-archive', workspaceKey)
  const journalRoot = join(base, 'skill-installs', workspaceKey)
  const revisionPath = (name: string, revision: string) => {
    if (!REVISION.test(revision)) throw installError('SKILL_REVISION_INVALID')
    return join(archiveRoot, name, revision)
  }
  return {
    /** Stores a bundle under its revision; storing the same revision again keeps the first copy. */
    save(name: string, bundle: InstallBundle): void {
      const target = revisionPath(name, bundle.candidate.revision)
      ensureDirectory(archiveRoot)
      if (existsSync(unlinked(target))) return
      try {
        publishInstallBundle(target, bundle, () => undefined)
      } catch (error) {
        if ((error as { code?: string }).code !== 'SKILL_TARGET_CONFLICT') throw error
      }
    },
    has(name: string, revision: string): boolean {
      return REVISION.test(revision) && existsSync(unlinked(revisionPath(name, revision)))
    },
    /**
     * Reads an archived revision back as a bundle for `root`, and refuses it unless its files still
     * produce that revision.
     */
    async load(
      name: string,
      revision: string,
      root: InstallSkillRoot,
      discovery: SkillDiscovery,
    ): Promise<InstallBundle> {
      const stored = await readInstallBundle(revisionPath(name, revision), root, [], discovery).catch(() => {
        throw installError('SKILL_ARCHIVE_MISSING')
      })
      const bundle = await buildInstallBundle(name, stored.files, root, discovery)
      if (bundle.candidate.revision !== revision) throw installError('SKILL_ARCHIVE_DAMAGED')
      return bundle
    },
    /** Removes archived revisions of `name` other than `keep`, oldest stored first, down to the limit. */
    prune(name: string, ordered: readonly string[], keep: readonly string[]): string[] {
      const kept = [
        ...ordered.filter((revision) => !keep.includes(revision)).slice(-SKILL_ARCHIVE_KEEP),
        ...keep,
      ]
      const folder = join(archiveRoot, name)
      if (!existsSync(unlinked(folder))) return ordered.filter((revision) => kept.includes(revision))
      for (const entry of readdirSync(folder)) {
        if (!REVISION.test(entry) || kept.includes(entry)) continue
        rmSync(unlinked(join(folder, entry)), { recursive: true, force: true })
      }
      return ordered.filter((revision) => kept.includes(revision))
    },
    journal: {
      idFor(key: string): string {
        return sha256(key)
      },
      write(entry: SkillJournal): void {
        if (!JOURNAL_ID.test(entry.id)) throw installError('SKILL_JOURNAL_INVALID')
        ensureDirectory(journalRoot)
        const file = unlinked(join(journalRoot, `${entry.id}.json`))
        const temp = `${file}.${randomUUID()}.tmp`
        const fd = createPrivateFileSync(temp)
        try {
          try {
            writeFileSync(fd, JSON.stringify(entry))
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
          renameSync(temp, file)
        } finally {
          if (existsSync(temp)) rmSync(temp)
        }
      },
      remove(id: string): void {
        if (!JOURNAL_ID.test(id)) return
        rmSync(unlinked(join(journalRoot, `${id}.json`)), { force: true })
      },
      /** Unfinished operations, oldest first. A file that cannot be read is skipped, never acted on. */
      list(): SkillJournal[] {
        if (!existsSync(unlinked(journalRoot))) return []
        const entries: SkillJournal[] = []
        for (const file of readdirSync(journalRoot)) {
          if (file.endsWith('.tmp')) {
            rmSync(unlinked(join(journalRoot, file)), { force: true })
            continue
          }
          if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
          try {
            const text = readFileSync(unlinked(join(journalRoot, file)), 'utf8')
            if (text.length > MAX_JOURNAL_BYTES) continue
            const entry = JSON.parse(text) as SkillJournal
            if (
              `${entry.id}.json` === file &&
              (entry.kind === 'install' || entry.kind === 'replace') &&
              typeof entry.name === 'string' &&
              isSavedSkillName(entry.name) &&
              REVISION.test(entry.toRevision) &&
              (entry.fromRevision === undefined || REVISION.test(entry.fromRevision)) &&
              ['prepared', 'removed', 'published'].includes(entry.phase) &&
              (entry.enable === undefined || typeof entry.enable === 'boolean') &&
              Number.isFinite(entry.at)
            )
              entries.push(entry)
          } catch {
            // unreadable: left for a person to look at
          }
        }
        return entries.sort((a, b) => a.at - b.at)
      },
    },
  }
}
export type RefinementSkillArchive = ReturnType<typeof refinementSkillArchive>
