import { canonicalJson, renderRuntimeContext, sha256Hex } from '@agnes/core'
import type { DecisionInputPolicy, InputFact, JsonValue } from '@agnes/jev-runtime'

const CODEC = 'agnes-jev-runtime-context-v1'
const basePolicy = { kind: 'context' as const, replaceKey: 'agnes-runtime-context' }
const object = (value: JsonValue | undefined) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Persist the same sanitized facts language sees, plus the known producer's field ownership. */
export function runtimeContextFact(
  context: Record<string, unknown>,
  seq: number,
  codeContext?: Record<string, unknown>,
): InputFact {
  const text = Object.keys(context).length ? renderRuntimeContext(context) : ''
  // Decode only our fresh canonical rendering, never a historical or extension-authored text block.
  const rendered = (value: Record<string, unknown>): JsonValue =>
    JSON.parse(renderRuntimeContext(value).slice('[runtime context]\n'.length))
  const snapshot = {
    codec: CODEC,
    value: {
      context: rendered(context),
      ...(codeContext === undefined ? {} : { codeContext: rendered(codeContext) }),
    },
  }
  return {
    id: `runtime-context:${seq}:${sha256Hex(canonicalJson({ text, snapshot }))}`,
    source: 'runtime-context',
    content: [{ kind: 'text', text }],
    snapshot,
  }
}

/** Named facts are a Jev-only view. Unknown fields stay intact; no permission is inferred. */
export function jevRuntimeContextPolicy(input: InputFact): DecisionInputPolicy {
  if (input.snapshot?.codec !== CODEC) return basePolicy
  const snapshot = object(input.snapshot.value)
  const context = object(snapshot?.context)
  if (!context) return basePolicy
  const rendered = renderRuntimeContext(context)
  // Replay must not reintroduce strings that language sanitization removed from the same record.
  if (canonicalJson(context) !== rendered.slice('[runtime context]\n'.length)) return basePolicy
  const expected = Object.keys(context).length ? rendered : ''
  if (input.content.length !== 1 || input.content[0]?.kind !== 'text' || input.content[0].text !== expected)
    return basePolicy
  const code = object(snapshot?.codeContext)
  const environment = object(context.environment)
  const facts: Record<string, JsonValue> = { ...context }
  if (environment && code?.environment && canonicalJson(environment) === canonicalJson(code.environment)) {
    // Transport/model identity is useful to language, but is not an execution permission or task fact.
    const { sessionKey: _session, model: _model, route: _route, slot: _slot, ...execution } = environment
    facts.environment = execution
  }
  return { ...basePolicy, presentation: [{ role: 'environment', value: { runtimeContext: facts } }] }
}
