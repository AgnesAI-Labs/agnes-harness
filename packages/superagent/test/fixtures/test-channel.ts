import type { ChannelProvider } from '@agnes/extension-api'
import type {
  ApprovalView,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCredential,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  ConnectOptions,
  InboundIntent,
  MessageEvent,
  MessageRef,
} from '@agnes/extension-api/channel-contract'
import type { ChannelManifest } from '@agnes/protocol'

export interface TestChannelScript {
  /** Delivered once, in order, right after the first adapter connects. */
  events: ChannelEvent[]
  /** Messages per chat id, the source of `fetchMessages`, `listThread` and `listHistory`. */
  history: Record<string, MessageEvent[]>
  /** Members per chat id. The chats of `listChats` are the chat ids named in `history` and `members`. */
  members: Record<string, { userId: string }[]>
  /** Items per page for every cursor-paged read (default 2, so a host that does not follow the cursor is caught). */
  pageSize?: number
}

export interface TestChannelRead {
  method: 'fetchMessages' | 'listThread' | 'listHistory' | 'listChats' | 'listMembers'
  cursor?: string
}

export const TEST_CHANNEL_MANIFEST: ChannelManifest = {
  id: 'test',
  displayName: 'Test',
  version: '0.0.0',
  connection: { modes: ['stream'], default: 'stream' },
  capabilities: {
    edit: false,
    card: false,
    thread: true,
    attachment: false,
    reactions: false,
    typing: false,
    voice: false,
  },
  credentials: { required: [], optional: [], exposes: [] },
  limits: { textChars: 4_000, cardBytes: 65_536, editWindowMs: 0 },
  events: { supported: ['message', 'groupJoin'] },
  directory: { supported: false, unit: 'dept' },
}

const ALL_READS = { messages: true, threads: true, history: true, chats: true, members: true }

/**
 * An in-memory channel whose every optional read is cursor-paged, so a host that aggregates pages is
 * exercised. `emit` reaches every connected adapter (events emitted before any connects are held and
 * delivered on the first connect); `sent` records each `send` in order.
 */
export function createTestChannel(script: TestChannelScript): {
  provider: ChannelProvider
  emit(event: ChannelEvent): void
  sent(): { target: ChatTarget; message: ChannelMessage }[]
  reads(): TestChannelRead[]
} {
  const pageSize = script.pageSize ?? 2
  const handlers = new Set<(event: ChannelEvent) => void>()
  const held: ChannelEvent[] = [...script.events]
  const sent: { target: ChatTarget; message: ChannelMessage }[] = []
  const reads: TestChannelRead[] = []
  let counter = 0

  const page = <T>(rows: readonly T[], cursor: string | undefined): { rows: T[]; cursor?: string } => {
    const start = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(start) || start < 0) throw new Error(`bad cursor ${cursor}`)
    const end = start + pageSize
    return { rows: rows.slice(start, end), ...(end < rows.length ? { cursor: String(end) } : {}) }
  }
  const byTime = (order: 'asc' | 'desc') => (a: MessageEvent, b: MessageEvent) =>
    order === 'asc' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)
  const emit = (event: ChannelEvent) => {
    if (handlers.size === 0) held.push(event)
    for (const handler of [...handlers]) handler(event)
  }
  const flush = () => {
    for (const event of held.splice(0)) emit(event)
  }

  class TestAdapter implements ChannelAdapter {
    readonly manifest = TEST_CHANNEL_MANIFEST

    async connect(options: ConnectOptions): Promise<void> {
      if (options.signal.aborted) return
      const handler = options.onEvent
      const drop = () => {
        handlers.delete(handler)
      }
      handlers.add(handler)
      options.signal.addEventListener('abort', drop, { once: true })
      this.drop = drop
      queueMicrotask(flush)
    }
    private drop: (() => void) | undefined
    async disconnect(): Promise<void> {
      this.drop?.()
    }
    toSession(event: ChannelEvent): InboundIntent | null {
      return event.kind === 'message'
        ? {
            sessionKey: `test:${event.chat.id}`,
            credential: this.credentialOf(event),
            eventId: event.eventId,
            messageId: event.messageId,
            content: [{ type: 'text', text: event.text }],
            kind: 'message',
          }
        : null
    }
    resolveScope(event: ChannelEvent) {
      return { scope: event.chat.id, isDirectMessage: event.chat.type === 'dm' }
    }
    render() {
      return null
    }
    async send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef> {
      sent.push({ target, message })
      return { chatId: target.chatId, messageId: `sent-${++counter}` }
    }
    async update() {}
    renderApproval(request: ApprovalView): ChannelMessage {
      return { blocks: [{ kind: 'text', markdown: request.summary }] }
    }
    onApprovalAction() {
      return null
    }
    credentialOf(event: ChannelEvent): ChannelCredential {
      return {
        kind: 'channel',
        channel: 'test',
        accountId: event.accountId,
        userId: event.sender.userId,
        chatId: event.chat.id,
        chatType: event.chat.type,
        raw: event.sender.raw,
      }
    }
    capabilities(): ChannelCapabilities {
      return { ...TEST_CHANNEL_MANIFEST.capabilities, read: ALL_READS }
    }
    async fetchMessages(chatId: string, ids: readonly string[]) {
      reads.push({ method: 'fetchMessages' })
      return (script.history[chatId] ?? []).filter((message) => ids.includes(message.messageId))
    }
    async listThread(
      chatId: string,
      threadId: string,
      opts: { cursor?: string; order: 'asc' | 'desc'; pageSize: number },
    ) {
      reads.push({ method: 'listThread', ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) })
      const thread = (script.history[chatId] ?? [])
        .filter((message) => message.chat.threadId === threadId || message.messageId === threadId)
        .sort(byTime(opts.order))
      const { rows, cursor } = page(thread, opts.cursor)
      return { events: rows, ...(cursor !== undefined ? { cursor } : {}) }
    }
    async listHistory(chatId: string, opts: { start: string; end: string; cursor?: string }) {
      reads.push({ method: 'listHistory', ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) })
      const window = (script.history[chatId] ?? [])
        .filter((message) => message.at >= opts.start && message.at <= opts.end)
        .sort(byTime('asc'))
      const { rows, cursor } = page(window, opts.cursor)
      return { events: rows, ...(cursor !== undefined ? { cursor } : {}) }
    }
    async listChats(opts: { cursor?: string }) {
      reads.push({ method: 'listChats', ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) })
      const ids = [...new Set([...Object.keys(script.history), ...Object.keys(script.members)])].sort()
      const { rows, cursor } = page(ids, opts.cursor)
      return {
        chats: rows.map((id) => ({ id, name: `chat ${id}` })),
        ...(cursor !== undefined ? { cursor } : {}),
      }
    }
    async listMembers(chatId: string, opts: { cursor?: string }) {
      reads.push({ method: 'listMembers', ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) })
      const { rows, cursor } = page(script.members[chatId] ?? [], opts.cursor)
      return { members: rows.map((member) => ({ ...member })), ...(cursor !== undefined ? { cursor } : {}) }
    }
  }

  return {
    provider: {
      id: 'test',
      version: '0.0.0',
      manifest: TEST_CHANNEL_MANIFEST,
      create: () => new TestAdapter(),
    },
    emit,
    sent: () => sent.map((row) => ({ ...row })),
    reads: () => reads.map((row) => ({ ...row })),
  }
}
