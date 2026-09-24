import { couldOpenWith, type Rule } from '../types.js'

const PREFIX = '<function='
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const OPEN = /<function=([A-Za-z_][A-Za-z0-9_]*)>/
const PARAM = /<parameter=([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*?)<\/parameter>/g

/**
 * A parameter value as the model wrote it. A value that parses as JSON is taken at its word, so a
 * number arrives as a number rather than as the string "5000"; anything else stays the text it was,
 * which is what a shell command line or a file path needs.
 */
export function coerce(v: string): unknown {
  const t = v.trim()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

/** Qwen's coder syntax: `<function=name>` with `<parameter=key>` bodies. */
export const qwen3Coder: Rule = {
  id: 'qwen3_coder',
  fingerprint: 'qwen3-coder/v1:named-parameters;json-coerce-or-trimmed-string',
  open: OPEN,
  close: /<\/function>/,
  couldOpen: (tail) => couldOpenWith(PREFIX, tail, NAME),
  extract(opened, body) {
    const name = OPEN.exec(opened)?.[1]
    if (name === undefined) return null
    const args: Record<string, unknown> = {}
    for (const m of body.matchAll(PARAM)) args[m[1] as string] = coerce(m[2] as string)
    return { name, args }
  },
}
