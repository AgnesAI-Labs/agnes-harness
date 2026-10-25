import type { DecodeRule } from '@agnes/protocol'

export type DecodeInput = { kind: 'text' | 'thinking'; delta: string }
export type DecodeContext = { toolNames: readonly string[]; nextOrdinal: () => number }
export type Extracted = { name: string; args: unknown; via?: DecodeRule } | { thinking: string } | null

/**
 * One recovery syntax. `open` and `close` bracket a capture; `extract` turns the captured body into
 * either a call or a block of thinking, and `null` when the body did not parse as either.
 *
 * `couldOpen` is the half that makes streaming work. A chunk boundary can fall anywhere, including
 * in the middle of an opening tag, so the machine asks each rule whether a run of characters sitting
 * at the end of the buffer could still grow into its `open`. Deriving that from the `open` pattern
 * itself is not possible for a rule whose tag carries a name, so each rule answers for itself.
 */
export interface Rule {
  // `think_tag` is one of protocol's own DecodeRule values, so `via` names it directly rather than
  // carrying a union that adds it back on the side.
  id: DecodeRule
  /** Stable summary of extraction semantics; source and fixture digests provide the mechanical pin. */
  fingerprint: string
  open: RegExp
  close: RegExp
  couldOpen(tail: string): boolean
  /** Optional delimiter finder for formats whose close depends on nesting rather than a token. */
  closeAt?(captured: string): number
  extract(opened: string, body: string): Extracted
}

/**
 * Whether `tail` could still grow into an opening tag that starts with `prefix`. Two ways it can:
 * the tail is a leading slice of the prefix and the rest has yet to arrive, or the prefix is
 * complete and what follows it is a partial version of whatever `rest` accepts - a tool name being
 * spelled out, say, whose closing bracket is in the next chunk.
 */
export function couldOpenWith(prefix: string, tail: string, rest?: RegExp): boolean {
  if (prefix.startsWith(tail)) return true
  if (rest === undefined || !tail.startsWith(prefix)) return false
  return rest.test(tail.slice(prefix.length))
}

export type DecodeState = {
  mode: 'IDLE' | 'FENCE' | 'CAPTURE'
  pending: string
  source: 'text' | 'thinking'
  capture?: { rule: Rule; opened: string }
}

/**
 * How much unemitted text may sit in the buffer waiting to see whether it is the start of a tag.
 * A partial tag longer than this is released as ordinary text instead: a decoder that held back
 * without limit would turn a model that writes a long `<function=` -like string into a stream that
 * emits nothing.
 */
export const TAIL_MAX = 32

/** How long a capture may grow before it is abandoned and flushed as text. */
export const CAPTURE_MAX = 65_536
