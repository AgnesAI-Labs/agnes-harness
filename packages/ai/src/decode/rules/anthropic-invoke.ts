import { couldOpenWith, type Rule } from '../types.js'
import { coerce } from './qwen3-coder.js'

const PREFIX = '<invoke name="'
const OPEN = /<invoke name="([^"]+)">/
const PARAM = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g

export const anthropicInvoke: Rule = {
  id: 'anthropic_invoke',
  fingerprint: 'anthropic-invoke/v1:named-parameters;json-coerce-or-trimmed-string',
  open: OPEN,
  close: /<\/invoke>/,
  couldOpen: (tail) => couldOpenWith(PREFIX, tail, /^[^"]*(?:")?$/),
  extract(opened, body) {
    const name = OPEN.exec(opened)?.[1]
    if (name === undefined) return null
    const args: Record<string, unknown> = {}
    for (const match of body.matchAll(PARAM)) args[match[1] as string] = coerce(match[2] as string)
    return { name, args }
  },
}
