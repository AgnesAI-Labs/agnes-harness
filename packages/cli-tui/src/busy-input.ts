import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'

export const codeOf = (error: unknown): string | undefined => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : undefined
}

/** The reason code of a command core rejected, as the daemon reports it: SEMANTIC_REJECTED carrying `code`. */
export const rejectedCode = (error: unknown): string | undefined =>
  (error as { rpc?: { message?: unknown } } | null)?.rpc?.message === 'SEMANTIC_REJECTED'
    ? codeOf(error)
    : undefined

export const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')

/**
 * Cancels the session's running turn, whichever client started it: the daemon only checks that the caller
 * owns the session. A refusal comes back as readable text; any other failure is thrown.
 */
export async function cancelTurn(session: Session, locale: string): Promise<string | undefined> {
  try {
    await session.cancel()
  } catch (error) {
    const code = codeOf(error)
    // The turn ended between the keypress and the daemon seeing it: nothing is left to cancel.
    if (code === 'CONTROL_NOT_RUNNING') return undefined
    if (code === 'CAPABILITY_DENIED') return tt('busy.cancelDenied', locale)
    const rejected = rejectedCode(error)
    if (rejected) return tt('busy.cancelRejected', locale, { code: rejected })
    throw error
  }
  return undefined
}

/**
 * A send that failed twice may still have reached the daemon with only its answer lost. Sending the same
 * command id once more is the SDK's own check: it resolves only when the daemon holds the command.
 */
async function reachedDaemon(session: Session, commandId: string): Promise<boolean> {
  try {
    if (!(await session.client.journal.pending(session.id)).some((c) => c.commandId === commandId))
      return false
    await session.checkCommand(commandId)
    return true
  } catch {
    return false
  }
}

export type BusyHost = {
  session: () => Session
  locale: () => string
  notice: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
  /** Puts an unsent draft back into the editor. */
  restore: (draft: string) => void
}

/** The daemon cannot say whether it took the command: sending the same text again could repeat it. */
const unsure = (error: unknown): boolean =>
  (error as { submission?: { state?: unknown } } | null)?.submission?.state === 'needs-confirmation' ||
  codeOf(error) === 'UNCERTAIN' ||
  codeOf(error) === 'OUTCOME_UNKNOWN'

/**
 * Where input typed while a turn runs goes: the daemon's own queue, which survives this client, is
 * visible to every client and runs automatically once the turn ends. Nothing is held in this process.
 */
export class BusyInput {
  private hinted = false

  private kept: ContentBlock[] = []

  constructor(private readonly host: BusyHost) {}

  /** Attachments of a queued message taken back into the editor: they travel with the next message. */
  keep(blocks: ContentBlock[]): void {
    this.kept = blocks
  }

  takeKept(): ContentBlock[] {
    return this.kept.splice(0)
  }

  /** An idle prompt. A daemon that refuses it as busy did not record it, so it is queued instead. */
  async prompt(blocks: ContentBlock[], draft: string): Promise<void> {
    try {
      await this.host.session().prompt(blocks)
    } catch (error) {
      if (codeOf(error) !== 'SESSION_BUSY') throw error
      await this.queue(blocks, draft, 'followUp')
    }
  }

  /**
   * Queues behind the turn (`followUp`) or inserts into it (`steer`, which falls back to `followUp` when
   * the turn takes no guidance). One command id covers the retry, so the daemon takes the input once.
   * An input that cannot be sent goes back to the editor, unless the daemon turns out to hold it already.
   */
  async queue(blocks: ContentBlock[], draft: string, mode: 'followUp' | 'steer'): Promise<void> {
    const { host } = this
    const session = host.session()
    const locale = host.locale()
    let kind = mode
    let fellBack = false
    if (
      kind === 'steer' &&
      !(await session.controls().then(
        (c) => c.controls.steer === true,
        () => false,
      ))
    ) {
      kind = 'followUp'
      fellBack = true
    }
    const commandId = randomUUID()
    const send = () =>
      kind === 'steer' ? session.steer(blocks, { commandId }) : session.followUp(blocks, { commandId })
    try {
      await send().catch((first) => {
        if (unsure(first)) throw first
        return send()
      })
    } catch (error) {
      if (unsure(error)) host.notice(tt('busy.unsure', locale), 'warning')
      else if (await reachedDaemon(session, commandId)) host.notice(tt('busy.landed', locale), 'warning')
      else {
        host.restore(draft)
        host.notice(tt('busy.kept', locale), 'error')
      }
      return
    }
    const text = escapeControl(textOf(blocks).replace(/\s+/g, ' ').trim() || 'attachment')
    if (kind === 'steer') return host.notice(tt('busy.steered', locale, { text }))
    if (fellBack) return host.notice(tt('busy.steerFallback', locale), 'warning')
    host.notice(tt(this.hinted ? 'busy.queued' : 'busy.hint', locale, { text }))
    this.hinted = true
  }
}
