type CssUrl = { start: number; end: number; url: string }

// CSS escapes can appear in identifiers and URL arguments. A hexadecimal escape consumes
// up to six digits and one following whitespace character (or one CRLF pair).
const cssEscape = String.raw`\\(?:(?:[\da-f]{6}|[\da-f]{1,5}(?![\da-f]))(?:\r\n|[\t\n\f\r ]|(?![\t\n\f\r ]))|[^\da-f\n\f\r])`
const whitespace = String.raw`[\t\n\f\r ]*`
const quoted = String.raw`"(?:\\(?:\r\n|[\s\S])|[^"\\\n\f\r])*"|'(?:\\(?:\r\n|[\s\S])|[^'\\\n\f\r])*'`
const tokens = String.raw`/\*[\s\S]*?(?:\*/|$)|${quoted}|[@#]?(?:[\w\u0080-\uffff-]|${cssEscape})+`
const argument = String.raw`${whitespace}(${quoted}|(?:${cssEscape}|[^\x00-\x20\x7f"'()\\])+)${whitespace}\)`

function unescapeCss(text: string): string {
  return text.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\s\S]))/gi, (_, hex, character) => {
    if (!hex) return /^[\n\f\r]/.test(character) ? '' : character
    const point = Number.parseInt(hex, 16)
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      ? '\uFFFD'
      : String.fromCodePoint(point)
  })
}

/** Find CSS URL tokens without treating strings or comments as active dependencies. */
export function cssUrls(text: string): CssUrl[] {
  if (/@import\b/i.test(text)) throw Error('stylesheet import unavailable')
  const scanner = new RegExp(tokens, 'gi')
  const urlArgument = new RegExp(argument, 'iy')
  const urls: CssUrl[] = []
  for (let token = scanner.exec(text); token; token = scanner.exec(text)) {
    if (/^[/'"]/.test(token[0])) continue
    const name = unescapeCss(token[0]).toLowerCase()
    if (name === '@import') throw Error('stylesheet import unavailable')
    if (name !== 'url' || text[scanner.lastIndex] !== '(') continue
    urlArgument.lastIndex = scanner.lastIndex + 1
    const value = urlArgument.exec(text)?.[1]
    if (!value) continue
    urls.push({
      start: token.index,
      end: urlArgument.lastIndex,
      url: unescapeCss(/^["']/.test(value) ? value.slice(1, -1) : value),
    })
    scanner.lastIndex = urlArgument.lastIndex
  }
  return urls
}

export const cssUrlValue = (url: string) => `url("${url.replace(/["\\]/g, '\\$&')}")`
