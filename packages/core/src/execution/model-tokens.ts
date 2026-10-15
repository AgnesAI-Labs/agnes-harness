// Unicode ranges commonly rendered as one glyph per character rather than composed from a small
// alphabet: CJK ideographs and their punctuation, the two Japanese syllabaries, Hangul syllables,
// and full-width forms. A four-characters-per-token divisor is calibrated on Latin script;
// applying it to these ranges silently underprices a token count by roughly half, since a real
// tokenizer spends closer to one token per one to two such characters.
const CJK_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힣]/

/**
 * Four ASCII/Latin characters to a token, roughly 1.7 CJK-range characters to a token: the estimate
 * used where no usage row has been reported yet. Counted per code point rather than assumed from
 * the string's dominant script, because a tool result or a user message commonly mixes both — a
 * file path and a Chinese comment in the same diff, for instance — and a single global divisor
 * would misprice whichever script is the minority in that particular string.
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.7 + other / 4)
}
