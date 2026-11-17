import { redactedRanges } from './redacted-range.js'

// Cleanup helpers for title-related text: mask credentials, strip noise, classify trivial prompts.

/** Half-width (UTF-16 units) kept at each end of very large raw inputs. */
export const RAW_EDGE = 262144
/** Half-width kept at each end of the text handed to the finer cleanup passes. */
const CLEAN_EDGE = 16384
/** Marker placed where the middle of an over-long text was cut away. */
const CUT_MARK = '\n…\n'
/** A fence-free result shorter than this falls back to the raw text. */
const MIN_DEFENCED = 12

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes start with the ESC byte.
const SGR = /\u001b\[[0-9;]*m/g
const FENCE = /`{3,}[\s\S]*?(?:`{3,}|$)/g
const BLANKS = /[ \t]+/g
const EMPTY_LINES = /\n{3,}/g
const WRAPPED = /<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g
const HEX_RUN = /\b[0-9A-Fa-f]{12,}\b/g
const ENVELOPE = /^\s*<chat>[\s\S]*<\/chat>\s*$/
const ENVELOPE_TAG = /<\/?(?:chat|user|assistant|think)>/g
const WORD = /[\p{L}\p{N}]+/gu
const ASCII_NUMBER = /^[0-9]+$/

const FILLER = new Set(
  (
    'hi hii hiii hiya hey heya hello helo hullo yo ya sup wassup whatsup howdy greetings hola ciao aloha gm gn ' +
    'good morning afternoon evening night day thanks thank thx ty tysm cheers please pls plz ok okay okey k kk ' +
    'yep yes yeah yup nope no nah sure cool nice great awesome perfect lol lmao haha hehe test tests testing ' +
    'ping pong there you u hmm hmmm um uh so well anyway'
  ).split(' '),
)

/** Keep `half` units from each end with a cut mark between them, when the text exceeds twice that. */
function keepEnds(text: string, half: number): string {
  if (text.length <= half * 2) return text
  return text.slice(0, half) + CUT_MARK + text.slice(text.length - half)
}

/** Collapse spaces/tabs, cap blank-line runs at one empty line, and trim both ends. */
function tidy(text: string): string {
  return text.replace(BLANKS, ' ').replace(EMPTY_LINES, '\n\n').trim()
}

export function cleanTinyMessage(text: string): string {
  const raw = keepEnds(text, RAW_EDGE).replace(SGR, '')
  const unfenced = tidy(raw.replace(FENCE, ' '))
  const basis = unfenced.length >= MIN_DEFENCED ? unfenced : raw
  return tidy(
    keepEnds(basis, CLEAN_EDGE)
      .replace(WRAPPED, ' ')
      .replace(HEX_RUN, (run) => run.slice(0, 7)),
  )
}

export function maskedTitleText(text: string, anchor = false): string {
  const read = redactedRanges(text)
  if (anchor) return read(0, Math.min(400, text.length))
  if (text.length <= 2 * RAW_EDGE) return read(0, text.length)
  return read(0, RAW_EDGE) + CUT_MARK + read(text.length - RAW_EDGE, text.length)
}

export function isLowSignalTitleInput(text: string): boolean {
  const normalized = ENVELOPE.test(text) ? text.replace(ENVELOPE_TAG, ' ') : cleanTinyMessage(text)
  const words = normalized.toLowerCase().match(WORD) ?? []
  return words.every((word) => FILLER.has(word) || ASCII_NUMBER.test(word))
}
