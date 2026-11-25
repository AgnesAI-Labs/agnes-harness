import { createHash } from 'node:crypto'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
export const tokenizerVersion = createHash('sha256')
  .update(`lexical-v1/icu-${process.versions.icu}`)
  .digest('hex')

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

function tokensOf(normalized: string, adjoining?: string[]) {
  const words: string[] = []
  const bigrams: string[] = []
  const english: string[] = []
  // Only segment CJK runs. This also separates adjacent identifiers and Han characters.
  const runs = normalized.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u)
  for (const [index, run] of runs.entries()) {
    if (!cjk.test(run)) {
      for (const word of run.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
        english.push(word[0])
        if (
          (index > 0 && word.index === 0) ||
          (index < runs.length - 1 && word.index + word[0].length === run.length)
        )
          adjoining?.push(word[0])
      }
      continue
    }
    for (const part of segmenter.segment(run)) {
      if (part.isWordLike) words.push(part.segment)
    }
    for (const han of run.matchAll(/\p{Script=Han}+/gu)) {
      let previous = ''
      for (const char of han[0]) {
        if (previous) bigrams.push(previous + char)
        previous = char
      }
    }
  }
  return { english, words, bigrams }
}

export function tokenize(text: string) {
  return tokensOf(normalize(text))
}

export function cjkTokens(text: string): string {
  const normalized = normalize(text)
  if (!cjk.test(normalized)) return ''
  // unicode61 already indexes standalone identifiers, but joins adjoining scripts into one token.
  const adjoining: string[] = []
  const { words, bigrams } = tokensOf(normalized, adjoining)
  return [...words, ...bigrams, ...adjoining].join(' ')
}
