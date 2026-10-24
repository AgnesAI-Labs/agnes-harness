/** Where LaTeX maths sits in Markdown text: the marked inline extension and the display-block matcher. */

export const MATH_FENCES = new Set(['math', 'latex', 'tex'])

// `$…$` is maths only when it cannot be a price or a shell variable: nothing blank inside either `$`,
// no digit right after the closing one, one line, and something in it that only a formula has.
const DOLLAR = /^\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/
const PAREN = /^\\\(([\s\S]+?)\\\)/
const FORMULA = /\\[A-Za-z]|[\^_]/

type MathToken = { type: 'math'; raw: string; text: string }

function inlineMath(src: string): MathToken | undefined {
  const paren = PAREN.exec(src)
  if (paren) return { type: 'math', raw: paren[0], text: paren[1] ?? '' }
  const dollar = DOLLAR.exec(src)
  if (dollar && FORMULA.test(dollar[1] ?? '')) return { type: 'math', raw: dollar[0], text: dollar[1] ?? '' }
  return undefined
}

/** Options for `Lexer.lex` that make `$x^2$` and `\(x\)` come out as `math` tokens. */
export function mathLexerOptions() {
  return {
    gfm: true,
    extensions: {
      renderers: {},
      childTokens: {},
      inline: [(src: string) => inlineMath(src)],
      // An escaped `\$` is for the escape rule, so only a `$` with no backslash before it starts maths.
      startInline: [(src: string) => src.search(/(?<!\\)\$|\\\(/)],
    },
  }
}

/** The formula of a paragraph that is nothing but `$$…$$` or `\[…\]`; unclosed ones are not maths yet. */
export function displayMathSource(raw: string): string | undefined {
  const match = /^\s*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])\s*$/.exec(raw)
  const body = match?.[1] ?? match?.[2]
  return body !== undefined && !body.includes('$$') && body.trim() ? body.trim() : undefined
}
