import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { parseSystemPromptAppend, rpcError } from '@agnes/protocol'

/**
 * `session/new` `systemPromptAppend`: text the caller adds to this one new session's system prompt.
 * Fail closed: it is only admitted for a brand-new session (a reused ledger keeps its pinned prompt),
 * and never while configuration is read-only or cannot be checked.
 * Whether the deployment uses a full replacement is Core's refusal, where the pinned config is built.
 */
export async function admitSystemPromptAppend(
  value: unknown,
  o: {
    existingSession: boolean
    context: CallContext
    configurationReadOnly: ((context: CallContext) => Promise<boolean>) | undefined
  },
): Promise<string | undefined> {
  if (value === undefined) return undefined
  let text: string
  try {
    text = parseSystemPromptAppend(value)
  } catch {
    throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid systemPromptAppend' })
  }
  if (o.existingSession)
    throw rpcError('SEMANTIC_REJECTED', { reason: 'systemPromptAppend applies only to a new session' })
  if (!o.configurationReadOnly)
    throw rpcError('CAPABILITY_DENIED', { reason: 'systemPromptAppend unavailable' })
  if (await o.configurationReadOnly(o.context))
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_ADMIN_READ_ONLY' })
  return text
}
