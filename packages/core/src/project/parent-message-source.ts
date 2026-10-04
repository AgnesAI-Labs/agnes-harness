import type { UINode } from '@agnes/protocol'
import type { InboxItem } from '../reduce/shapes.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { Event } from '../types.js'

type Source = NonNullable<Extract<UINode, { kind: 'context' }>['messageSource']>
type Receipt = { source: Source; textHash: string }

const bodyHash = (content: InboxItem['content']): string | undefined =>
  content.length === 1 && content[0]?.type === 'text' ? sha256Hex(content[0].text) : undefined

/** Provenance is proved by the trusted receipt and exact inbox claim, never by a text prefix. */
export class ParentMessageSources {
  private inbox: InboxItem[] = []
  private inboxSeq = 0
  private claim: { item: InboxItem; seq: number } | undefined
  private readonly receipts = new Map<string, Receipt | null>()

  constructor(
    private readonly sessionKey: string,
    private readonly lane: string,
  ) {}

  apply(event: Event): Source | undefined {
    if ((event.lane ?? 'main') !== this.lane) return
    if (event.type === 'session/start') {
      this.inbox = []
      this.receipts.clear()
      this.claim = undefined
      this.inboxSeq = 0
      return
    }
    const claim = this.claim
    this.claim = undefined
    if (event.type === 'inbox') {
      const data = event.data as { items?: InboxItem[] }
      if (event.origin !== 'system' || event.trust !== 'trusted' || !Array.isArray(data?.items)) {
        this.inbox = []
        this.inboxSeq = 0
        return
      }
      const removed = this.inbox.filter((item) => !data.items?.some((next) => next.itemId === item.itemId))
      if (
        removed.length === 1 &&
        canonicalJson(this.inbox.filter((item) => item !== removed[0])) === canonicalJson(data.items)
      )
        this.claim = { item: removed[0] as InboxItem, seq: event.seq }
      this.inbox = structuredClone(data.items)
      this.inboxSeq = event.seq
      return
    }
    if (event.type === 'x/core/child-received') {
      const data = event.data as Record<string, unknown>
      if (typeof data?.messageId !== 'string' || !data.messageId || data.messageId.length > 128) return
      if (this.receipts.has(data.messageId)) {
        this.receipts.set(data.messageId, null)
        return
      }
      const item = this.inbox.find((value) => value.itemId === data.messageId)
      if (
        event.origin !== 'system' ||
        event.trust !== 'trusted' ||
        data.version !== 1 ||
        data.parentKey !== this.sessionKey ||
        typeof data.senderKey !== 'string' ||
        !data.senderKey ||
        data.senderKey.length > 1024 ||
        !Number.isSafeInteger(data.sourceSeq) ||
        (data.sourceSeq as number) < 1 ||
        this.inboxSeq !== event.seq - 1 ||
        !item ||
        item.trust !== 'untrusted' ||
        typeof data.deliveryId !== 'string' ||
        !data.deliveryId ||
        typeof data.textHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(data.textHash) ||
        bodyHash(item.content) !== data.textHash ||
        !['agent-message', 'subagent-settled'].includes(data.kind as string) ||
        (data.kind === 'agent-message'
          ? data.outcome !== undefined
          : !['completed', 'failed', 'cancelled'].includes(data.outcome as string))
      ) {
        this.receipts.set(data.messageId, null)
        return
      }
      this.receipts.set(data.messageId, {
        textHash: data.textHash as string,
        source: {
          kind: data.kind as Source['kind'],
          senderSessionId: data.senderKey,
          receiptSeq: event.seq,
          ...(data.kind === 'subagent-settled'
            ? { outcome: data.outcome as NonNullable<Source['outcome']> }
            : {}),
        },
      })
      return
    }
    if (
      event.type !== 'user/message' ||
      !claim ||
      claim.seq !== event.seq - 1 ||
      event.origin !== 'principal' ||
      event.trust !== 'untrusted'
    )
      return
    const data = event.data as { itemId?: string; content: InboxItem['content'] }
    if (data.itemId !== undefined && data.itemId !== claim.item.itemId) return
    const receipt = this.receipts.get(claim.item.itemId)
    if (
      !receipt ||
      bodyHash(data.content) !== receipt.textHash ||
      canonicalJson(data.content) !== canonicalJson(claim.item.content)
    )
      return
    this.receipts.set(claim.item.itemId, null)
    return structuredClone(receipt.source)
  }
}
