/*!
 * Adapted from DeepSeek Harness.
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const MAX_CONVERSION_DEPTH = 512

/** Elements that never take a closing tag, so they do not grow the lexical stack. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Elements whose contents HTML parses as text until their matching end tag. */
// Turndown's non-scripting DOM parses noscript children as markup.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** Only close an immediately adjacent optional element; never erase nested containers. */
function closeOptionalTop(stack: string[], name: string, closing: boolean): void {
  // HTML implied-end rules do not apply to foreign (SVG/MathML) elements.
  if (stack.includes('svg') || stack.includes('math')) return
  const top = stack.at(-1)
  if (
    (top === 'li' && (closing ? ['ul', 'ol', 'menu'].includes(name) : name === 'li')) ||
    ((top === 'dt' || top === 'dd') && (closing ? name === 'dl' : ['dt', 'dd'].includes(name))) ||
    (top === 'p' && !closing && name === 'p') ||
    (top === 'option' && (closing ? name === 'select' : ['option', 'optgroup'].includes(name)))
  )
    stack.pop()
}

/** Whether a character can occur after a raw-text end-tag name. */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

/** Find the matching raw-text end tag without interpreting markup-like body text. */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return candidate
}

/**
 * Conservatively reject HTML whose lexical element stack crosses the conversion
 * depth ceiling. Skip comments/raw text and account for adjacent optional ends.
 * Other mismatched closing tags cannot erase nested containers: this is a
 * conservative preflight, not a replacement HTML parser.
 *
 * @param html - the decoded HTML body.
 * @returns whether the body crosses {@link MAX_CONVERSION_DEPTH}.
 */
export function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase()
  const openElements: string[] = []
  let offset = 0

  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start === -1) break
    if (html.startsWith('<!--', start)) {
      // Reject malformed/abrupt comment endings rather than skipping live markup.
      const end = html.indexOf('-->', start + 4)
      const alternate = html.indexOf('--!>', start + 4)
      if (
        end === -1 ||
        (alternate !== -1 && alternate < end) ||
        html[start + 4] === '>' ||
        html.startsWith('->', start + 4)
      )
        return true
      offset = end + 3
      continue
    }

    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }

    const name = lowerHtml.slice(nameStart, cursor)
    let quote: '"' | "'" | undefined
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break

    closeOptionalTop(openElements, name, closing)
    if (closing) {
      if (openElements.at(-1) === name) openElements.pop()
    } else {
      // HTML ignores the slash on non-void elements (e.g. <div/> still opens a div).
      if (!VOID_ELEMENTS.has(name)) {
        openElements.push(name)
        if (openElements.length > MAX_CONVERSION_DEPTH) return true
        if (RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}
