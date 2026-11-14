// Adapted from oh-my-pi 80ad1d6b2eb3dd916d863841dcae79f4f96c5612.
// See LICENSE.oh-my-pi for the MIT license and copyright notices.
import { redactedRanges } from './redacted-range.js'

export const RAW_EDGE = 262144
const CLEAN_EDGE = 16384
const edges = (text: string, size: number) =>
  text.length <= size * 2 ? text : `${text.slice(0, size)}\n…\n${text.slice(-size)}`
const collapse = (text: string) =>
  text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export function cleanTinyMessage(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escapes are deliberately removed.
  const raw = edges(text, RAW_EDGE).replace(/\u001b\[[0-9;]*m/g, '')
  const stripped = collapse(raw.replace(/```+[\s\S]*?(?:```+|$)/g, ' '))
  const fenced = stripped.length >= 12 ? stripped : raw
  return collapse(
    edges(fenced, CLEAN_EDGE)
      .replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
      .replace(/\b[0-9a-fA-F]{12,}\b/g, (value) => value.slice(0, 7)),
  )
}

/** Full-context masking precedes windows selected in the original source coordinates. */
export function maskedTitleText(text: string, anchor = false): string {
  const range = redactedRanges(text)
  if (anchor) return range(0, Math.min(400, text.length))
  return text.length <= RAW_EDGE * 2
    ? range(0, text.length)
    : `${range(0, RAW_EDGE)}\n…\n${range(text.length - RAW_EDGE, text.length)}`
}

const filler = new Set([
  'hi',
  'hii',
  'hiii',
  'hiya',
  'hey',
  'heya',
  'hello',
  'helo',
  'hullo',
  'yo',
  'ya',
  'sup',
  'wassup',
  'whatsup',
  'howdy',
  'greetings',
  'hola',
  'ciao',
  'aloha',
  'gm',
  'gn',
  'good',
  'morning',
  'afternoon',
  'evening',
  'night',
  'day',
  'thanks',
  'thank',
  'thx',
  'ty',
  'tysm',
  'cheers',
  'please',
  'pls',
  'plz',
  'ok',
  'okay',
  'okey',
  'k',
  'kk',
  'yep',
  'yes',
  'yeah',
  'yup',
  'nope',
  'no',
  'nah',
  'sure',
  'cool',
  'nice',
  'great',
  'awesome',
  'perfect',
  'lol',
  'lmao',
  'haha',
  'hehe',
  'test',
  'tests',
  'testing',
  'ping',
  'pong',
  'there',
  'you',
  'u',
  'hmm',
  'hmmm',
  'um',
  'uh',
  'so',
  'well',
  'anyway',
])
export function isLowSignalTitleInput(text: string): boolean {
  const cleaned = /^\s*<chat>[\s\S]*<\/chat>\s*$/.test(text)
    ? text.replace(/<\/?(?:chat|user|assistant|think)>/g, ' ')
    : cleanTinyMessage(text)
  const tokens = cleaned.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  return !tokens || tokens.every((token) => filler.has(token) || /^\d+$/.test(token))
}
