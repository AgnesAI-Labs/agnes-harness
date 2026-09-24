import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const BARE_ALLOWED = [
  /^@agnes\/sdk(\/.*)?$/,
  /^@agnes\/protocol(\/.*)?$/,
  /^node:/,
  /^marked$/,
  /^get-east-asian-width$/,
]
const IMPORTS = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g

const list = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return list(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })

export function violationFor(rel: string, spec: string): string | null {
  if (!spec.startsWith('.'))
    return BARE_ALLOWED.some((pattern) => pattern.test(spec)) ? null : 'foreign-package'
  const slash = rel.lastIndexOf('/')
  const dir = slash === -1 ? '' : rel.slice(0, slash)
  const target = normalize([dir, spec].filter(Boolean).join('/')).split('\\').join('/')
  return target.startsWith('..') ? 'escapes-package' : null
}

describe('cli tui layering', () => {
  it('uses only its injected SDK and Protocol ports, terminal renderers, and local modules', () => {
    const offenders: string[] = []
    for (const file of list(src)) {
      const rel = relative(src, file).split('\\').join('/')
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(IMPORTS)) {
        const spec = match[1] as string
        const violation = violationFor(rel, spec)
        if (violation) offenders.push(`${rel} -> ${spec} (${violation})`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it.each([
    ['app.ts', '@agnes/resource-control-cli', 'foreign-package'],
    ['app.ts', '@agnes/daemon', 'foreign-package'],
    ['app.ts', '../boot/local.js', 'escapes-package'],
    ['app.ts', '@agnes/sdk', null],
    ['app.ts', '@agnes/protocol/gen/acp.js', null],
    ['app.ts', 'node:process', null],
    ['app.ts', './renderer.js', null],
  ])('%s importing %s has result %s', (rel, spec, result) => {
    expect(violationFor(rel, spec)).toBe(result)
  })
})
