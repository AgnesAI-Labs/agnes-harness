import { couldOpenWith, type Rule } from '../types.js'

const PREFIX = '<think>'

/** A reasoning block written into the text stream, which leaves as thinking rather than as prose. */
export const thinkTag: Rule = {
  id: 'think_tag',
  fingerprint: 'think-tag/v1:body-as-thinking',
  open: /<think>/,
  close: /<\/think>/,
  couldOpen: (tail) => couldOpenWith(PREFIX, tail),
  extract: (_opened, body) => ({ thinking: body }),
}
