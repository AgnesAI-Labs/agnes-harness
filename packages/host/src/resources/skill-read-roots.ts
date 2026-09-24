import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export type SkillReadRootContext = Readonly<{
  homeDir: string
  /** The installation's own home: tables, secrets and profile live here, Skills under `skills/`. */
  agnesHome: string
  dataDir: string
}>

const segments = (path: string): string[] =>
  resolve(path)
    .split(/[\\/]+/)
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase())

// Case-folded on purpose: a filter that drops too much on a case-sensitive volume is safe, one that
// keeps `~/.AWS` on a case-insensitive volume is not.
const within = (inner: string[], outer: string[]): boolean =>
  outer.length <= inner.length && outer.every((seg, i) => seg === inner[i])

/** Strictly below `<base>/skills/`, i.e. one named Skill inside a skills folder, never the folder. */
const skillInside = (segs: string[], base: string[]): boolean =>
  segs.length > base.length + 1 && within(segs, [...base, 'skills'])

const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The Skill directories the file fence may open for reading, minus any that would expose more than
 * a Skill: the filesystem root, the home directory or anything above it, and the installation's
 * data. Hidden directories directly under home - where credentials, tokens and tool settings live -
 * and the installation home are closed except for a Skill strictly inside their `skills/` folder,
 * which is exactly where user-level Skill roots sit.
 */
export function safeSkillReadRoots(roots: readonly string[], context: SkillReadRootContext): string[] {
  const home = segments(canonical(context.homeDir))
  const data = segments(canonical(context.dataDir))
  const agnesHome = segments(canonical(context.agnesHome))
  return roots.filter((root) => {
    const segs = segments(root)
    if (segs.length < 2 || within(home, segs)) return false
    if (within(segs, data) || within(data, segs)) return false
    if (within(agnesHome, segs)) return false
    if (within(segs, agnesHome) && !skillInside(segs, agnesHome)) return false
    const hidden = within(segs, home) && segs[home.length]?.startsWith('.')
    if (hidden && !skillInside(segs, segs.slice(0, home.length + 1))) return false
    return true
  })
}
