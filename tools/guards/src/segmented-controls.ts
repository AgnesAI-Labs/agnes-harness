/** Segmented is a presentation choice, not a synonym for role=radiogroup. */
function endOf(source: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < source.length; i++) {
    const char = source[i]!
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = ''
    } else if (['"', "'", '`'].includes(char)) quote = char
    else if (source.startsWith('/*', i) || source.startsWith('//', i)) {
      const block = source[i + 1] === '*'
      const end = source.indexOf(block ? '*/' : '\n', i + 2)
      if (end < 0) return source.length - 1
      i = end + (block ? 1 : 0)
    } else if (char === open) depth++
    else if (char === close && --depth === 0) return i
  }
  return source.length - 1
}

function fixedOptions(expression: string, source: string): string | undefined {
  const text = expression.trim().replace(/^\(+\s*/, '')
  if (text.startsWith('[')) return text.slice(1, endOf(text, 0, '[', ']'))
  const constant = /^(\w+)\.map\s*\(/.exec(text)?.[1]
  if (!constant) return undefined
  const declaration = new RegExp(`\\bconst\\s+${constant}\\s*(?::[^=;]+)?=\\s*\\[`).exec(source)
  if (!declaration) return undefined
  const start = declaration.index + declaration[0].length - 1
  return source.slice(start + 1, endOf(source, start, '[', ']'))
}
function optionCount(items: string): number {
  let count = 0
  for (let i = 0; i < items.length; i++) {
    const char = items[i]!
    if (/\s|,/.test(char)) continue
    count++
    // Skip one complete top-level item, including quoted strings and object/array literals.
    if (char === '{' || char === '[' || char === '(')
      i = endOf(items, i, char, char === '{' ? '}' : char === '[' ? ']' : ')')
    else if (char === '"' || char === "'" || char === '`') {
      for (i++; i < items.length; i++) {
        if (items[i] === '\\') i++
        else if (items[i] === char) break
      }
    } else {
      while (i + 1 < items.length && items[i + 1] !== ',') i++
    }
  }
  return count
}

/** Static guard for local call sites; translated label lengths are reviewed in both locales. */
export function segmentedPresentationViolations(source: string): string[] {
  const errors: string[] = []
  const check = (props: string, start: number, reactCall = false) => {
    const line = source.slice(0, start).split('\n').length
    const match = (reactCall ? /\boptions\s*:\s*/ : /\boptions\s*=\s*\{/).exec(props)
    if (!match) {
      errors.push(`${line}: Segmented needs explicit fixed options`)
      return
    }
    const begin = match.index + match[0].length
    const expression = reactCall ? props.slice(begin) : props.slice(begin, endOf(props, begin - 1, '{', '}'))
    const options = fixedOptions(expression, source)
    const count = options === undefined ? undefined : optionCount(options)
    if (count === undefined || /\.\.\./.test(options ?? ''))
      errors.push(`${line}: dynamic/plugin-driven options require a descriptive radio list or Select`)
    else if (count < 2 || count > 5)
      errors.push(`${line}: Segmented requires 2–5 fixed options (found ${count})`)
    if (/\b(?:description|hint|subtext|subText)\s*:|<(?:small|p)\b/.test(expression))
      errors.push(`${line}: option descriptions require a descriptive radio list`)
    for (const literal of expression.matchAll(/\blabel\s*:\s*['"]([^'"\n]+)['"]/g)) {
      const label = literal[1]!
      if (label.includes('\n') || label.length > (/\p{Script=Han}/u.test(label) ? 10 : 20))
        errors.push(`${line}: long option label requires a descriptive radio list or Select`)
    }
  }
  const tags = /<(Segmented|[A-Za-z][\w.]*)\b(?:<[^>]+>)?/g
  for (const tag of source.matchAll(tags)) {
    let end = tag.index! + tag[0].length
    for (; end < source.length && source[end] !== '>'; end++) {
      if (source[end] === '{') end = endOf(source, end, '{', '}')
      else if (source[end] === '"' || source[end] === "'") {
        const quote = source[end]!
        while (++end < source.length && source[end] !== quote) if (source[end] === '\\') end++
      }
    }
    const props = source.slice(tag.index! + tag[0].length, end)
    if (tag[1] === 'Segmented') check(props, tag.index!)
    else if (
      /\brole\s*=.*['"]radiogroup['"]/.test(props) &&
      /\bclassName\s*=.*(?:segmented|sliding)/.test(props)
    )
      errors.push(
        `${source.slice(0, tag.index).split('\n').length}: segmented radio presentation must use shared Segmented`,
      )
  }
  for (const call of source.matchAll(/\bcreateElement\(Segmented,\s*\{/g)) {
    const begin = call.index! + call[0].length - 1
    check(source.slice(begin, endOf(source, begin, '{', '}') + 1), call.index!, true)
  }
  return errors
}
