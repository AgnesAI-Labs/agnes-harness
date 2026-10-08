/**
 * A preset document exactly as it was written, snake_case and all. One field carries a rule the
 * type system cannot state: `approval.command_policy[].argv` matches the already-resolved on-disk
 * path byte for byte. Between resolving and matching, nothing may be percent-decoded and nothing
 * may be NFKC/NFKD-normalised — a single codepoint (U+2025) is enough to walk a pattern that looks
 * airtight. The evaluator lives in src/command-policy.ts; nothing else in this package touches argv.
 */
export type PresetDoc = Record<string, unknown> & { name: string; extends?: string }
