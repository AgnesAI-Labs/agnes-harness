import type { ToolDef, ToolRequestAvailability } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { modelAllowsTool } from '../../step/model-tools.js'
import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { argumentFallback, toolArgumentsDisabled } from '../../step/tool-argument-recovery.js'
import { loadedToolNames } from './tool-disclosure.js'

type SelectionFacts = Readonly<{ imageInput: boolean; defaultSelection: boolean }>
const selections = new WeakMap<object, SelectionFacts>()

/** Facts captured where the request's model and schema selection are resolved, before hooks. */
export function prepareToolAvailability(request: object, facts: SelectionFacts): void {
  selections.set(request, Object.freeze({ ...facts }))
}

/** Budget reminting may replace the request object, but never its schema-selection facts. */
export function bindToolAvailability(prepared: object, wire: RequestBody): void {
  const facts = selections.get(prepared)
  if (facts) selections.set(wire, facts)
}

const requests = new WeakMap<TurnMemory, ReadonlyMap<string, ToolRequestAvailability>>()
const unavailable = (
  reason: NonNullable<ToolRequestAvailability['reason']>,
  next: string,
): ToolRequestAvailability =>
  Object.freeze({
    status: 'unavailable',
    reason,
    message: `Not available in this request (${reason}); ${next}`,
  })

export const modelCapabilityUnavailable = unavailable(
  'model_capability',
  'ask the user to select a model that supports image input; use offered tools meanwhile.',
)

/** Shared with the default schema selector; these restrictions are disclosure, not authorization. */
export function disclosureRestriction(
  s: SessionImpl,
  tool: Pick<ToolDef, 'name'>,
): ToolRequestAvailability | undefined {
  if (toolArgumentsDisabled(s, tool.name)) return unavailable('policy', argumentFallback)
  if (
    (s.preset.disclosure === 'code' && tool.name !== 'run_code') ||
    (s.preset.disclosure !== 'code' && s.preset.disclosure !== 'hybrid' && tool.name === 'run_code')
  )
    return unavailable(
      'mode',
      'use an offered tool, or ask the user to select a compatible disclosure mode/preset.',
    )
  if (
    tool.name === 'compact' &&
    !(s.preset.compaction.enabled && s.preset.compaction.agentCallable && s.compaction.runnable)
  )
    return unavailable(
      'policy',
      'use the current context; compaction must be enabled and runnable before this tool can be offered.',
    )
  return undefined
}

/** Snapshot only after admission, from the exact schemas sent to the provider. No tool selection here. */
export function recordToolAvailability(s: SessionImpl, wire: RequestBody): void {
  if (!s.turn || wire.kind !== 'inference' || wire.slot !== 'primary') return
  const facts = selections.get(wire)
  if (!facts) {
    requests.delete(s.turn)
    return
  }
  const offered = new Set(wire.tools.map((tool) => tool.name))
  const imageInput = facts.imageInput
  const loaded = loadedToolNames(s)
  const view = new Map<string, ToolRequestAvailability>()
  for (const def of s.turn.snapshot.defs) {
    let state: ToolRequestAvailability
    if (offered.has(def.name))
      state = Object.freeze({
        status: 'offered',
        message:
          'Offered in this request; call it directly. Normal validation and authorization still apply.',
      })
    else if (!modelAllowsTool(def, imageInput)) state = modelCapabilityUnavailable
    else if (def.meta.modelVisible === false)
      state = unavailable('policy', 'this tool is not model-visible; use offered tools.')
    else {
      const restriction = facts.defaultSelection ? disclosureRestriction(s, def) : undefined
      if (restriction) state = restriction
      else if (def.meta.deferLoading === true && !loaded.has(def.name) && offered.has('tool_describe'))
        state = Object.freeze({
          status: 'deferred',
          message:
            'Deferred in this request; call tool_describe with this exact name to load it for a subsequent model request. The Loop must include it in that request. Loading grants no permission.',
        })
      else
        state = unavailable(
          'request_selection',
          'use offered tools; the Loop must include this tool in a subsequent request before a direct model call. Do not retry it in this request.',
        )
    }
    view.set(def.name, state)
  }
  requests.set(s.turn, view)
}

/** Missing snapshots (including recovery) are unknown, never a guess based on catalog metadata. */
export function toolAvailability(s: SessionImpl, name: string): ToolRequestAvailability {
  const view = s.turn && requests.get(s.turn)
  return (
    view?.get(name) ??
    (view
      ? unavailable(
          'catalog',
          'this name is outside the frozen turn catalog; use offered tools or refresh discovery in a new turn.',
        )
      : unavailable(
          'unknown',
          'request disclosure is unknown; use the schemas supplied in the current model request and refresh discovery after the next model request.',
        ))
  )
}
