/** Scan rule boundaries without treating quoted URLs or comments as CSS syntax. */
export function cssLayerFindings(source: string, allowedLayers?: readonly string[]): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) =>
    ' '.repeat(value.length),
  )
  const findings: string[] = []
  const walk = (start: number, end: number, layered: boolean) => {
    let cursor = start
    while (cursor < end) {
      const boundary = /[;{}]/g
      boundary.lastIndex = cursor
      const next = boundary.exec(code)
      if (!next || next.index >= end) break
      const header = code.slice(cursor, next.index).trim()
      if (next[0] === ';') {
        if (!layered && header && !/^@(import|layer|source|charset)\b/.test(header)) findings.push(header)
        cursor = next.index + 1
        continue
      }
      if (next[0] === '}') break
      let depth = 1
      let close = next.index + 1
      for (; close < end && depth; close++) {
        if (code[close] === '{') depth++
        if (code[close] === '}') depth--
      }
      if (depth) throw new Error('Unclosed CSS rule')
      if (/^@layer\s+[\w.-]+$/.test(header)) {
        const name = header.replace(/^@layer\s+/, '').split('.')[0] ?? ''
        if (!layered && allowedLayers && !allowedLayers.includes(name)) findings.push(header)
        walk(next.index + 1, close - 1, true)
      } else if (/^@(media|supports|container|scope)\b/.test(header)) walk(next.index + 1, close - 1, layered)
      else if (!layered) findings.push(header)
      cursor = close
    }
  }
  walk(0, code.length, false)
  return findings
}

export function cssLayerOrders(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) =>
    ' '.repeat(value.length),
  )
  const orders: string[] = []
  let depth = 0
  for (const token of code.matchAll(/@layer\s+[\w.\s,-]+;|[{}]/g)) {
    if (token[0] === '{') depth++
    else if (token[0] === '}') depth--
    else if (!depth) orders.push(token[0].replace(/\s+/g, ' ').trim())
  }
  return orders
}
