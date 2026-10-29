/**
 * A deliberately conservative shell splitter.
 *
 * It accepts exactly one shape: plain words (with single- and double-quoted literals) joined by
 * `&&`, `||`, `;` and `|`. Anything else - substitution, expansion, redirection, grouping, globbing,
 * background `&`, comments, escapes, newlines, an unclosed quote - makes the whole command opaque
 * and the result `undefined`.
 *
 * The two callers use the answer in opposite directions. An allow (a prefix approval) must treat
 * opaque as "not vouched for" and ask. A block list must treat opaque as "still scan the raw text".
 * Parsing failure alone is never a reason to refuse here; that policy belongs to the caller.
 */
const OPERATORS = ['&&', '||', ';', '|'] as const
/** Characters that start a construct this splitter does not model, unquoted. */
const OPAQUE_UNQUOTED = new Set([
  '$',
  '`',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '&',
  '*',
  '?',
  '[',
  '^',
  '%',
  '\\',
  '!',
  '\n',
  '\r',
  '\0',
])
/** Inside double quotes the shell still expands these. */
const OPAQUE_DOUBLE = new Set(['$', '`', '\\', '\n', '\r', '\0'])
/** Words that open shell syntax, or run arbitrary payloads, when they lead a command. */
const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  'time',
  '!',
  '[[',
  ']]',
  'exec',
  'eval',
  'source',
  '.',
  'command',
  'builtin',
])
/** A leading `NAME=value` is an environment assignment, never a plain command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const unusable = (words: string[]): boolean =>
  RESERVED.has(words[0] as string) || ASSIGNMENT.test(words[0] as string)
const BLANK = new Set([' ', '\t'])

export function splitShellCommand(command: string): string[][] | undefined {
  // Only ASCII is understood: typographic quotes and other look-alikes mean different things to
  // different shells, so an allow decision must never rely on how this parser reads them.
  for (let n = 0; n < command.length; n++) if (command.charCodeAt(n) > 0x7f) return undefined
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let lastOp: string | undefined
  let i = 0
  const endWord = (): void => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  while (i < command.length) {
    const ch = command[i] as string
    if (BLANK.has(ch)) {
      endWord()
      i++
      continue
    }
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i))
    if (op) {
      endWord()
      if (words.length === 0 || unusable(words)) return undefined
      commands.push(words)
      words = []
      lastOp = op
      i += op.length
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1)
      if (end < 0) return undefined
      const body = command.slice(i + 1, end)
      if (ch === '"' ? [...body].some((c) => OPAQUE_DOUBLE.has(c)) : /[\n\r\0]/.test(body)) return undefined
      word = (word ?? '') + body
      i = end + 1
      continue
    }
    if (OPAQUE_UNQUOTED.has(ch)) return undefined
    // Tilde and zsh `=cmd` expand at the start of an unquoted word.
    if ((ch === '~' || ch === '=') && word === undefined) return undefined
    // `#` only starts a comment at the start of a word; elsewhere it is an ordinary character.
    if (ch === '#' && word === undefined) return undefined
    word = (word ?? '') + ch
    i++
  }
  endWord()
  if (words.length > 0) {
    if (unusable(words)) return undefined
    commands.push(words)
  }
  // A trailing `&&`, `||` or `|` leaves nothing to run; only a trailing `;` is valid shell.
  else if (commands.length === 0 || lastOp !== ';') return undefined
  return commands
}
