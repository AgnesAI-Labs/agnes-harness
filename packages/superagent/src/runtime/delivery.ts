// Adapted from dsh-superagent (MIT)
/**
 * Messages to Superagent's sessions. Each goes under the command id `superagent:<message id>`, or a fresh attempt's id
 * when it is delivered again; whether a session holds one is read from its pending inputs and its history. A notice wakes
 * no one: it rolls the session's one live note forward, which the context hook shows and never withdraws.
 */
import type { Store } from '../app/store.js'
import { family } from '../kv.js'
import { type SessionHandle, sessionHead } from './sessions.js'

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
/**
 * The command id of attempt `attempt` of a message: the first goes under `superagent:<message id>`, each later one under
 * `superagent:<message id>:r<attempt>`. The daemon keeps a receipt per command id long after the input left the inbox, so a
 * message delivered again after its copy was dropped needs an id the daemon has not seen.
 */
export const commandIdOf = (messageId: string, attempt = 0): string =>
  attempt ? `superagent:${messageId}:r${attempt}` : `superagent:${messageId}`
/** The message a command id of Superagent's carries, whichever its attempt; undefined for any other command. */
export function messageOfCommand(commandId: string | undefined): string | undefined {
  if (!commandId?.startsWith('superagent:')) return undefined
  return commandId.slice('superagent:'.length).replace(/:r\d+$/, '')
}
/**
 * A message's current attempt and, while its submission has no confirmed answer, that submission's command id. Only a
 * message delivered anew or not yet confirmed has a record; a first attempt that went through leaves none.
 */
type Attempt = { n: number; open?: string }
const ATTEMPTS = family<Attempt, [session: string, message: string]>('superagent-delivery:')

/** Delivery as the executor uses it: the frozen interface, plus a fresh attempt for a message delivered anew. */
export interface Redelivery extends Delivery {
  /**
   * The next delivery of the message goes under a fresh command id, as its earlier copy is dropped or lost. A submission
   * of it that has no confirmed answer is settled first, under its own id: the daemon answers from its receipt when it
   * arrived, or takes it now. Either way the copy a caller drops next is a copy it drops, never one a later delivery would
   * take for the message delivered; this holds whether the caller drops before or after renewing.
   * @throws when that submission cannot be settled; the caller then drops nothing and tries again later.
   */
  renew(sessionId: string, messageId: string): Promise<void>
}

/** Delivery over the SDK sessions, with each session's live note kept in the store. */
export class SessionDelivery implements Redelivery {
  constructor(
    private readonly deps: {
      sessions: { handle(id: string): Promise<SessionHandle> }
      store: Pick<Store, 'get' | 'set' | 'delete'>
    },
  ) {}
  /**
   * `steer` reaches the turn a busy session runs; an idle session starts a turn with a follow-up. A first attempt goes out
   * at once. A message delivered anew, or one whose last submission got no confirmed answer, is first looked for: an
   * unconfirmed submission is resolved under its own id (the daemon answers from its receipt when it arrived), and a copy
   * the session holds counts as delivered. Otherwise it goes under the next attempt's id, never one the daemon saw for
   * another copy, so neither its receipt nor a changed steer or follow-up refuses it.
   * @throws when whether the session holds the message cannot be read; the caller tries again later.
   */
  async deliver(sessionId: string, msg: { id: string; content: string; mode: 'steer' | 'followUp' }) {
    const session = await this.deps.sessions.handle(sessionId)
    const name = ATTEMPTS(sessionId, msg.id)
    let attempt = this.deps.store.get(name) ?? { n: 0 }
    if (attempt.open !== undefined || attempt.n > 0) {
      const held = await this.held(session, msg.id, attempt.open)
      if (held !== undefined) {
        this.settled(name, attempt.n)
        return { seq: held }
      }
      if (attempt.open !== undefined) attempt = { n: attempt.n + 1 }
    }
    const commandId = commandIdOf(msg.id, attempt.n)
    this.deps.store.set(name, { n: attempt.n, open: commandId })
    const busy = msg.mode === 'steer' && (await sessionHead(session)).opState !== null
    const seq = busy
      ? await session.steer(msg.content, { commandId })
      : await session.followUp(msg.content, { commandId })
    this.settled(name, attempt.n)
    return { seq }
  }
  async renew(sessionId: string, messageId: string): Promise<void> {
    const name = ATTEMPTS(sessionId, messageId)
    const attempt = this.deps.store.get(name)
    const open = attempt?.open
    if (open !== undefined) {
      const session = await this.deps.sessions.handle(sessionId)
      if ((await session.pendingCommands()).some((entry) => entry.commandId === open))
        await session.checkCommand(open)
    }
    this.deps.store.set(name, { n: (attempt?.n ?? 0) + 1 })
  }
  private settled(name: ReturnType<typeof ATTEMPTS>, n: number): void {
    if (n) this.deps.store.set(name, { n })
    else this.deps.store.delete(name)
  }
  /** The session's position once it holds a copy of the message, or undefined when it holds none. */
  private async held(session: SessionHandle, messageId: string, open: string | undefined) {
    if (open !== undefined && (await session.pendingCommands()).some((entry) => entry.commandId === open)) {
      await session.checkCommand(open)
      return (await sessionHead(session)).upto
    }
    // Only this rare path, a message delivered anew or not confirmed, reads the full projection: a taken message shows
    // only in the history.
    const ui = await session.projectUI()
    return holding(ui, messageId) === 'absent' ? undefined : ui.upto
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
    try {
      return holding(await (await this.deps.sessions.handle(sessionId)).projectUI(), messageId)
    } catch {
      return 'unknown' as const
    }
  }
}

/** Whether a session's projection holds a copy of the message under any attempt: waiting in its inbox, or taken. */
function holding(
  ui: Awaited<ReturnType<SessionHandle['projectUI']>>,
  messageId: string,
): 'pending' | 'taken' | 'absent' {
  if ((ui.pendingInputs ?? []).some((item) => messageOfCommand(item.commandId) === messageId))
    return 'pending'
  if (ui.nodes.some((node) => node.kind === 'user' && messageOfCommand(node.commandId) === messageId))
    return 'taken'
  return 'absent'
}
