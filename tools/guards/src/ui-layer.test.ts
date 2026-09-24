import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPackages, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * External UI libraries (antd, @assistant-ui/*) may only be imported inside packages/web-ui.
 *
 * The component boundary makes web-ui the sole owner of those dependencies: every other package consumes components
 * through the @agnes/web-ui export surface. Without this fence the import map and vendor pipeline
 * would have to track per-package UI deps, and the CSP (style-src 'self', no unsafe-inline) means a
 * stray runtime-styled library cannot even load - the fence keeps that failure at integration time
 * instead of at runtime.
 *
 * Scope: source files (src/**​/*.{ts,tsx}) and package.json dependency fields. Vendor entries under
 * packages/web/tools/vendor/ are deliberately NOT exempted: per the wiring manual they re-export
 * from '@agnes/web-ui', never from antd directly.
 *
 * Reverse-check: add a direct Ant Design import outside packages/web-ui/src and this
 * suite must go red; removing it must go green again.
 */

const FORBIDDEN_PREFIXES = ['@assistant-ui/', '@ant-design/']
const FORBIDDEN_EXACT = new Set(['antd'])
const ALLOWED_PKG = '@agnes/web-ui'
const ALLOWED_DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function isExternalUI(specifier: string): boolean {
  if (FORBIDDEN_EXACT.has(specifier)) return true
  return FORBIDDEN_PREFIXES.some((p) => specifier.startsWith(p))
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

function violationsFor(pkgDir: string): string[] {
  const src = join(pkgDir, 'src')
  const out: string[] = []
  if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(IMPORT_RE)) {
        if (m[1] !== undefined && isExternalUI(m[1])) out.push(`${file}: imports ${m[1]}`)
      }
    }
  }
  const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
  for (const field of ALLOWED_DEP_FIELDS) {
    const deps = json[field] as Record<string, string> | undefined
    for (const name of Object.keys(deps ?? {})) {
      if (isExternalUI(name)) out.push(`package.json ${field}: declares ${name}`)
    }
  }
  return out
}

describe('external UI libraries are only imported by the web-ui component layer', () => {
  it('antd / @assistant-ui imports appear only in packages/web-ui', () => {
    const offenders: string[] = []
    for (const pkg of listPackages(root)) {
      if (pkg.name === ALLOWED_PKG) continue
      offenders.push(...violationsFor(pkg.dir).map((v) => `${pkg.name}: ${v}`))
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the web-ui package exists and is registered in the deps allowlist', () => {
    const allow = JSON.parse(
      readFileSync(join(root, 'tools/guards/dependency-allowlist.json'), 'utf8'),
    ) as Record<string, string[]>
    expect(allow[ALLOWED_PKG], 'web-ui missing from dependency-allowlist.json').toBeDefined()
  })
})
