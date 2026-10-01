import { createScanner } from 'typescript/unstable/ast/scanner'

export type Edge = { specifier: string; value: boolean }

function at(tokens: readonly string[], index: number): string {
  return tokens[index] ?? ''
}

export function scanTokens(source: string): string[] {
  const scanner = createScanner(true, 0, source)
  const tokens: string[] = []
  for (;;) {
    scanner.scan()
    const text = scanner.getTokenText()
    if (text === '') return tokens
    tokens.push(text)
  }
}

export function quoted(token: string): string | undefined {
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

/** Value edges follow `export *` / `export { } from` and mixed `import { type A, B }`. */
export function importEdges(source: string): Edge[] {
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
