import { sha256Hex } from '../hash-sha256.js'
import type { Rule } from '../types.js'
import { anthropicInvoke } from './anthropic-invoke.js'
import { hermesToolCall } from './hermes-tool-call.js'
import { inlineJson } from './inline-json.js'
import { qwen3Coder } from './qwen3-coder.js'
import { thinkTag } from './think-tag.js'

/**
 * The frozen order. A native tool call and a reasoning field are structural rather than syntactic -
 * they arrive as their own wire events - so the chain starts at the first thing that has to be read
 * out of prose. Adding a rule or reordering this array changes how every future ledger row was
 * parsed, so PARSER_VERSION moves with it; decode-machine.test.ts asserts both together.
 */
export const RULES: readonly Rule[] = [thinkTag, qwen3Coder, anthropicInvoke, hermesToolCall, inlineJson]

/**
 * Language-neutral digest of the ordered rule contract. The checked-in lock additionally hashes
 * implementation sources and fixtures, so helper or closeAt changes cannot hide behind unchanged
 * regular expressions.
 */
export const RULES_DIGEST = sha256Hex(
  JSON.stringify(
    RULES.map((rule) => ({
      id: rule.id,
      fingerprint: rule.fingerprint,
      open: rule.open.source,
      close: rule.close.source,
      closeAt: rule.closeAt !== undefined,
    })),
  ),
)

/** The rule set a contract stamp reports. It moves with RULES, never with the package version. */
export const PARSER_VERSION = '2'
