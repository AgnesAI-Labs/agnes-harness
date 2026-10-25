import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { escapeControl } from './component.js'
import { boundKeys, keyText } from './keymap.js'
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
 * A failed check (including an unreadable journal) leaves the outcome unknown.
 */
async function reachedDaemon(session: Session, commandId: string): Promise<boolean | undefined> {
  try {
    if (!(await session.client.journal.pending(session.id)).some((c) => c.commandId === commandId))
      return false
    await session.checkCommand(commandId)
    return true
  } catch {
    return undefined
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

const rpcName = (error: unknown): string =>
  (error as { kind?: unknown; rpc?: { message?: unknown } } | null)?.kind === 'json-rpc'
    ? String((error as { rpc: { message?: unknown } }).rpc.message)
    : ''

/** Replies a daemon gives to a prompt it refused up front, so no turn started. */
const REFUSALS = new Set([
  'OVERLOADED',
  'SEMANTIC_REJECTED',
  'INVALID_PARAMS',
  'CAPABILITY_DENIED',
  'AUTH_INVALID',
  'SESSION_NOT_FOUND',
  'CLAIM_DENIED',
])

/**
 * Where input typed while a turn runs goes: the daemon's own queue, which survives this client, is
 * visible to every client and runs automatically once the turn ends. Nothing is held in this process.
 */
export class BusyInput {
  private hinted = false

  private kept: ContentBlock[] = []

  private readonly chips = new Map<string, { block: ContentBlock; sessionId: string }>()
  private readonly chipOrigins = new WeakMap<ContentBlock, { chip: string; sessionId: string }>()

  constructor(private readonly host: BusyHost) {}

  /** Attachments of a queued message taken back into the editor: they travel with the next message. */
  keep(blocks: ContentBlock[]): void {
    this.kept = blocks
  }

  /** A clipboard image uploaded to `sessionId`, shown in the draft as `chip`; it travels only if the chip is still in the text sent. */
  attach(chip: string, block: ContentBlock, sessionId: string): void {
    this.chips.set(chip, { block, sessionId })
    this.chipOrigins.set(block, { chip, sessionId })
  }

  takeKept(text = ''): ContentBlock[] {
    const here = this.host.session().id
    const chips = [...this.chips].filter(([chip, c]) => c.sessionId === here && text.includes(chip))
    // A chip left out of this message (a draft put aside with Ctrl-S, say) still binds its image.
    for (const [chip] of chips) this.chips.delete(chip)
    return [...this.kept.splice(0), ...chips.map(([, c]) => c.block)]
  }

  /** An idle prompt. A daemon that refuses it as busy did not record it, so it is queued instead. */
  async prompt(blocks: ContentBlock[], draft: string): Promise<void> {
    if (this.offline(blocks, draft)) return
    try {
      await this.host.session().prompt(blocks)
    } catch (error) {
      if (codeOf(error) === 'SESSION_BUSY') return this.queue(blocks, draft, 'followUp')
      // Only a refusal the daemon sent before any turn began returns the draft; a timeout or a
      // dropped connection may have started one, and sending it again could repeat it.
      if (REFUSALS.has(rpcName(error))) this.putBack(this.host.session(), blocks, draft)
      throw error
    }
  }

  /**
   * While the client is reconnecting or closed a send fails before it leaves the process, and the SDK would then
   * wait for a turn that never started. Nothing was sent, so the draft goes straight back.
   */
  private offline(blocks: ContentBlock[], draft: string): boolean {
    const session = this.host.session()
    const state = session.client.connectionState
    if (state !== 'reconnecting' && state !== 'closed') return false
    if (this.putBack(session, blocks, draft))
      this.host.notice(tt('busy.offline', this.host.locale()), 'error')
    return true
  }

  /**
   * Puts a definitely unsent draft back in the editor and re-binds its images to their chips, only in
   * the session it was typed in. Keeping all blocks would resend images even after their chips were removed.
   */
  private putBack(session: Session, blocks: ContentBlock[], draft: string): boolean {
    if (this.host.session() !== session) return false
    for (const block of blocks) {
      const origin = this.chipOrigins.get(block)
      if (origin?.sessionId === session.id) this.chips.set(origin.chip, { block, sessionId: session.id })
    }
    this.host.restore(draft)
    return true
  }

  /**
   * Queues behind the turn (`followUp`) or inserts into it (`steer`, which falls back to `followUp` when
   * the turn takes no guidance). One command id covers the retry, so the daemon takes the input once.
   * An input that cannot be sent goes back to the editor, unless the daemon turns out to hold it already.
   */
  async queue(blocks: ContentBlock[], draft: string, mode: 'followUp' | 'steer'): Promise<void> {
    if (this.offline(blocks, draft)) return
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
      const reached = unsure(error) ? undefined : await reachedDaemon(session, commandId)
      if (reached === undefined) host.notice(tt('busy.unsure', locale), 'warning')
      else if (reached) host.notice(tt('busy.landed', locale), 'warning')
      else {
        if (this.putBack(session, blocks, draft)) host.notice(tt('busy.kept', locale), 'error')
      }
      return
    }
    const text = escapeControl(textOf(blocks).replace(/\s+/g, ' ').trim() || 'attachment')
    if (kind === 'steer') return host.notice(tt('busy.steered', locale, { text }))
    if (fellBack) return host.notice(tt('busy.steerFallback', locale), 'warning')
    const steerKey = boundKeys('steer')[0]
    const id = this.hinted ? 'busy.queued' : steerKey === undefined ? 'busy.hintNoKey' : 'busy.hint'
    host.notice(tt(id, locale, { text, key: keyText(steerKey ?? '') }))
    this.hinted = true
  }
}
