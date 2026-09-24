import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))

const list = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) return list(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })

const sourceFiles = (): Array<{ rel: string; text: string }> =>
  list(src).map((f) => ({ rel: relative(src, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }))

// A bare specifier the fenced layers may name. Everything else -- host, daemon, base, bridges, any
// npm package that is not one of the two leaf renderers -- is a violation.
const BARE_ALLOWED = [
  /^@agnes\/sdk(\/.*)?$/,
  /^@agnes\/protocol(\/.*)?$/,
  /^node:/,
  /^marked$/,
  /^get-east-asian-width$/,
]

/**
 * The rule the fence enforces, as a pure function so it can be exercised on inputs of its own rather
 * than only on whatever happens to be in src/ today. Returns the name of the rule that rejected the
 * import, or null when the import is allowed.
 */
export function violationFor(rel: string, spec: string): string | null {
  if (!rel.startsWith('modes/') && !rel.startsWith('tui/')) return null
  if (!spec.startsWith('.')) return BARE_ALLOWED.some((re) => re.test(spec)) ? null : 'foreign-package'
  const dir = rel.slice(0, rel.lastIndexOf('/'))
  const target = normalize(`${dir}/${spec}`).split('\\').join('/')
  if (target.startsWith('..')) return 'escapes-package'
  if (target.startsWith('tui/')) return null
  if (rel.startsWith('modes/') && target.startsWith('modes/')) return null
  if (target === 'errors.js' || target === 'types.js') return null
  return 'escapes-layer'
}

// Dynamic import is covered as well as the two statement forms: `await import('@agnes/host')` is
// exactly how a fenced file would reach past the fence, and a first draft of this pattern missed it.
// The pattern over-matches by design -- a comment containing `from 'x'` is flagged too -- because a
// fence should err towards refusing.
const IMPORTS = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g

describe('cli layering', () => {
  it('modes/ reach only sdk, protocol, node builtins and their own layer', () => {
    const offenders: string[] = []
    for (const { rel, text } of sourceFiles().filter((file) => file.rel.startsWith('modes/')))
      for (const m of text.matchAll(IMPORTS)) {
        const spec = m[1] as string
        const rule = violationFor(rel, spec)
        if (rule) offenders.push(`${rel} -> ${spec} (${rule})`)
      }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps every legacy tui path as a direct compatibility facade', () => {
    const tuiFiles = sourceFiles().filter((file) => file.rel.startsWith('tui/'))
    expect(tuiFiles.length).toBeGreaterThan(0)
    expect(tuiFiles.map((file) => file.text)).toEqual(tuiFiles.map(() => "export * from '@agnes/cli-tui'\n"))
    expect(sourceFiles().filter((f) => f.rel.startsWith('modes/')).length).toBeGreaterThan(0)
  })

  it.each([
    ['modes/print.ts', '@agnes/host', 'foreign-package'],
    ['modes/print.ts', '@agnes/daemon/local', 'foreign-package'],
    ['modes/print.ts', '@agnes/base', 'foreign-package'],
    ['tui/app.ts', 'yaml', 'foreign-package'],
    ['modes/print.ts', '../boot/local.js', 'escapes-layer'],
    ['modes/print.ts', '../commands/doctor.js', 'escapes-layer'],
    ['modes/print.ts', '../args.js', 'escapes-layer'],
    ['modes/print.ts', '../../../elsewhere.js', 'escapes-package'],
  ])('%s importing %s is rejected by %s', (rel, spec, rule) => {
    expect(violationFor(rel, spec)).toBe(rule)
  })

  it.each([
    ['modes/print.ts', '@agnes/sdk'],
    ['modes/print.ts', '@agnes/protocol'],
    ['modes/print.ts', '@agnes/protocol/gen/acp.js'],
    ['modes/print.ts', 'node:process'],
    ['modes/print.ts', '../tui/render.js'],
    ['modes/print.ts', './text.js'],
    ['modes/print.ts', '../errors.js'],
    ['boot/local.ts', '@agnes/host'],
    ['index.ts', '@agnes/daemon'],
  ])('%s importing %s is allowed', (rel, spec) => {
    expect(violationFor(rel, spec)).toBe(null)
  })

  it('the import regex finds both statement forms, side-effect and dynamic imports', () => {
    const text = "import a from 'x'\nimport type { B } from 'y'\nimport 'z'\nconst c = await import('w')\n"
    expect([...text.matchAll(IMPORTS)].map((m) => m[1])).toEqual(['x', 'y', 'z', 'w'])
  })

  it('a dynamic import of a forbidden package is caught by the sweep, not only by the unit cases', () => {
    const text = "const h = await import('@agnes/host')\n"
    const found = [...text.matchAll(IMPORTS)].map((m) => violationFor('modes/print.ts', m[1] as string))
    expect(found).toEqual(['foreign-package'])
  })
})

// host owns platform detection; nothing in cli may ask the question itself. The repo-wide guard in
// tools/guards covers this too, but that one exempts nothing under packages/cli specifically, so a
// package-local copy is what a cli author sees fail first.
const PLATFORM = /process\.platform|os\.platform\(\)|process\.arch|os\.arch\(\)/

describe('platform detection stays in host', () => {
  it('no source file in cli asks for the platform', () => {
    const hits = sourceFiles()
      .filter((f) => PLATFORM.test(f.text))
      .map((f) => f.rel)
    expect(hits).toEqual([])
  })

  it('the pattern above really matches the spellings it claims to', () => {
    for (const line of ['const p = process.platform', 'os.platform()', 'process.arch', 'os.arch()'])
      expect(PLATFORM.test(line), line).toBe(true)
    expect(PLATFORM.test('const p = hostPlatform()')).toBe(false)
  })
})
