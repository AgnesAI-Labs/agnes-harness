import { couldOpenWith, type Rule } from '../types.js'
import { parseArgs } from './inline-json.js'

const OPEN = '<tool_call>'

export const hermesToolCall: Rule = {
  id: 'hermes_tool_call',
  fingerprint: 'hermes-tool-call/v1:json-object;arguments-args-parameters-input;string-json',
  open: /<tool_call>/,
  close: /<\/tool_call>/,
  couldOpen: (tail) => couldOpenWith(OPEN, tail),
  extract(_opened, body) {
    try {
      const value: unknown = JSON.parse(body.trim())
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const call = value as Record<string, unknown>
      return typeof call.name === 'string' ? { name: call.name, args: parseArgs(call) } : null
    } catch {
      return null
    }
  },
}
