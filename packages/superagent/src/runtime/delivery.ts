// Adapted from dsh-superagent (MIT)
/**
 * Messages to Superagent's sessions. Each goes under the command id `superagent:<message id>`, which AGH deduplicates,
 * so a retry never delivers twice; whether a session holds one is read from its pending inputs and its history. A notice
 * wakes no one: it rolls the session's one live note forward, which the context hook shows and never withdraws.
 */
import type { Store } from '../app/store.js'
import { family } from '../kv.js'
import type { SessionHandle } from './sessions.js'

/** The frozen interface. */
export interface Delivery {
  deliver(
    sessionId: string,
    msg: { id: string; content: string; mode: 'steer' | 'followUp' },
  ): Promise<{ seq: number }>
  notify(sessionId: string, note: { content: string }): void
  status(sessionId: string, messageId: string): Promise<'pending' | 'taken' | 'absent' | 'unknown'>
}

/** The id of each session's live note. A withdrawn note leaves a platform record saying it no longer applies. */
export const NOTICES_NOTE_ID = 'superagent-notices'
/** The live note of each session, which survives a restart so the hook never stops showing it. */
const LIVE_NOTE = family<string, [session: string]>('superagent-live-note:')
export const commandIdOf = (messageId: string): string => `superagent:${messageId}`

/** Delivery over the SDK sessions, with each session's live note kept in the store. */
export class SessionDelivery implements Delivery {
  constructor(
    private readonly deps: {
      sessions: { handle(id: string): Promise<SessionHandle> }
      store: Pick<Store, 'get' | 'set'>
    },
  ) {}
  /** `steer` reaches the turn a busy session runs; an idle session starts a turn with a follow-up. */
  async deliver(sessionId: string, msg: { id: string; content: string; mode: 'steer' | 'followUp' }) {
    const session = await this.deps.sessions.handle(sessionId)
    const commandId = commandIdOf(msg.id)
    const busy = msg.mode === 'steer' && (await session.projectUI()).opState !== null
    const seq = busy
      ? await session.steer(msg.content, { commandId })
      : await session.followUp(msg.content, { commandId })
    return { seq }
  }
  notify(sessionId: string, note: { content: string }): void {
    this.deps.store.set(LIVE_NOTE(sessionId), note.content)
  }
  liveNote(sessionId: string): { id: string; content: string } | undefined {
    const content = this.deps.store.get(LIVE_NOTE(sessionId))
    return content === undefined ? undefined : { id: NOTICES_NOTE_ID, content }
  }
  /** `unknown` when the session cannot be read: the caller then neither delivers again nor takes a new id. */
  async status(sessionId: string, messageId: string) {
    const commandId = commandIdOf(messageId)
    try {
      const ui = await (await this.deps.sessions.handle(sessionId)).projectUI()
      if ((ui.pendingInputs ?? []).some((item) => item.commandId === commandId)) return 'pending' as const
      if (ui.nodes.some((node) => node.kind === 'user' && node.commandId === commandId))
        return 'taken' as const
      return 'absent' as const
    } catch {
      return 'unknown' as const
    }
  }
}
