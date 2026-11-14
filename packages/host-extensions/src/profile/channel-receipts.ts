import { createHash } from 'node:crypto'
import type { ChannelTargetEvent, PersistenceMetadataNamespace } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { ChannelInstanceRef, ChannelTarget, OwnerPairing } from './channel-targets.js'

/** A receipt the service failed this many times is parked until its owner redelivers or discards it. */
export const RECEIPT_ATTEMPTS = 5
/** How long an acknowledged receipt that no admission took stays resolvable. */
export const RECEIPT_ACK_TTL_MS = 30 * 86_400_000
export const REDELIVERY_INTERVAL_MS = 300_000
/** One delivery tries the handler up to three times in process, waiting these between tries (10 s in all). */
export const RECEIPT_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000]

/** One inbound event of a paired chat, held by the Host until its service acknowledges it. */
export type ReceiptRow = {
  receiptId: string
  pairingId: string
  pairedAt: string
  target: ChannelTarget
  instance: ChannelInstanceRef
  eventId: string
  /** For a click, the id the service's `send` returned for the clicked message. */
  messageId: string
  sender: { userId: string }
  chat: { id: string; type: 'dm' }
  at: string
  kind: 'message' | 'action'
  /** The message text, or for a click the label its button had when the service sent it. */
  text: string
  quotedMessageId?: string
  actionId?: string
  /** The event's content, compared when the platform delivers the same event id again. */
  digest: string
  state: 'pending' | 'acked' | 'parked'
  attempts: number
  updatedAt: string
}

export type ReceiptState = ReceiptRow['state']

/** The Host's answer for one receipt id a service names; the text never comes from the service. */
export type ReceiptResolution =
  | {
      readonly kind: 'receipt'
      readonly receiptId: string
      readonly text: string
      readonly contentDigest: string
      readonly source: {
        readonly instanceId: string
        readonly pairingId: string
        readonly eventId: string
        readonly messageId: string
        readonly kind: 'message' | 'action'
        readonly actionId?: string
        readonly at: string
      }
    }
  | {
      readonly kind: 'unresolved'
      readonly receiptId: string
      readonly reason: 'receiptUnknown' | 'pairingChanged'
    }

export type ParkedReceipt = {
  receiptId: string
  service: string
  kind: 'message' | 'action'
  text: string
  at: string
  attempts: number
}

export type ChannelReceiptsParams =
  | { op: 'parked'; owner: string }
  | { op: 'parkedAll' }
  | { op: 'redeliver' | 'discard'; owner: string; receiptId: string }

/** What the send ledger recorded for a clicked message. */
type SentMessage = { messageId?: string; actions?: readonly { id: string; label: string }[] }
type Handler = (event: ChannelTargetEvent) => Promise<void>

const RECEIPT_ID = /^[a-f0-9]{64}$/
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const rowKey = (owner: string, receiptId: string) => `r:${owner}:${receiptId}`
const sameTarget = (a: ChannelTarget, b: ChannelTarget) => a.owner === b.owner && a.service === b.service

/**
 * Durable ingress receipts for events of chats paired with a managed service. Writing a receipt is the
 * event's claim; a handler that resolves acknowledges it and one that throws counts an attempt, until the
 * receipt parks. Receipts share the pairing store and are read fresh on every call.
 */
export class ChannelReceipts {
  private readonly inflight = new Set<string>()

  constructor(
    private readonly deps: {
      store(): PersistenceMetadataNamespace
      clock(): number
      pairing(id: string): OwnerPairing | undefined
      /** The registered handler of a running service. */
      handler(target: ChannelTarget): Handler | undefined
      /** Waits between in-process tries; `RECEIPT_RETRY_DELAYS_MS` unless a test shortens them. */
      retryDelaysMs?(): readonly number[] | undefined
      /** Where a parking is reported; `console.warn` when absent. */
      warn?(message: string): void
    },
  ) {}

  /**
   * Claims `event` for the current pairing of `channel`'s chat: a new receipt is pending, the same event
   * again returns its state, and the same id with other content is a conflict. A click counts only on a
   * button the paired service sent; the label recorded at send becomes its text. A click on a message sent
   * before the ledger recorded buttons is `unrecorded`: it gets no receipt, and the owner is told.
   */
  receive(
    channel: string,
    pairing: OwnerPairing,
    event: ChannelTargetEvent,
    sent: (pairing: OwnerPairing, clicked: string) => SentMessage | undefined,
  ): { receiptId: string; state: ReceiptState } | 'conflict' | 'dropped' | 'unrecorded' {
    const current = this.deps.pairing(pairing.id)
    if (
      !current ||
      current.pairedAt !== pairing.pairedAt ||
      current.instance.channel !== channel ||
      current.instance.instanceId !== event.instanceId ||
      event.pairingId !== current.id ||
      event.chat.id !== current.chatId ||
      event.sender.userId !== current.userId ||
      typeof event.eventId !== 'string' ||
      !event.eventId
    )
      return 'dropped'
    let text: string
    let messageId = event.messageId
    if (event.kind === 'action') {
      const message = sent(current, event.messageId)
      if (message?.messageId && message.actions === undefined) return 'unrecorded'
      const label = message?.actions?.find((action) => action.id === event.actionId)?.label
      if (!message?.messageId || label === undefined) return 'dropped'
      text = label
      messageId = message.messageId
    } else text = event.text
    if (typeof text !== 'string' || !text) return 'dropped'
    const quoted = event.kind === 'message' ? event.quotedMessageId : undefined
    const content = event.kind === 'action' ? event.actionId : event.text
    const digest = sha256(JSON.stringify([event.kind, event.messageId, content, quoted ?? null]))
    const { instance } = current
    const receiptId = sha256(
      `${instance.channel}\0${instance.instanceId}\0${current.accountId}\0${event.eventId}`,
    )
    const store = this.deps.store()
    const key = rowKey(current.target.owner, receiptId)
    const existing = store.get(key) as ReceiptRow | undefined
    if (existing) return existing.digest === digest ? { receiptId, state: existing.state } : 'conflict'
    const row: ReceiptRow = {
      receiptId,
      pairingId: current.id,
      pairedAt: current.pairedAt,
      target: { owner: current.target.owner, service: current.target.service },
      instance: { channel: instance.channel, instanceId: instance.instanceId },
      eventId: event.eventId,
      messageId,
      sender: { userId: current.userId },
      chat: { id: current.chatId, type: 'dm' },
      at: event.at,
      kind: event.kind,
      text,
      ...(typeof quoted === 'string' && quoted ? { quotedMessageId: quoted } : {}),
      ...(event.kind === 'action' ? { actionId: event.actionId } : {}),
      digest,
      state: 'pending',
      attempts: 0,
      updatedAt: this.now(),
    }
    store.set(key, row)
    return { receiptId, state: 'pending' }
  }

  /**
   * Runs one delivery of `event`. With a pending receipt of `owner`'s for it, a resolved run acknowledges
   * the receipt; a run that still throws after the in-process tries counts one attempt and leaves the
   * receipt to the sweep or the service's restart. An acknowledged or parked receipt is not delivered again.
   * A receipt id `owner` does not hold for this event is removed before the service sees the event.
   */
  async settle(owner: string, event: ChannelTargetEvent, run: Handler): Promise<void> {
    const id = event.receiptId
    const row =
      id === undefined ? undefined : (this.deps.store().get(rowKey(owner, id)) as ReceiptRow | undefined)
    if (!id || !row || row.eventId !== event.eventId || row.pairingId !== event.pairingId) {
      const { receiptId: _, ...plain } = event
      return run(plain as ChannelTargetEvent)
    }
    if (row.state !== 'pending' || this.inflight.has(id)) return
    this.inflight.add(id)
    try {
      const delays = this.deps.retryDelaysMs?.() ?? RECEIPT_RETRY_DELAYS_MS
      for (let tried = 0; ; tried++) {
        try {
          await run(event)
          break
        } catch (error) {
          const wait = delays[tried]
          const live = this.deps.store().get(rowKey(owner, id)) as ReceiptRow | undefined
          if (wait === undefined || live?.state !== 'pending') throw error
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref?.())
        }
      }
      this.change(owner, id, () => ({ state: 'acked' }))
    } catch (error) {
      this.change(owner, id, (current) => ({
        attempts: current.attempts + 1,
        state: current.attempts + 1 >= RECEIPT_ATTEMPTS ? 'parked' : current.state,
      }))
      // Only a pending receipt is delivered, so a parked one has just parked.
      if ((this.deps.store().get(rowKey(owner, id)) as ReceiptRow | undefined)?.state === 'parked')
        this.parkedWarning(row, `its service failed ${RECEIPT_ATTEMPTS} deliveries`)
      throw error
    } finally {
      this.inflight.delete(id)
    }
  }

  /**
   * Delivers pending receipts again, oldest event first, to running services: `only`'s, or every one. A
   * receipt whose pairing changed is parked instead. It starts after the caller returns.
   */
  async redeliver(only?: ChannelTarget): Promise<void> {
    await Promise.resolve()
    const pending = this.rows((row) => row.state === 'pending' && (!only || sameTarget(row.target, only)))
    pending.sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId))
    for (const row of pending) {
      const handler = this.deps.handler(row.target)
      if (!handler || this.inflight.has(row.receiptId)) continue
      const current = this.deps.pairing(row.pairingId)
      if (!current || current.pairedAt !== row.pairedAt || !sameTarget(current.target, row.target)) {
        this.change(row.target.owner, row.receiptId, () => ({ state: 'parked' }))
        this.parkedWarning(row, 'its pairing changed')
        continue
      }
      await this.settle(row.target.owner, eventOf(row), handler).catch(() => undefined)
    }
  }

  /** Deletes acknowledged receipts no admission took within the retention; pending and parked ones stay. */
  prune(): void {
    const before = this.deps.clock() - RECEIPT_ACK_TTL_MS
    const store = this.deps.store()
    store.transaction(() => {
      for (const { key, value } of store.entries())
        if (
          key.startsWith('r:') &&
          (value as ReceiptRow).state === 'acked' &&
          !(Date.parse((value as ReceiptRow).updatedAt) > before)
        )
          store.delete(key)
    })
  }

  /** An admission recorded the receipt's text, so the receipt is no longer needed. */
  admitted(owner: string, receiptId: string): void {
    this.deps.store().delete(rowKey(owner, receiptId))
  }

  /** The text `target`'s own receipt holds, while the pairing it arrived on is still current. */
  resolve(target: ChannelTarget, receiptId: string): ReceiptResolution {
    const row =
      typeof receiptId === 'string' && RECEIPT_ID.test(receiptId)
        ? (this.deps.store().get(rowKey(target.owner, receiptId)) as ReceiptRow | undefined)
        : undefined
    if (!row || !sameTarget(row.target, target))
      return { kind: 'unresolved', receiptId, reason: 'receiptUnknown' }
    const current = this.deps.pairing(row.pairingId)
    if (!current || current.pairedAt !== row.pairedAt || !sameTarget(current.target, row.target))
      return { kind: 'unresolved', receiptId, reason: 'pairingChanged' }
    return {
      kind: 'receipt',
      receiptId,
      text: row.text,
      contentDigest: sha256(row.text),
      source: {
        instanceId: row.instance.instanceId,
        pairingId: row.pairingId,
        eventId: row.eventId,
        messageId: row.messageId,
        kind: row.kind,
        ...(row.actionId === undefined ? {} : { actionId: row.actionId }),
        at: row.at,
      },
    }
  }

  /** One owner's parked receipts, for the owner to redeliver or discard. */
  parked(owner: string): ParkedReceipt[] {
    return this.rows((row) => row.state === 'parked' && row.target.owner === owner).map((row) => ({
      receiptId: row.receiptId,
      service: row.target.service,
      kind: row.kind,
      text: row.text,
      at: row.at,
      attempts: row.attempts,
    }))
  }

  /** Every owner's parked receipts, each with its owner: the owner's list across services. */
  parkedAll(): (ParkedReceipt & { owner: string })[] {
    return this.rows((row) => row.state === 'parked').map((row) => ({
      owner: row.target.owner,
      receiptId: row.receiptId,
      service: row.target.service,
      kind: row.kind,
      text: row.text,
      at: row.at,
      attempts: row.attempts,
    }))
  }

  /** The owner's decisions on parked receipts; anything else is refused. */
  command(
    params: unknown,
  ):
    | { receipts: ParkedReceipt[] }
    | { receipts: (ParkedReceipt & { owner: string })[] }
    | { receipt: 'pending' | 'discarded' } {
    const p = (params ?? {}) as Record<string, unknown>
    if (p.op === 'parkedAll') return { receipts: this.parkedAll() }
    if (typeof p.owner !== 'string' || !p.owner) throw rpcError('INVALID_PARAMS')
    if (p.op === 'parked') return { receipts: this.parked(p.owner) }
    if (
      (p.op !== 'redeliver' && p.op !== 'discard') ||
      typeof p.receiptId !== 'string' ||
      !RECEIPT_ID.test(p.receiptId)
    )
      throw rpcError('INVALID_PARAMS')
    const store = this.deps.store()
    const key = rowKey(p.owner, p.receiptId)
    const row = store.get(key) as ReceiptRow | undefined
    if (row?.state !== 'parked') throw rpcError('SEMANTIC_REJECTED', { code: 'RECEIPT_NOT_PARKED' })
    if (p.op === 'discard') {
      store.delete(key)
      return { receipt: 'discarded' }
    }
    store.set(key, { ...row, state: 'pending', attempts: 0, updatedAt: this.now() })
    void this.redeliver(row.target)
    return { receipt: 'pending' }
  }

  /** The operator's signal; the owner finds the receipt in the Web's owner input list. Never the text. */
  private parkedWarning(row: ReceiptRow, why: string): void {
    const warn = this.deps.warn ?? ((message: string) => console.warn(message))
    warn(
      `Channel receipt ${row.receiptId.slice(0, 12)} for ${row.target.service} parked: ${why}; ` +
        'the owner can redeliver or discard it in the Web',
    )
  }

  private change(owner: string, receiptId: string, next: (row: ReceiptRow) => Partial<ReceiptRow>): void {
    const store = this.deps.store()
    const key = rowKey(owner, receiptId)
    const row = store.get(key) as ReceiptRow | undefined
    if (row) store.set(key, { ...row, ...next(row), updatedAt: this.now() })
  }

  private rows(keep: (row: ReceiptRow) => boolean): ReceiptRow[] {
    return this.deps
      .store()
      .entries()
      .filter(({ key, value }) => key.startsWith('r:') && keep(value as ReceiptRow))
      .map(({ value }) => value as ReceiptRow)
  }

  private now(): string {
    return new Date(this.deps.clock()).toISOString()
  }
}

/** The event a receipt redelivers: what the service first received, with the same receipt id. */
function eventOf(row: ReceiptRow): ChannelTargetEvent {
  const base = {
    origin: 'owner',
    pairingId: row.pairingId,
    instanceId: row.instance.instanceId,
    eventId: row.eventId,
    messageId: row.messageId,
    at: row.at,
    chat: { id: row.chat.id, type: 'dm' },
    sender: { userId: row.sender.userId },
    receiptId: row.receiptId,
  } as const
  return row.kind === 'action'
    ? { ...base, kind: 'action', actionId: row.actionId ?? '' }
    : {
        ...base,
        kind: 'message',
        text: row.text,
        ...(row.quotedMessageId ? { quotedMessageId: row.quotedMessageId } : {}),
      }
}
