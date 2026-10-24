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

function count(s: string, ch: string): number {
  return s.split(ch).length - 1
}

// Which delimiters the text leaves open. Counting, rather than matching, is deliberate: the input
// is any language at all, and a real parser would have to know which of them are string or comment
// contents. Counts are compared against the original, so a file that was already unbalanced - a
// template fragment, a snippet - is not held to a balance it never had.
function unbalanced(s: string): string[] {
  const bad: string[] = []
  for (const [open, close] of PAIRS) if (count(s, open) !== count(s, close)) bad.push(open)
  if (count(s, '"') % 2 !== 0) bad.push('"')
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
