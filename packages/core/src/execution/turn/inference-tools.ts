import type { ToolCallState } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { toolArgumentFeedback } from '../../step/tool-args.js'
import { toolCallPayload } from '../../step/tool-call.js'
import { checkModelToolCall } from './tool-call-check.js'

/** Fold completed model tool calls into their audit and admitted batch, preserving call order. */
export function planModelToolCalls(
  s: SessionImpl,
  t: TurnMemory,
  calls: Array<{ name: string; args: unknown }>,
  offered: ReadonlySet<string>,
  truncated: boolean,
  events: EventInput[],
): ToolCallState[] {
  const planned: ToolCallState[] = []
  const refusedCalls: EventInput[] = []
  // A truncated answer's tool calls are dropped rather than run: the arguments were cut off
  // mid-serialisation, so what survives is a call the model did not finish asking for.
  if (!truncated)
    for (const c of calls) {
      const ordinal = t.ordinal++
      const toolUseId = s.d.ids.toolUseId(ordinal)
      const { refusal, policy, events: validationEvents } = checkModelToolCall(s, c, offered, toolUseId)
      refusedCalls.push(...validationEvents)
      events.push(
        s.ev(
          'tool/call',
          toolCallPayload(
            { toolUseId, name: c.name, args: c.args, ordinal },
            t.snapshot.byName.get(c.name)?.meta.presentation,
            policy,
          ),
          { origin: 'model' },
        ),
      )
      const feedback = refusal?.code === 'TOOL_ARGS_INVALID' ? toolArgumentFeedback(refusal.text) : undefined
      if (refusal)
        refusedCalls.push(
          s.ev('tool/result', {
            toolUseId,
            isError: true,
            code: refusal.code,
            content: [
              { type: 'text', text: refusal.text },
              ...(feedback ? [{ type: 'text', text: JSON.stringify(feedback) }] : []),
            ],
            ...(feedback ? { structured: feedback } : {}),
            enforcement: s.d.runtime.enforcement(),
            authz: { decisionId: 'n/a' },
          }),
        )
      const baseCall = {
        ordinal,
        toolUseId,
        name: c.name,
        argsSeq: 1,
        replay: policy?.resolvedPolicy.replay ?? 'never',
      }
      if (refusal) {
        planned.push(
          policy ? { ...baseCall, status: 'completed', ...policy } : { ...baseCall, status: 'completed' },
        )
      } else {
        if (!policy) throw new Error('validated tool call lacks resolved policy')
        planned.push({ ...baseCall, status: 'planned', ...policy })
      }
    }
  events.push(...refusedCalls)
  return planned
}
