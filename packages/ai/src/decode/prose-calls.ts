import type { DecodeRule, ModelRecord } from '@agnes/protocol'

/**
 * Model families known to write a call into their answer text even on a route that carries calls
 * natively. Qwen is one: the L1 replay case `0011-qwen-call-in-text` is a Qwen answer whose call came
 * as `<function=read><parameter=path>…</parameter></function>` text - the syntax of the Qwen3-Coder
 * chat template - and a shipped route serving Qwen must keep turning it into the call it was. A family
 * joins this list on such evidence only; every other native model gets no prose recovery.
 */
const PROSE_CALL_FAMILIES: readonly { family: RegExp; rules: readonly DecodeRule[] }[] = [
  { family: /qwen/i, rules: ['qwen3_coder'] },
]

/** What a catalogue record served over a native tool-calling wire declares for this model id. */
export function nativeToolCallFormats(modelId: string): ModelRecord['toolCallFormats'] {
  return ['native', ...(PROSE_CALL_FAMILIES.find((f) => f.family.test(modelId))?.rules ?? [])]
}

/** The rules whose captures may become calls: the text formats a record lists, and nothing else. */
export function proseCallRules(formats: ModelRecord['toolCallFormats']): DecodeRule[] {
  return formats.filter((f): f is DecodeRule => f !== 'native')
}
