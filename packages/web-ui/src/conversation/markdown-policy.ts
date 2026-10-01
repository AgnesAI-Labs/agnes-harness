/** Static transcript policy; no DOM insertion or navigation happens in this module. */
export function escapeMarkdownHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function decodeMarkdownEntities(text: string): string {
  if (!text.includes('&')) return text
  const escapedTags = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return new DOMParser().parseFromString(escapedTags, 'text/html').documentElement.textContent ?? text
}

function hasControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f)
  })
}

/** The old renderer accepts only absolute HTTP(S) destinations and safe heading fragments. */
export function safeMarkdownHref(raw: string): string | undefined {
  const decoded = decodeMarkdownEntities(raw)
  if (decoded.startsWith('#')) {
    try {
      return hasControl(decoded) || hasControl(decodeURIComponent(decoded.slice(1))) ? undefined : decoded
    } catch {
      return undefined
    }
  }
  if (hasControl(decoded)) return undefined
  try {
    const url = new URL(decoded)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Keep an escaped tag together so GFM cannot autolink an URL-shaped attribute inside it. */
export function protectEscapedMarkdownTags(source: string): {
  content: string
  literals: ReadonlyMap<string, string>
} {
  const literals = new Map<string, string>()
  let index = 0
  let prefix = '\uE000AGH_LITERAL_'
  while (source.includes(prefix)) prefix += '_'
  let fence: { char: string; length: number } | undefined
  let inlineTicks = 0
  let content = ''
  for (const line of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    const fenceMark = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line)
    if (fence) {
      content += line
      if (
        fenceMark &&
        fenceMark[1]?.[0] === fence.char &&
        fenceMark[1].length >= fence.length &&
        !fenceMark[2]?.trim()
      )
        fence = undefined
      continue
    }
    if (fenceMark && !inlineTicks) {
      fence = { char: fenceMark[1]?.[0] ?? '', length: fenceMark[1]?.length ?? 0 }
      content += line
      continue
    }
    for (let cursor = 0; cursor < line.length; ) {
      if (line[cursor] === '`') {
        const run = /^`+/.exec(line.slice(cursor))?.[0] ?? '`'
        if (inlineTicks === run.length) inlineTicks = 0
        else if (!inlineTicks && line.indexOf(run, cursor + run.length) >= 0) inlineTicks = run.length
        content += run
        cursor += run.length
        continue
      }
      if (!inlineTicks && line[cursor] === '\\' && line[cursor + 1] === '<') {
        const match = /^\\<[^>\n]*(?:>|(?=\n|$))/.exec(line.slice(cursor))
        if (match) {
          const key = `${prefix}${index++}\uE001`
          literals.set(key, match[0].slice(1))
          content += key
          cursor += match[0].length
          continue
        }
      }
      content += line[cursor++]
    }
  }
  return { content, literals }
}
