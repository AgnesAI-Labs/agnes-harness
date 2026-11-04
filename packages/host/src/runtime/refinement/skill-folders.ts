import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSavedSkillName } from '@agnes/host-extensions/resources/refinement-skill-archive'
import { AGH_DIR } from '@agnes/protocol'

/** The largest journal entry read; the installer writes far smaller ones. */
const MAX_JOURNAL_BYTES = 64 * 1024

/**
 * Whether the installer has an unfinished operation on `name` in this workspace (its journal, in the
 * data directory). Read only: the installer alone writes and clears its journal. A journal that cannot
 * be read counts as unfinished work.
 */
function unfinished(dataDir: string, workspaceRoot: string, name: string): boolean {
  const key = createHash('sha256').update(workspaceRoot).digest('hex')
  const root = join(dataDir, 'refinement', 'skill-installs', key)
  let files: string[]
  try {
    files = readdirSync(root)
  } catch (error) {
    return (error as { code?: string }).code !== 'ENOENT'
  }
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    try {
      const text = readFileSync(join(root, file), 'utf8')
      if (text.length > MAX_JOURNAL_BYTES) return true
      if ((JSON.parse(text) as { name?: unknown }).name === name) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * Whether the folder of a skill refinement installed in this workspace is gone while the installer has
 * no unfinished operation on it: a person deleted it. Only a folder that is plainly absent from a skill
 * folder that is there counts; one that cannot be looked at, a missing workspace or skill folder, or a
 * name that is not a saved skill's, does not.
 */
export function savedSkillFolderGone(dataDir: string, workspaceRoot: string, name: string): boolean {
  if (!isSavedSkillName(name)) return false
  // The workspace skill folder itself must be there: a workspace that is unmounted, moved or emptied
  // cannot tell a deleted skill from a missing disk.
  try {
    if (!lstatSync(join(workspaceRoot, AGH_DIR, 'skills')).isDirectory()) return false
  } catch {
    return false
  }
  try {
    lstatSync(join(workspaceRoot, AGH_DIR, 'skills', name))
    return false
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') return false
  }
  return !unfinished(dataDir, workspaceRoot, name)
}
