import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * No path in this repository may begin with a tilde.
 *
 * Not a style rule. `~/.agnes` is what a profile's dataDir said, nothing expanded it, and so every
 * run that configured no paths of its own created a **directory literally named `~`** beside the
 * repository and put its session database, its tables and its audit log inside it. Three of those
 * files were committed before anyone noticed, because the failure is silent: a `~` directory works
 * exactly as well as a real one, and only from the directory that made it.
 *
 * The rule is on the path rather than on the code that writes it because there is no single writer.
 * Any unexpanded tilde reaching any filesystem call produces this, and the directory is the one
 * thing every route to the bug has in common.
 */
export function tildeSegment(path: string): string | null {
  for (const segment of path.split(/[/\\]/)) if (segment.startsWith('~')) return segment
  return null
}

/** Every entry under `dir`, as repository-relative paths, skipping build output and git's own store. */
function walk(dir: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const abs = join(dir, entry.name)
    out.push(relative(root, abs).split(sep).join('/'))
    if (entry.isDirectory()) out.push(...walk(abs, skip))
  }
  return out
}

describe('no path in the repository begins with a tilde', () => {
  it('nothing git tracks', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter((p) => p.length > 0)
    expect(tracked.length, 'git ls-files returned nothing, so this guard checked nothing').toBeGreaterThan(0)
    const offenders = tracked.filter((p) => tildeSegment(p) !== null)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // The stronger half: an untracked one is the same bug one commit earlier, and this is the check
  // that goes red on the run that creates it rather than on the review that finds it.
  it('and nothing on disk either, tracked or not', () => {
    const skip = new Set([...DEFAULT_EXCLUDE_DIRS, '.git'])
    const offenders = walk(root, skip).filter((p) => tildeSegment(p) !== null)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it.each([
    ['~', '~'],
    ['~/.agnes/sessions.db', '~'],
    ['packages/cli/~/.agnes', '~'],
    ['a/~b/c', '~b'],
    ['~user/x', '~user'],
  ])('%j is rejected, at segment %j', (path, segment) => {
    expect(tildeSegment(path)).toBe(segment)
  })

  it.each([['packages/cli/src/args.ts'], ['a~b/c'], ['docs/~notes'.replace('~', 'x')], ['']])(
    '%j is allowed',
    (path) => {
      expect(tildeSegment(path)).toBe(null)
    },
  )
})
