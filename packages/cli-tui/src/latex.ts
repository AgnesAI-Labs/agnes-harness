import {
  ACCENTS,
  BLACKBOARD,
  ESCAPES,
  FUNCTIONS,
  GREEK,
  SPACES,
  SUBSCRIPT,
  SUPERSCRIPT,
  SYMBOLS,
  WRAPPERS,
} from './latex-symbols.js'

/** Thrown inside the parser for anything it cannot turn into text; `renderLatex` turns it into `undefined`. */
class Unsupported extends Error {}
const fail = (why: string): never => {
  throw new Unsupported(why)
}

const SIMPLE = /^[\p{L}\p{N}\p{M}.]+$/u
const BLANK = /\s/

/** `x` when the text is one word, `(x)` when it has operators or spaces. */
const group = (text: string) => (SIMPLE.test(text) ? text : `(${text})`)

function script(text: string, map: ReadonlyMap<string, string>, mark: '^' | '_'): string {
  const compact = text.replace(/\s+/g, '')
  const mapped = [...compact].map((c) => map.get(c))
  if (compact && mapped.every((c) => c !== undefined)) return mapped.join('')
  return [...compact].length === 1 ? `${mark}${compact}` : `${mark}(${text.trim()})`
}

// Model output is untrusted: deep `{{{…` nesting must fall back to the source, not exhaust the stack.
const MAX_DEPTH = 64
const MAX_SOURCE = 4096

class Parser {
  at = 0
  constructor(
    readonly src: string,
    private depth = 0,
  ) {}

  /** Parses up to the closing brace of the current group, or to the end when `top`. */
  expr(top: boolean): string {
    if (++this.depth > MAX_DEPTH) fail('nested too deep')
    try {
      return this.exprBody(top)
    } finally {
      this.depth--
    }
  }

  private exprBody(top: boolean): string {
    let out = ''
    for (;;) {
      const c = this.src[this.at]
      if (c === undefined) return top ? out : fail('unclosed brace')
      if (c === '}') {
        if (top) fail('unbalanced brace')
        this.at++
        return out
      }
      out += this.withScripts()
    }
  }

  /** The text of the next `{…}` group, braces balanced; the outer braces are dropped. */
  raw(): string {
    this.space()
    if (this.src[this.at] !== '{') return fail('expected a group')
    const start = ++this.at
    for (let depth = 1; this.at < this.src.length; this.at++) {
      const c = this.src[this.at]
      if (c === '\\') this.at++
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) return this.src.slice(start, this.at++)
    }
    return fail('unclosed brace')
  }

  space() {
    while (BLANK.test(this.src[this.at] ?? 'x')) this.at++
  }

  /** A group or a single token, rendered as text: the argument of a command or a script. */
  arg(): string {
    this.space()
    const c = this.src[this.at]
    if (c === undefined || c === '}') return fail('missing argument')
    if (c === '{') {
      this.at++
      return this.expr(false)
    }
    return this.atom()
  }

  sub(text: string): string {
    return new Parser(text, this.depth).expr(true)
  }

  withScripts(): string {
    const first = this.src[this.at]
    let out = first === '^' || first === '_' ? '' : this.atom()
    let up: string | undefined
    let down: string | undefined
    for (;;) {
      let next = this.at
      while (BLANK.test(this.src[next] ?? 'x')) next++
      const c = this.src[next]
      if (c !== '^' && c !== '_') break
      this.at = next + 1
      const text = this.arg()
      if (c === '^') up = up === undefined ? text : fail('double superscript')
      else down = down === undefined ? text : fail('double subscript')
    }
    if (down !== undefined) out += script(down, SUBSCRIPT, '_')
    if (up !== undefined) out += script(up, SUPERSCRIPT, '^')
    return out
  }

  atom(): string {
    const c = this.src[this.at++] as string
    if (c === '{') return this.expr(false)
    if (c === '^' || c === '_') return fail('stray script')
    if (c === '~' || BLANK.test(c)) return ' '
    if (c !== '\\') return c
    const start = this.at
    while (/[A-Za-z]/.test(this.src[this.at] ?? '0')) this.at++
    const name = this.at > start ? this.src.slice(start, this.at) : (this.src[this.at++] ?? '')
    return this.command(name)
  }

  command(name: string): string {
    const direct = GREEK.get(name) ?? SYMBOLS.get(name) ?? SPACES.get(name) ?? ESCAPES.get(name)
    if (direct !== undefined) return direct
    if (FUNCTIONS.has(name)) return /[\\A-Za-z0-9]/.test(this.src[this.at] ?? '') ? `${name} ` : name
    if (name === 'left' || name === 'right') {
      if (this.src[this.at] === '.') this.at++
      return ''
    }
    if (name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg') return ''
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const top = this.sub(this.raw())
      const bottom = this.sub(this.raw())
      return `${group(top.trim())}/${group(bottom.trim())}`
    }
    if (name === 'sqrt') {
      this.space()
      let index = ''
      if (this.src[this.at] === '[') {
        const end = this.src.indexOf(']', this.at)
        if (end < 0) fail('unclosed bracket')
        index = script(this.sub(this.src.slice(this.at + 1, end)), SUPERSCRIPT, '^')
        this.at = end + 1
      }
      return `${index}√${group(this.arg().trim())}`
    }
    if (name === 'text') return this.raw()
    if (name === 'mathbb') return [...this.arg()].map((c) => BLACKBOARD.get(c) ?? c).join('')
    if (WRAPPERS.has(name)) return this.arg()
    const mark = ACCENTS.get(name)
    if (mark !== undefined) {
      const text = this.arg()
      return [...text].length === 1 ? text + mark : fail('accent on more than one character')
    }
    return fail(`unknown command \\${name}`)
  }
}

const tidy = (text: string) => text.replace(/ {2,}/g, ' ').trim()

/** The numerator over the denominator, centred, with a rule between. */
function stack(top: string, bottom: string): string {
  const width = Math.max([...top].length, [...bottom].length)
  const centre = (text: string) => ' '.repeat(Math.floor((width - [...text].length) / 2)) + text
  return [centre(top), '─'.repeat(width), centre(bottom)].join('\n')
}

/** `\frac{a}{b}` and nothing else: the one display formula drawn stacked. */
function stackedFraction(src: string): string | undefined {
  const head = /^\s*\\[dt]?frac\s*(?=\{)/.exec(src)
  if (!head) return undefined
  const parser = new Parser(src)
  parser.at = head[0].length
  const top = tidy(parser.sub(parser.raw()))
  const bottom = tidy(parser.sub(parser.raw()))
  parser.space()
  return parser.at < src.length || !top || !bottom ? undefined : stack(top, bottom)
}

/**
 * LaTeX maths as Unicode text for a terminal. `undefined` means "show the source": the formula has a
 * command or a brace this does not understand, and a half-converted result would mislead.
 */
export function renderLatex(src: string, options: { display: boolean }): string | undefined {
  if (src.length > MAX_SOURCE) return undefined
  try {
    const stacked = options.display ? stackedFraction(src) : undefined
    if (stacked !== undefined) return stacked
    return tidy(new Parser(src).expr(true)) || undefined
  } catch {
    // Unsupported syntax, or anything else malformed input provokes: the caller shows the source.
    return undefined
  }
}
