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

// Shared TS source selection for the scope report and the existing repository guards.
export const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx']

// An older comment here claimed the four excludeDirs lists were aligned; in reality there were three
// different lists (this default, plus 'test' added by the scope report, plus 'fixtures' added by the
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
// The scope report includes production code in fixtures/test directories; scope totals are
// informational. Hard file/function gates define their own source coverage.
export const LITERAL_SCAN_EXCLUDE_DIRS = [...DEFAULT_EXCLUDE_DIRS, 'fixtures']

// "Is this a test file" used to be written out separately in each place, and recognised only
// `.test.ts` — so `.test.mts` was counted as source by the scope report and flagged as source by the other
// two guards, asymmetric with SOURCE_EXTENSIONS. Unified into one function: every source extension has
// a corresponding `.test.<ext>`.
export function isTestFile(file: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => file.endsWith(`.test${ext}`))
}

export function listSourceFiles(
  dir: string | readonly string[],
  opts: { excludeDirs?: readonly string[]; extensions?: readonly string[] } = {},
): string[] {
  // extension-api / bridges write a generated/ output directory inside the package, not only gen/, so
  // the default exclusion set covers both.
  const exclude = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS)
  const extensions = opts.extensions ?? SOURCE_EXTENSIONS
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      // Keep following symlinks as before; ordinary entries need no extra filesystem lookup.
      const isDirectory = entry.isSymbolicLink() ? statSync(full).isDirectory() : entry.isDirectory()
      if (isDirectory) {
        if (!exclude.has(entry.name)) walk(full)
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(resolve(full))
      }
    }
  }
  for (const base of typeof dir === 'string' ? [dir] : dir) walk(base)
  return out.sort()
}

/** Handwritten presentation sources use the same fences as TS. Generated clients are byte-budgeted. */
export const PRESENTATION_NAMES = [
  'browser',
  'conversation-ui',
  'navigation-ui',
  'interaction-ui',
  'goal-ui',
  'deliverables-ui',
] as const
export function presentationSourceFiles(root: string): string[] {
  return PRESENTATION_NAMES.flatMap((name) =>
    listSourceFiles(join(root, 'packages/package-manager/bundled-plugins', name), {
      extensions: [...SOURCE_EXTENSIONS, '.js', '.mjs'],
    }),
  ).filter((file) => !file.replaceAll('\\', '/').endsWith('/src/client.js'))
}
