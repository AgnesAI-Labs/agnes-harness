// Invisible and format characters, removed so a later pattern sees the text reassembled rather than
// split across something the model never renders. Widened past the zero-width four to the families
// that also disappear at display: soft hyphen, the combining grapheme joiner, bidi marks and
// isolates, Mongolian and standard variation selectors, the Hangul fillers, and the Unicode tag
// block — `</untr\u00ADusted>` reaches a model as a visually perfect closing delimiter. This is not
// a completeness claim; the set of characters a renderer swallows is not closed and chasing it is
// unwinnable. What ends that race is the id: a delimiter without it is not a delimiter.
// The class holds combining members — CGJ, the variation selectors — on purpose: they are removal
// targets in their own right, matched one code point at a time, never paired with a base character.
const ZERO_WIDTH =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: see above
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{1D173}-\u{1D17A}]|[\u{E0000}-\u{E0FFF}]/gu
// Digits and hyphens included: `<|reserved_0|>` and `<|a-b|>` are real tokens, and a pattern that
// knew only letters and underscores passed them straight through.
const SPECIAL_TOKEN = /<\|[a-z0-9_-]{1,64}\|>/gi
// Any spelling of the envelope's own tag, in two alternatives that between them cover every
// position where a `<` begins something tag-shaped.
//
// The second alternative is an ordinary complete tag, spaces around the slash included, replaced
// whole. The first is the tag prefix that never closes — `x<untrusted id="`. Such a prefix is not
// yet a tag, so a pattern that required a `>` passed it through, and then concatenating the real
// closing delimiter supplied the missing `>` and fused payload and harness delimiter into one
// opening tag that had swallowed the closer; the region never visibly closed and every later
// message read as untrusted data.
//
// The prefix alternative consumes only the `<`, by lookahead. Consuming the run instead deletes
// from `<untrusted` to wherever the run is declared to end, and on the trusted paths that is a
// content-deletion primitive rather than a defence: one AGENTS.md entry ending `<untrusted`
// swallowed every later harness instruction, a summary history was truncated from its first
// `<untrusted`, and the runtime-context blob was left as syntactically invalid JSON. Neutralising
// the `<` alone breaks the fusion just as completely — the payload's `<` no longer exists to meet
// the harness's `>` — and keeps the prose that followed it.
//
// **The bound lives in the first alternative's negative lookahead, and that is the whole of it.**
// `(?![^>\n]{0,200}>)` asks whether a `>` is reachable on this line within 200 characters. If it is
// not, the first alternative wins and takes the single `<`; the second is never tried. `[^>\n]`
// rather than `[^>]`, because `.`-like classes match newlines and a run reaching for a `>` on a
// later line deletes every line between — an AGENTS.md generic two entries down used to delete the
// instruction between. `{0,200}` rather than `*`, because a tag whose attributes run past 200
// characters is not a tag anyone writes, and past the bound the text is prose.
//
// The second alternative repeats the same class and bound so the two read as one run, but they are
// **redundant there** and stated as such rather than left to look load-bearing: it only ever runs
// when the lookahead has already found a `>` on this line within the bound, and the nearest `>` in
// the string is then that one, so `[^>]*` would match the same span. Mutating that half alone fails
// nothing, and a comment claiming otherwise would be the exception-list failure over again.
//
// So the largest span this pattern can delete is one tag on one line, and everything a payload can
// do to widen it — a newline, a longer run, a `>` further down the file — moves it to the first
// alternative, which takes one character. Suppression is the failure mode here (see the suppression
// class in the tests), and it is bounded by construction rather than by the fixtures happening to
// hold no later `>`. What is *not* bounded away is a complete tag inside one line of prose: that
// span is still replaced whole, because the same characters are a tag to delete and prose to keep
// and no pattern can tell. The one place that mattered — the runtime-context blob, one line by
// construction — is fixed below by scrubbing its values before they are serialised.
//
// The two alternatives are exhaustive and disjoint: after `<...untrusted` either a `>` follows on
// the same line within the bound (second) or it does not (first), so no tag-shaped run falls
// between them and none is matched by both.
const ENVELOPE_TAG = /<(?=\s*\/?\s*untrusted\b)(?![^>\n]{0,200}>)|<\s*\/?\s*untrusted\b[^>\n]{0,200}>/gi
// Neutralised text is replaced, not deleted. Deleting is what let a payload reassemble a tag out of
// its own fragments: removing an inner match splices the surrounding characters together behind the
// cursor, and a single left-to-right pass never looks there again. A non-empty replacement holding
// no `<`, `>` or `|` cannot become part of any pattern here, so one pass is already a fixed point —
// and it leaves the model a visible trace of what was taken out.
const TAG_MARK = '[removed:untrusted-tag]'
const TOKEN_MARK = '[removed:special-token]'

function scrubOnce(text: string): string {
  // Ordered: zero-width removal is the one deletion left, so it runs first and every later pattern
  // sees the text reassembled rather than split across an invisible character.
  return text.replace(ZERO_WIDTH, '').replace(SPECIAL_TOKEN, TOKEN_MARK).replace(ENVELOPE_TAG, TAG_MARK)
}

/**
 * Strips what a payload could use to impersonate the harness's own framing: zero-width characters,
 * chat-template special tokens, and every spelling of the envelope tag. Run to a fixed point rather
 * than once — the loop settles on its second iteration by construction, and the bound is there so
 * no input can make it run long.
 */
export function sanitize(text: string): string {
  let cur = text
  for (let i = 0; i < 8; i++) {
    const next = scrubOnce(cur)
    if (next === cur) break
    cur = next
  }
  return cur
}
