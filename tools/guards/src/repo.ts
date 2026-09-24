import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Package = { name: string; dir: string; json: Record<string, unknown> }

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found')
    dir = parent
  }
  return dir
}

export function listPackages(root: string): Package[] {
  const out: Package[] = []
  for (const group of ['packages', 'tools']) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry)
      const pkgJson = join(dir, 'package.json')
      if (!statSync(dir).isDirectory() || !existsSync(pkgJson)) continue
      const json = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>
      out.push({ name: String(json.name), dir, json })
    }
  }
  return out
}

// Only `.ts` used to be recognised, which made `.mts` / `.cts` / `.tsx` invisible to all three guards
// at once (the line-count ratchet, the single-construction-site check, and the platform scan): a source
// file written as `.mts` could violate any of those three constraints and none of them would see it.
// Widened to a set of source extensions.
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx']

// An older comment here claimed the four excludeDirs lists were aligned; in reality there were three
// different lists (this default, plus 'test' added by the ratchet, plus 'fixtures' added by the
// platform and single-construction-site guards). There are now only the two named constants below, all
// three guards take their list from here, and the comment matches the facts.
//
// DEFAULT: build-output directories that are not source. No guard should scan them.
export const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', 'gen', 'generated']
// LITERAL_SCAN: the two literal-scanning guards look for whether a given literal appears anywhere in
// source. `fixtures/` holds data fixtures where those banned literals appear perfectly legitimately, so
// those two guards exclude it on top of DEFAULT.
// (This comment is itself scanned by those two guards, so it deliberately does not restate the literals
// they look for — writing them out here would trip the guards on this very file.)
// **The line-count ratchet does not use this list**: an excluded directory is an escape hatch from the
// line budget. Measured: 5000 lines of real source in `packages/protocol/src/test/x.ts` left the
// ratchet green with 14 passed.
export const LITERAL_SCAN_EXCLUDE_DIRS = [...DEFAULT_EXCLUDE_DIRS, 'fixtures']

// "Is this a test file" used to be written out separately in each place, and recognised only
// `.test.ts` — so `.test.mts` was counted as source by the ratchet and flagged as source by the other
// two guards, asymmetric with SOURCE_EXTENSIONS. Unified into one function: every source extension has
// a corresponding `.test.<ext>`.
export function isTestFile(file: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => file.endsWith(`.test${ext}`))
}

export function listSourceFiles(dir: string, opts: { excludeDirs?: string[] } = {}): string[] {
  // extension-api / bridges write a generated/ output directory inside the package, not only gen/, so
  // the default exclusion set covers both.
  const exclude = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS)
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) {
        if (!exclude.has(entry)) walk(full)
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
        out.push(resolve(full))
      }
    }
  }
  walk(dir)
  return out.sort()
}
