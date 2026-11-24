import { type AliasMap, technicalAliases } from './aliases.js'
import { normalize, tokenize } from './tokenize.js'

const stop = new Set(
  [
    'a about after again all also am an and any are as at be because been before being between',
    'both but by can could d did do does doing don down during each few for from further get go',
    'had has have having he her here hers herself him himself his how i if in into is it its',
    'itself just ll m many me might more most much must my myself no nor not now of off on once',
    'only or other our ours ourselves out over own re s same she should so some such t than that',
    'the their theirs them themselves then there these they this those through to too under',
    'until up ve very was we were what when where which while who whom why will with would you',
    'your yours yourself yourselves',
  ]
    .join(' ')
    .split(' '),
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
