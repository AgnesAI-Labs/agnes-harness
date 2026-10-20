import type { EventInput } from '@agnes/core-common/types'
import type { JsonValue } from '@agnes/protocol'
import {
  type ResolvedToolPolicyEnvelope,
  resolveValidatedToolCallPolicy,
} from '../../registry/tool-policy.js'
import type { SessionImpl } from '../../step/session.js'
import { toolArgumentError } from '../../step/tool-args.js'
import {
  argumentFallback,
  recordToolArgumentCheck,
  toolArgumentsDisabled,
} from '../../step/tool-argument-recovery.js'
import { toolAvailability } from './tool-availability.js'

type Refusal = {
  code:
    | 'TOOL_NOT_FOUND'
    | 'TOOL_ARGS_INVALID'
    | 'TOOL_ARGS_EXHAUSTED'
    | 'TOOL_POLICY_INVALID'
    | 'TOOL_NOT_DISCLOSED'
  text: string
}
/** Validate one model call before any policy/effect, retaining the audit beside its refusal. */
export function checkModelToolCall(
  s: SessionImpl,
  call: { name: string; args: unknown },
  offered: ReadonlySet<string>,
  toolUseId: string,
): { refusal?: Refusal; policy?: ResolvedToolPolicyEnvelope; events: EventInput[] } {
  const def = s.turn?.snapshot.byName.get(call.name)
  if (!def) return { refusal: { code: 'TOOL_NOT_FOUND', text: `unknown tool ${call.name}` }, events: [] }
  if (toolArgumentsDisabled(s, call.name))
    return {
      refusal: { code: 'TOOL_ARGS_EXHAUSTED', text: argumentFallback },
      events: recordToolArgumentCheck(s, def, undefined, toolUseId).events,
    }
  if (!offered.has(call.name))
    return {
      refusal: {
        code: 'TOOL_NOT_DISCLOSED',
        text: `tool ${call.name}: ${toolAvailability(s, call.name).message}`,
      },
      events: [],
    }
  const check = recordToolArgumentCheck(s, def, toolArgumentError(def.parameters, call.args), toolUseId)
  if (check.error) return { refusal: { code: 'TOOL_ARGS_INVALID', text: check.error }, events: check.events }
  try {
    return { policy: resolveValidatedToolCallPolicy(def, call.args as JsonValue), events: check.events }
  } catch (error) {
    return {
      refusal: {
        code: 'TOOL_POLICY_INVALID',
        text: error instanceof Error ? error.message : 'tool policy classifier failed',
      },
      events: check.events,
    }
  }
}
