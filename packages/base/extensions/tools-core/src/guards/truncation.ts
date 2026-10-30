// The guard against the most expensive failure a writing tool has: a model that meant to rewrite a
// file and emitted only part of it. The two signals are cheap and independent - the new content is
// a small fraction of what it replaces, or it closes fewer brackets and quotes than the original
// did - and both are refusals rather than repairs, because the tool cannot know what was dropped.
// It belongs to whole-file rewrites only: `edit` names every byte it removes, so nothing can go
// missing there without the model having written it down.

const PAIRS: Array<[string, string]> = [
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
]

// Below this fraction of the original, a rewrite is treated as a suspected truncation. Sitting
// exactly on it is accepted: shrinking a file by well over half is a normal edit, and the threshold
// only has to catch the case where most of the file is simply gone.
const MIN_RATIO = 0.4

// A conservative lexical scan, not a language parser. Literal contents cannot establish missing
// syntax. Compare with the original so templates/fragments retain their existing imbalance.
function unbalanced(s: string): string[] {
  let code = '',
    quote = '',
    comment = false,
    blockComment = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? ''
    if (comment) {
      if (ch === '\n') comment = false
      continue
    }
    if (blockComment) {
      if (s.startsWith('*/', i)) {
        blockComment = false
        i++
      }
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (s.startsWith(quote, i)) {
        i += quote.length - 1
        quote = ''
      }
      continue
    }
    if (ch === '#' || s.startsWith('//', i)) {
      comment = true
      continue
    }
    if (s.startsWith('/*', i)) {
      blockComment = true
      i++
      continue
    }
    if (ch === "'" && /\w/.test(s[i - 1] ?? '') && /\w/.test(s[i + 1] ?? '')) {
      code += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = s.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch
      i += quote.length - 1
      continue
    }
    // Slash literals can also start statements after a control condition. Do not guess the
    // language/grammar from preceding tokens. Require a closed span with balanced regex groups
    // and character classes, so an incomplete division expression is still checked as code.
    if (ch === '/') {
      let inClass = false,
        groups = 0,
        end = i + 1
      for (; end < s.length && s[end] !== '\n'; end++) {
        if (s[end] === '\\') {
          end++
          continue
        }
        if (s[end] === '[') inClass = true
        if (s[end] === ']') inClass = false
        if (!inClass && s[end] === '(') groups++
        if (!inClass && s[end] === ')' && --groups < 0) break
        if (s[end] === '/' && !inClass) break
      }
      if (s[end] === '/' && !inClass && groups === 0) {
        i = end
        code += 'x'
        continue
      }
    }
    code += ch
  }
  const bad: string[] = []
  for (const [open, close] of PAIRS) if (code.split(open).length !== code.split(close).length) bad.push(open)
  // Single apostrophes and unmatched backticks are ordinary prose too. Preserve the original
  // double-quote signal without introducing a new language-specific quote refusal.
  if (quote.startsWith('"')) bad.push('"')
  return bad
}

export type Truncation =
  | { truncated: false }
  | { truncated: true; kind: 'shrink' | 'unbalanced'; reason: string }

export function looksTruncated(
  oldText: string,
  newText: string,
  opts: { allowShrink?: boolean } = {},
): Truncation {
  // Nothing to compare against: writing into a file that is empty or absent cannot lose anything.
  if (oldText.length === 0) return { truncated: false }
  // Emptying a file is not exempt. It is the shortest kind of short, and an exemption for it let
  // an empty string overwrite any file in the workspace with the guard looking on. Someone who
  // genuinely wants a file emptied says so twice - the content and an explicit `allowShrink` - or
  // removes the content with `edit`; the other direction costs the whole file with no way to tell
  // it happened.
  //
  // `allowShrink` waives the size signal and nothing else. A shrink the model meant (a section
  // deleted, one side of a merge conflict dropped) is still well-formed text, whereas output that
  // stopped part-way is what the balance signal below catches, so a confirmed shrink is still held
  // to it.
  if (!opts.allowShrink && newText.length < MIN_RATIO * oldText.length)
    return {
      truncated: true,
      kind: 'shrink',
      reason: `new content is ${Math.round((100 * newText.length) / oldText.length)}% of the original`,
    }
  const before = new Set(unbalanced(oldText))
  for (const ch of unbalanced(newText))
    if (!before.has(ch)) return { truncated: true, kind: 'unbalanced', reason: `unbalanced ${ch}` }
  return { truncated: false }
}
