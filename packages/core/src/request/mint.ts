import type { Seq } from '../types.js'
import type { PromptSection } from './contribute.js'

// The assembled shape core derives and hands to the model layer. It is deliberately not protocol's
// `RequestBody`: this one still carries the ordered prompt sections and the envelope nonce, which
// the wire shape has already flattened into one `system` string and a `derivedHash`. The adapter
// between the two lives on the model side, not here.
export type RequestMessage = {
  role: 'user' | 'assistant' | 'tool'
  seq: Seq
  content: Array<
    | { type: 'text'; text: string }
    // Kept as its own kind rather than folded into `text`: a provider that requires reasoning
    // echoed back beside the tool use it explains needs to know which block it was, and merging it
    // into the visible text would also show the model its own reasoning as something it said.
    | { type: 'thinking'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  >
  // `ordinal` is the turn-wide position the `tool_use_id` was minted from, carried rather than
  // recomputed from an array index downstream: the two disagree the moment one turn has two
  // assistant messages that each asked for a tool.
  toolCalls?: Array<{ toolUseId: string; name: string; args: unknown; ordinal: number }>
}
export type ToolSchema = { name: string; description: string; parameters: unknown }
// Every string below reaches a model. Adding a field here is therefore also a decision about
// neutralisation: `deriveRequest` scrubs each one or names it as an exception, in a list kept beside
// the body assembly, and a test walks a minted body and fails on any string that is neither.
export type RequestBody = {
  kind: 'turn' | 'summary'
  contractId: string | null
  sections: PromptSection[]
  messages: RequestMessage[]
  tools: ToolSchema[]
  model: { slot: string; route: string; model: string }
  nonce: string
  samplingParams?: Record<string, unknown>
  maxTokens?: number
  metadata?: Record<string, unknown>
}

declare const brand: unique symbol
/**
 * A request that went through the one derivation point. The brand symbol is declared here and never
 * exported, so no other module can write the type down; and because a cast could still produce the
 * type, membership is also recorded at runtime, keyed by object identity rather than by shape.
 */
export type LedgerRequest = Readonly<RequestBody> & { readonly [brand]: true }

const minted = new WeakSet<object>()

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as object)) deepFreeze(v)
  }
  return o
}

/**
 * The single construction point for a branded request, and the one place in the package that casts
 * to the branded type — a boundary test counts that cast and fails if a second one appears. The
 * body is cloned before it is frozen so the caller's own object is neither frozen under it nor
 * still reachable as an alias into the minted one.
 */
export function mintFrom(body: RequestBody): LedgerRequest {
  const frozen = deepFreeze(structuredClone(body)) as LedgerRequest
  minted.add(frozen)
  return frozen
}

/**
 * Identity, not shape: an object assembled to look like a request — or a structured clone of a real
 * one — was not derived, so it is not one. That is what makes this worth checking at a seam.
 */
export function isLedgerRequest(x: unknown): x is LedgerRequest {
  return !!x && typeof x === 'object' && minted.has(x)
}
