import { createHash } from 'node:crypto'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
export const tokenizerVersion = createHash('sha256')
  .update(`lexical-v1/icu-${process.versions.icu}`)
  .digest('hex')

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

export function tokenize(text: string) {
  const normalized = normalize(text)
  const words: string[] = []
  const bigrams: string[] = []
  const english: string[] = []
  // Only segment CJK runs. This also separates adjacent identifiers and Han characters.
  for (const run of normalized.split(
    /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u,
  )) {
    if (!cjk.test(run)) {
      for (const word of run.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) english.push(word[0])
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

export function cjkTokens(text: string): string {
  if (!cjk.test(text.normalize('NFKC'))) return ''
  const { words, bigrams } = tokenize(text)
  return [...words, ...bigrams].join(' ')
}
