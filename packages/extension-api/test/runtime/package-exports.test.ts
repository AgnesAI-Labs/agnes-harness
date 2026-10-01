import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { describe, expect, it } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))

type Edge = { specifier: string; value: boolean }

/**
 * Concrete names exported by the runtime entry are not pinned here. They stay editable until the
 * public surface is frozen; this file only checks that every `exports` target exists and that the
 * `./runtime` value-import closure stays inside this package and `@agnes/protocol`.
 */

function at(tokens: readonly string[], index: number): string {
  return tokens[index] ?? ''
}

function scanTokens(source: string): string[] {
  const scanner = createScanner(true, 0, source)
  const tokens: string[] = []
  for (;;) {
    scanner.scan()
    const text = scanner.getTokenText()
    if (text === '') return tokens
    tokens.push(text)
  }
}

function quoted(token: string): string | undefined {
  if (
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2)
  ) {
    return token.slice(1, -1)
  }
  if (token.startsWith('`') && token.endsWith('`') && token.length >= 2 && !token.includes('${')) {
    return token.slice(1, -1)
  }
  return undefined
}

function importEdges(source: string): Edge[] {
  const tokens = scanTokens(source)
  const edges: Edge[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = at(tokens, index)
    const next = at(tokens, index + 1)
    if (token === 'require' && at(tokens, index - 1) !== '.' && next === '(') {
      const specifier = quoted(at(tokens, index + 2))
      if (specifier !== undefined) edges.push({ specifier, value: true })
      continue
    }
    if (token === 'import' && next !== '.') {
      if (next === '(') {
        const specifier = quoted(at(tokens, index + 2))
        if (specifier !== undefined) edges.push({ specifier, value: true })
        continue
      }
      const side = quoted(next)
      if (side !== undefined) {
        edges.push({ specifier: side, value: true })
        continue
      }
      const edge = importClause(tokens, index + 1)
      if (edge) edges.push(edge)
      continue
    }
    if (token === 'export') {
      const edge = exportClause(tokens, index + 1)
      if (edge) edges.push(edge)
    }
  }
  return edges
}

function importClause(tokens: readonly string[], start: number): Edge | undefined {
  let index = start
  let typeOnly = false
  if (at(tokens, index) === 'type' && at(tokens, index + 1) !== 'from') {
    typeOnly = true
    index++
  }
  let namedValue = false
  let sawBrace = false
  if (!['{', '*', 'from'].includes(at(tokens, index))) {
    if (!typeOnly) namedValue = true
    index++
    if (at(tokens, index) === ',') index++
  }
  if (at(tokens, index) === '*') {
    if (!typeOnly) namedValue = true
    index++
    if (at(tokens, index) === 'as') index += 2
  }
  if (at(tokens, index) === '{') {
    sawBrace = true
    const named = namedBindings(tokens, index, typeOnly)
    index = named.index
    if (named.value) namedValue = true
  }
  if (at(tokens, index) !== 'from') return undefined
  const specifier = quoted(at(tokens, index + 1))
  if (specifier === undefined) return undefined
  return { specifier, value: typeOnly ? false : sawBrace ? namedValue : true }
}

function exportClause(tokens: readonly string[], start: number): Edge | undefined {
  let index = start
  let typeOnly = false
  if (at(tokens, index) === 'type' && ['{', '*'].includes(at(tokens, index + 1))) {
    typeOnly = true
    index++
  }
  let namedValue = false
  if (at(tokens, index) === '*') {
    namedValue = !typeOnly
    index++
    if (at(tokens, index) === 'as') index += 2
  } else if (at(tokens, index) === '{') {
    const named = namedBindings(tokens, index, typeOnly)
    index = named.index
    namedValue = named.value
  } else {
    return undefined
  }
  if (at(tokens, index) !== 'from') return undefined
  const specifier = quoted(at(tokens, index + 1))
  if (specifier === undefined) return undefined
  return { specifier, value: typeOnly ? false : namedValue }
}

function namedBindings(
  tokens: readonly string[],
  start: number,
  typeOnly: boolean,
): { index: number; value: boolean } {
  let index = start + 1
  let value = false
  while (index < tokens.length && at(tokens, index) !== '}') {
    const before = index
    let bindingIsType = typeOnly
    if (at(tokens, index) === 'type') {
      bindingIsType = true
      index++
    }
    if (!bindingIsType && ![',', '}'].includes(at(tokens, index))) value = true
    if (![',', '}'].includes(at(tokens, index))) index++
    if (at(tokens, index) === 'as') index += 2
    if (at(tokens, index) === ',') index++
    if (index === before) index++
  }
  if (at(tokens, index) === '}') index++
  return { index, value }
}

function exportTargets(exportsField: unknown): { key: string; target: string }[] {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    throw new Error('package exports must be an object')
  }
  return Object.entries(exportsField).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error(`${key} does not point at one file`)
    return { key, target: value }
  })
}

function resolveSource(fromFile: string, specifier: string): string | undefined {
  const raw = resolve(dirname(fromFile), specifier)
  const candidates = [
    raw,
    raw.replace(/\.js$/, '.ts'),
    raw.replace(/\.js$/, '.tsx'),
    raw.replace(/\.js$/, '.mts'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function isProtocolSpecifier(specifier: string): boolean {
  return specifier === '@agnes/protocol' || specifier.startsWith('@agnes/protocol/')
}

/** Follow value imports of `entry`. Stop at `@agnes/protocol`. Do not read that package's dependencies. */
function runtimeClosureProblems(packageRoot: string, entry: string): string[] {
  const start = resolve(packageRoot, entry)
  const problems: string[] = []
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file)) {
      problems.push(`${posix(relative(packageRoot, file))}: missing`)
      continue
    }
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      if (!edge.value) continue
      if (isProtocolSpecifier(edge.specifier)) continue
      if (edge.specifier.startsWith('.')) {
        const next = resolveSource(file, edge.specifier)
        const rel = next === undefined ? edge.specifier : posix(relative(packageRoot, next))
        if (next === undefined || rel.startsWith('..')) {
          problems.push(`${posix(relative(packageRoot, file))}: value-imports ${edge.specifier}`)
          continue
        }
        queue.push(next)
        continue
      }
      problems.push(`${posix(relative(packageRoot, file))}: value-imports ${edge.specifier}`)
    }
  }
  return problems
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function withPackage(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-runtime-closure-'))
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('extension-api public exports', () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { exports?: unknown }
  const targets = exportTargets(manifest.exports)

  it('points every exports target at a file that exists', () => {
    const missing = targets.filter((item) => !existsSync(resolve(packageDir, item.target)))
    expect(missing, missing.map((item) => `${item.key} -> ${item.target}`).join('\n')).toEqual([])
  })

  it('keeps the ./runtime value-import closure inside this package and @agnes/protocol', () => {
    const runtime = targets.find((item) => item.key === './runtime')
    if (runtime === undefined) throw new Error('public ./runtime entry is missing')
    const problems = runtimeClosureProblems(packageDir, runtime.target)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a value import of @agnes/host and ignores a type-only import', () => {
    withPackage(
      {
        'src/runtime/index.ts':
          "export { value } from './value.js'\nexport type { TypeOnly } from './type-only.js'\n",
        'src/runtime/value.ts': "export { host } from '@agnes/host'\n",
        'src/runtime/type-only.ts': "import type { Host } from '@agnes/host'\nexport type TypeOnly = Host\n",
      },
      (dir) => {
        const problems = runtimeClosureProblems(dir, './src/runtime/index.ts')
        expect(problems.join('\n')).toContain('@agnes/host')
        expect(problems.join('\n')).not.toContain('type-only.ts')
      },
    )
  })

  it('rejects a value import that leaves the package and stops at @agnes/protocol', () => {
    withPackage(
      {
        'src/runtime/index.ts':
          "export { outside } from '../../other/outside.js'\nexport { wire } from '@agnes/protocol/runtime'\n",
        'src/runtime/cycle-a.ts': "export { b } from './cycle-b.js'\n",
        'src/runtime/cycle-b.ts': "export { a } from './cycle-a.js'\n",
      },
      (dir) => {
        const escaped = runtimeClosureProblems(dir, './src/runtime/index.ts')
        expect(escaped.join('\n')).toContain('../../other/outside.js')
        expect(escaped.join('\n')).not.toContain('@agnes/protocol/runtime')
        expect(runtimeClosureProblems(dir, './src/runtime/cycle-a.ts')).toEqual([])
      },
    )
  })
})
