import { type AliasMap, technicalAliases } from './aliases.js'
import { normalize, tokenize } from './tokenize.js'

const stop = new Set(
  'a an and are as at be by for from how i in is it of on or that the to was what when where which with'.split(
    ' ',
  ),
)
const quote = (term: string) => `"${term.replaceAll('"', '""')}"`
const expression = (terms: Set<string>) => Array.from(terms).slice(0, 128).map(quote).join(' OR ')

export function buildQuery(input: string, aliases: AliasMap = technicalAliases) {
  const normalized = normalize(input.slice(0, 4096))
  const { english, words, bigrams } = tokenize(normalized)
  const en = new Set(english.filter((term) => !stop.has(term)))
  const cjk = new Set([...words, ...bigrams])
  // Word boundaries keep short aliases such as "ts" out of unrelated words.
  const tokens = normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  const phrase = ` ${tokens.join(' ')} `
  for (const [term, alternatives] of aliases) {
    if (!phrase.includes(` ${term} `) && !en.has(term) && !words.includes(term)) continue
    for (const alternative of alternatives) {
      const expanded = tokenize(alternative)
      if (expanded.english.length) en.add(expanded.english.join(' '))
      for (const word of expanded.words) cjk.add(word)
    }
  }
  return { en: expression(en), cjk: expression(cjk) }
}
