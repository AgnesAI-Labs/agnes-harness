import type { EnqueueMsg } from '@agnes/core'
import type { Actor, SystemInput } from '@agnes/protocol'

/** All platform notification producers share atomic historical command deduplication. */
export async function enqueueSystemInput(
  session: {
    enqueue(
      target: 'next-turn' | 'next-step',
      message: EnqueueMsg,
      options?: { dedupeByCommandId?: boolean },
    ): Promise<number>
  },
  key: string,
  system: SystemInput,
  actor: Actor,
  signal: AbortSignal,
  target: 'next-turn' | 'next-step' = 'next-turn',
): Promise<number> {
  signal.throwIfAborted()
  return session.enqueue(
    target,
    {
      content: [{ type: 'text', text: system.summary }],
      system,
      actor,
      commandId: key,
      kind: 'follow_up',
      trust: 'untrusted',
      origin: 'system',
    },
    { dedupeByCommandId: true },
  )
}
