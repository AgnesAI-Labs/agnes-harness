import type { EffectiveEntry } from './experience.js'

/** Words too common to say anything about relevance. Lower-case; matched after splitting. */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our please so some such than that the their them then there these they this ' +
    'those to too up us was we were what when where which while who why will with would you your'
  ).split(' '),
)

/** Scripts written without spaces between words: matched by adjacent character pairs instead. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu

/**
 * The distinct terms of a text: lower-cased words of two or more characters that are not stop words,
 * and, for a run of CJK characters, each pair of adjacent characters (a lone character stands alone).
 */
export function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const [raw] of text.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    if (DENSE.test(raw)) {
      const chars = [...raw]
      if (chars.length === 1) out.add(raw)
      for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`)
      continue
    }
    if (raw.length >= 2 && !STOP_WORDS.has(raw)) out.add(raw)
  }
  return out
}

/** Code-unit order: unlike `localeCompare`, the same on every machine and under every locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Orders entries by how many of the query's terms they share: a term found in the title counts two,
 * one found in the content counts one. Ties go to the entry applied most recently, then to kind and
 * id, so the same input always gives the same order. Deterministic and local: no model is called,
 * and nothing about the order depends on the time or on the process.
 */
export function rankEntries(entries: readonly EffectiveEntry[], query: string): EffectiveEntry[] {
  const wanted = terms(query)
  const scored = entries.map((item) => {
    const title = terms(item.entry.title)
    const content = terms(item.entry.content)
    let score = 0
    for (const term of wanted) score += (title.has(term) ? 2 : 0) + (content.has(term) ? 1 : 0)
    return { item, score }
  })
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.seq - a.item.seq ||
        compare(a.item.entry.kind, b.item.entry.kind) ||
        compare(a.item.entry.id, b.item.entry.id),
    )
    .map(({ item }) => item)
}
