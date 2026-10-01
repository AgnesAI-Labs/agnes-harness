/** JSON.parse checks grammar; this pass also rejects duplicate raw object keys. */
export function parseAuthorSchemaJson(text: string): unknown {
  const value: unknown = JSON.parse(text)
  let at = 0
  const space = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++
  }
  const string = (): string => {
    const start = at++
    while (at < text.length) {
      const character = text[at++]
      if (character === '\\') at++
      else if (character === '"') break
    }
    return JSON.parse(text.slice(start, at)) as string
  }
  const scan = (depth = 0): void => {
    if (depth > 128) throw new RangeError('JSON source depth quota')
    space()
    if (text[at] === '{') {
      at++
      space()
      const keys = new Set<string>()
      if (text[at] === '}') {
        at++
        return
      }
      while (at < text.length) {
        space()
        const key = string()
        if (keys.has(key)) throw new TypeError('Duplicate JSON object key')
        keys.add(key)
        space()
        at++
        scan(depth + 1)
        space()
        if (text[at++] === '}') return
      }
    } else if (text[at] === '[') {
      at++
      space()
      if (text[at] === ']') {
        at++
        return
      }
      while (at < text.length) {
        scan(depth + 1)
        space()
        if (text[at++] === ']') return
      }
    } else if (text[at] === '"') string()
    else while (at < text.length && !/[\s,}\]]/.test(text[at] as string)) at++
  }
  scan()
  return value
}
