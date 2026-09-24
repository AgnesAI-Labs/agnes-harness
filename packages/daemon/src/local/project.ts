import type { EventEnvelope } from '@agnes/protocol'

const KIND_BY_TOOL: Record<string, string> = {
  read: 'read',
  grep: 'read',
  find: 'read',
  ls: 'read',
  write: 'edit',
  edit: 'edit',
  shell: 'execute',
  run_code: 'execute',
}

const PLAN_STATUS: Record<string, string> = { done: 'completed', doing: 'in_progress' }

/**
 * The event classes that have an ACP session/update form. Everything else is ours alone.
 *
 * `replay` says the caller is rebuilding a transcript rather than following one live. The two paths
 * carry the assistant's words differently - live previews while streaming, the durable message on a
 * replay - so one of the two has to be silent in each direction or the text is said twice.
 */
export function toSessionUpdate(
  event: EventEnvelope,
  o: { replay?: boolean } = {},
): { sessionUpdate: string; payload: Record<string, unknown> } | null {
  const d = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'assistant/message': {
      // The durable half of what the assistant said. Live it is silent here: the words went out as
      // live previews, and the Feed itself sends whatever part of the answer those missed. A load
      // replays no previews, so on that path this is the only carrier there is.
      if (!o.replay) return null
      // Joined, because one ACP chunk carries one content block while core writes an array. Thinking
      // blocks are dropped rather than mapped: ACP has no content block for them, and a load is the
      // transcript, not the reasoning behind it.
      const text = ((d.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
      // A turn whose message was only thinking and tool calls has no text to replay; the calls come
      // back as their own rows.
      if (text === '') return null
      return { sessionUpdate: 'agent_message_chunk', payload: { content: { type: 'text', text } } }
    }
    case 'user/message':
      // Hook notices and per-request fact snapshots ride this same event type for ordering but were
      // never typed by the operator. ACP's SessionUpdate union has no variant for a harness-internal
      // notice - agent_message_chunk and agent_thought_chunk both claim the words as the model's, which
      // would misattribute this exactly as badly as user_message_chunk does - so this gets the same
      // "no representation on this surface" treatment as the other UINode-consuming renderers.
      if (d.kind === 'runtime_context') return null
      return {
        sessionUpdate: 'user_message_chunk',
        payload: { content: (d.content as unknown[] | undefined)?.[0] ?? { type: 'text', text: '' } },
      }
    case 'tool/call':
      return {
        sessionUpdate: 'tool_call',
        payload: {
          toolCallId: d.toolUseId,
          title: d.name,
          kind: KIND_BY_TOOL[String(d.name)] ?? 'other',
          status: 'pending',
          rawInput: d.args,
        },
      }
    case 'tool/result':
      return {
        sessionUpdate: 'tool_call_update',
        payload: {
          toolCallId: d.toolUseId,
          status: d.isError ? 'failed' : 'completed',
          content: ((d.content as unknown[] | undefined) ?? []).map((c) => ({ type: 'content', content: c })),
        },
      }
    case 'plan.items':
      return {
        sessionUpdate: 'plan',
        payload: {
          entries: ((d.items as Array<{ text: string; status: string }> | undefined) ?? []).map((i) => ({
            content: i.text,
            priority: 'medium',
            status: PLAN_STATUS[i.status] ?? 'pending',
          })),
        },
      }
    default:
      return null
  }
}
