import { runQueued } from '@agnes/daemon-rpc/local/command-queue'
import { type ScanRead, scanPages } from '@agnes/host'
import type { Actor, EventEnvelope } from '@agnes/protocol'

/**
 * The session facts a held managed input needs: submit it to an idle session, find the turn that
 * took it, withdraw it before a turn does, and read the session's archive state and last turn end.
 * Core stays the only execution authority: its inbox deduplicates by `commandId`, and a
 * `user/message` carrying that id is the proof a turn took the input.
 */
export interface ManagedInputSessionPorts {
  /**
   * Queues a `follow_up` only into an empty inbox and starts its turn. `dedupe` asks core to return
   * the seq of an input already queued under `commandId` (and start it again) instead of queuing a
   * second one; it scans the whole inbox history, so it is only for a submission that may already
   * have happened, and only a sweep (startup or the slow one) asks for it: an idle report also comes
   * when a runner stops without a turn, and a resubmission there would loop. Dedupe also matches an
   * id that was withdrawn or already consumed, so an input submitted again after a withdrawal takes a
   * fresh `commandId` and `dedupe: false`.
   */
  submitInput(
    sessionId: string,
    input: { text: string; actor: Actor; commandId: string; dedupe: boolean },
  ): Promise<{ state: 'submitted'; seq: number } | { state: 'busy' }>
  /** The platform `user/message` for `commandId` at or after `fromSeq`, with the turn it opened. */
  findUserMessage(
    sessionId: string,
    commandId: string,
    fromSeq: number,
  ): Promise<{ seq: number; turn: number } | undefined>
  /** Removes the queued input; `taken` when a turn already took it, `absent` when it never ran. */
  withdraw(sessionId: string, commandId: string): Promise<'withdrawn' | 'taken' | 'absent'>
  /** The daemon's archive state for the session, so an owner archiving it in the Web counts. */
  archived(sessionId: string): boolean
  /** The newest `turn/end`, its reason, and whether a `turn/start` came after it. */
  lastTurnEnd(sessionId: string): Promise<{ seq: number; reason: string; laterStart: boolean } | undefined>
  /** Reports a session that has just stopped running; the listener runs on a later tick. */
  onIdle(listener: (sessionId: string) => void): () => void
}

export type ManagedInputEntry = {
  key: string
  ac: AbortController
  inflight: unknown
  session: {
    enqueue(target: 'next-turn', message: unknown, options?: { dedupeByCommandId?: boolean }): Promise<number>
    scan: ScanRead<EventEnvelope>
    removeQueuedInput(itemId: string, actor: Actor, admissionId: string): Promise<number>
  }
}

/** Withdrawal is the platform's act, recorded on the session's steer facts under this identity. */
const WITHDRAWER: Actor = {
  id: 'agnes:managed-inputs',
  org: 'local',
  role: 'system',
  deptPath: [],
  attrs: {},
}

const failed = (error: unknown, pattern: RegExp) => pattern.test(String((error as Error)?.message))

export function managedInputPorts<E extends ManagedInputEntry>(deps: {
  open(sessionId: string): Promise<E>
  commandQueue: Parameters<typeof runQueued>[0]
  continueTurn(entry: E): void
  preferences: { get(sessionId: string): { archived: boolean } }
  /** The ledger read; with it, consumption and turn-end reads never load a session worker. */
  sessionFactRead?: (sessionId: string) => ScanRead<EventEnvelope>
}): Omit<ManagedInputSessionPorts, 'onIdle'> {
  const read = (sessionId: string): ScanRead<EventEnvelope> =>
    deps.sessionFactRead?.(sessionId) ?? (async (query) => (await deps.open(sessionId)).session.scan(query))
  const findUserMessage = async (sessionId: string, commandId: string, fromSeq: number) => {
    const scan = read(sessionId)
    for await (const page of scanPages(scan, {
      type: 'user/message',
      lane: 'main',
      fromSeq: Math.max(1, fromSeq),
    })) {
      // A managed input is queued as platform input; a person's prompt never names its commandId.
      const message = page.find(
        (row) =>
          row.origin === 'system' && (row.data as { commandId?: unknown } | null)?.commandId === commandId,
      )
      if (!message) continue
      // Core writes the message and the turn it opens in one append.
      const [start] = await scan({ type: 'turn/start', lane: 'main', fromSeq: message.seq, limit: 1 })
      const turn = (start?.data as { turn?: unknown } | null)?.turn
      return typeof turn === 'number' ? { seq: message.seq, turn } : undefined
    }
    return undefined
  }
  return {
    async submitInput(sessionId, input) {
      const entry = await deps.open(sessionId)
      if (entry.inflight) return { state: 'busy' }
      let seq: number
      try {
        seq = await runQueued(deps.commandQueue, entry.key, entry.ac.signal, () =>
          entry.session.enqueue(
            'next-turn',
            {
              content: [{ type: 'text', text: input.text }],
              actor: input.actor,
              origin: 'system',
              trust: 'untrusted',
              // The follow-up runner only starts a turn for a backend-minted follow_up or steer item.
              kind: 'follow_up',
              commandId: input.commandId,
              ifEmpty: true,
            },
            input.dedupe ? { dedupeByCommandId: true } : {},
          ),
        )
      } catch (error) {
        if (failed(error, /continuation input competed with pending input/u)) return { state: 'busy' }
        throw error
      }
      deps.continueTurn(entry)
      return { state: 'submitted', seq }
    },
    findUserMessage,
    async withdraw(sessionId, commandId) {
      const entry = await deps.open(sessionId)
      const removed = await runQueued(deps.commandQueue, entry.key, entry.ac.signal, async () => {
        const [inbox] = await entry.session.scan({ type: 'inbox', lane: 'main', order: 'desc', limit: 1 })
        const items = (inbox?.data as { items?: { itemId: string; commandId?: string }[] } | null)?.items
        const item = items?.find((candidate) => candidate.commandId === commandId)
        if (!item) return false
        try {
          await entry.session.removeQueuedInput(item.itemId, WITHDRAWER, `withdraw:${commandId}`)
          return true
        } catch (error) {
          // A turn took it between the read and the removal; the message scan below says so.
          if (failed(error, /queued input is no longer pending/u)) return false
          throw error
        }
      })
      if (removed) return 'withdrawn'
      // Rare (revoke and uninstall only), so the whole message history is read.
      return (await findUserMessage(sessionId, commandId, 1)) ? 'taken' : 'absent'
    },
    archived: (sessionId) => deps.preferences.get(sessionId).archived,
    async lastTurnEnd(sessionId) {
      const scan = read(sessionId)
      const [end] = await scan({ type: 'turn/end', lane: 'main', order: 'desc', limit: 1 })
      if (!end) return undefined
      const [later] = await scan({ type: 'turn/start', lane: 'main', fromSeq: end.seq + 1, limit: 1 })
      const reason = (end.data as { reason?: unknown } | null)?.reason
      return { seq: end.seq, reason: typeof reason === 'string' ? reason : 'unknown', laterStart: !!later }
    },
  }
}
