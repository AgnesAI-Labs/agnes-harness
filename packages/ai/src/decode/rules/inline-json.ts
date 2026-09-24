import type { Rule } from '../types.js'
import { parseLenient } from './lenient-json.js'

export function parseArgs(call: Record<string, unknown>): unknown {
  const raw = call.arguments ?? call.args ?? call.parameters ?? call.input ?? {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Returns the inclusive index of the brace that closes the root object, or -1 while incomplete. */
export function balancedClose(text: string): number {
  let depth = 0
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function couldOpenInline(tail: string): boolean {
  const withoutLeadingNewline = tail.startsWith('\n') ? tail.slice(1) : tail
  if (withoutLeadingNewline.includes('\n')) return false
  const compact = withoutLeadingNewline.replace(/[ \t]/g, '')
  return ['{"name":', "{'name':"].some((candidate) => candidate.startsWith(compact))
}

// Multiline `^` asserts the line boundary without consuming its newline, so prose keeps the exact
// line break that introduced the call.
const OPEN = /^[ \t]*\{\s*(["'])name\1\s*:/m

export const inlineJson: Rule = {
  id: 'inline_json',
  fingerprint:
    'inline-json/v2:line-start;single-or-double-name;balanced-braces;strict-then-lenient;python-literals;trailing-commas',
  open: OPEN,
  // The machine uses closeAt for this rule; close remains part of the rule's public fingerprint.
  close: /}/,
  couldOpen: couldOpenInline,
  closeAt: balancedClose,
  extract(opened, body) {
    const text = `${opened.replace(/^\s*/, '')}${body}}`
    try {
      const value: unknown = JSON.parse(text)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const call = value as Record<string, unknown>
        return typeof call.name === 'string' ? { name: call.name, args: parseArgs(call) } : null
      }
    } catch {
      // The strictly parsed form gets first refusal; the explicit fallback reports its own rule id.
    }
    const call = parseLenient(text)
    return call && typeof call.name === 'string'
      ? { name: call.name, args: parseArgs(call), via: 'lenient_json' }
      : null
  },
}
