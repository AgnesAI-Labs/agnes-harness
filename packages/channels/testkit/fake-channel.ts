import type {
  AcpPermissionKind,
  ApprovalAction,
  ChannelCapabilities,
  ChannelManifest,
  DirectoryEntry,
  UINode,
} from '@agnes/protocol'
import {
  type ApprovalView,
  type ChannelAdapter,
  type ChannelCredential,
  type ChannelEvent,
  type ChannelMessage,
  type ChatTarget,
  type ConnectOptions,
  type InboundIntent,
  type MessageRef,
  type RenderContext,
  type SlotActionIntent,
  sessionKeyFor,
  whitelistCredential,
} from '../src/adapter.js'

// Same drop as runner/draw.ts's toAcpOptions: UINode's approval options can include Agnes' own
// 'allow_permanent' (durable-grant) entry, which has no ACP PermissionOptionKind counterpart and no
// card affordance here.
const ACP_OPTION_KINDS = new Set<AcpPermissionKind>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
])
function toAcpOptions(options: readonly string[]): AcpPermissionKind[] {
  return options.filter((o): o is AcpPermissionKind => ACP_OPTION_KINDS.has(o as AcpPermissionKind))
}

export const FAKE_MANIFEST: ChannelManifest = {
  id: 'fake',
  displayName: 'Fake',
  version: '0.0.0',
  connection: { modes: ['stream'], default: 'stream' },
  capabilities: {
    edit: true,
    card: true,
    thread: false,
    attachment: true,
    reactions: true,
    typing: true,
    voice: false,
  },
  credentials: { required: [], optional: [], exposes: ['staffId', 'senderNick'] },
  limits: { textChars: 2_000, cardBytes: 65_536, editWindowMs: 0 },
  events: { supported: ['message', 'cardAction', 'groupJoin'] },
  directory: { supported: true, unit: 'dept' },
}

export class FakeChannel implements ChannelAdapter {
  readonly manifest: ChannelManifest
  readonly sent: Array<{ target: ChatTarget; msg: ChannelMessage; ref: MessageRef }> = []
  readonly updates: Array<{ ref: MessageRef; msg: ChannelMessage }> = []
  readonly reactions: Array<{ ref: MessageRef; emoji: string }> = []
  connected = false
  directoryEntries: DirectoryEntry[] = []
  private eventHandler: ((event: ChannelEvent) => void) | undefined
  private abortSignal: AbortSignal | undefined
  private counter = 0
  private readonly caps: ChannelCapabilities

  constructor(options: { caps?: Partial<ChannelCapabilities>; manifest?: ChannelManifest } = {}) {
    this.manifest = options.manifest ?? FAKE_MANIFEST
    this.caps = { ...this.manifest.capabilities, ...(options.caps ?? {}) }
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.disconnectNow()
    if (options.signal.aborted) return
    this.connected = true
    this.eventHandler = options.onEvent
    this.abortSignal = options.signal
    options.signal.addEventListener('abort', this.disconnectNow, { once: true })
  }

  async disconnect(): Promise<void> {
    this.disconnectNow()
  }

  emit(event: ChannelEvent): void {
    if (this.connected) this.eventHandler?.(event)
  }

  toSession(event: ChannelEvent, context: { tenant: string; agent: string }): InboundIntent | null {
    if (event.kind !== 'message') return null
    const text = event.text.replace(/^@\S+\s*/, '')
    const command = /^\/(\w+)(?:\s+(.*))?$/.exec(text)
    return {
      sessionKey: sessionKeyFor({
        tenant: context.tenant,
        agent: context.agent,
        channel: this.manifest.id,
        chat: event.chat,
      }),
      credential: this.credentialOf(event),
      eventId: event.eventId,
      messageId: event.messageId,
      content: [{ type: 'text', text }],
      kind: command ? 'command' : 'message',
      ...(command
        ? {
            command: {
              name: command[1] as string,
              args: (command[2] ?? '').split(/\s+/).filter(Boolean),
            },
          }
        : {}),
    }
  }

  resolveScope(event: ChannelEvent): { scope: string; isDirectMessage: boolean } {
    return { scope: event.chat.id, isDirectMessage: event.chat.type === 'dm' }
  }

  render(node: UINode, _context: RenderContext): ChannelMessage | null {
    switch (node.kind) {
      case 'assistant':
        return { blocks: [{ kind: 'text', markdown: node.text }] }
      case 'tool':
        return { blocks: [{ kind: 'text', markdown: `⚙ ${node.name} · ${node.status}` }] }
      case 'approval':
        return this.renderApproval({
          summary: node.summary,
          risk: node.risk,
          options: toAcpOptions(node.options),
          ...(node.requestSeq !== undefined ? { requestSeq: node.requestSeq } : {}),
          ...(node.ticket !== undefined ? { ticket: node.ticket } : {}),
          ...(node.expiresAt !== undefined ? { expiresAt: node.expiresAt } : {}),
        })
      case 'cost':
        return { blocks: [{ kind: 'text', markdown: `credits ${node.credits ?? 'unknown'}` }] }
      case 'artifact':
        return {
          blocks: [
            {
              kind: 'file',
              name: node.name,
              mime: node.ref.mime,
              url: `artifact://${node.ref.sha256}`,
            },
          ],
        }
      default:
        return null
    }
  }

  async send(target: ChatTarget, msg: ChannelMessage): Promise<MessageRef> {
    const ref = { chatId: target.chatId, messageId: `m${++this.counter}` }
    this.sent.push({ target, msg, ref })
    return ref
  }

  async update(ref: MessageRef, msg: ChannelMessage): Promise<void> {
    this.updates.push({ ref, msg })
  }

  async react(ref: MessageRef, emoji: string): Promise<void> {
    this.reactions.push({ ref, emoji })
  }

  renderApproval(request: ApprovalView, ticket?: string): ChannelMessage {
    const effectiveTicket = ticket ?? request.ticket
    return {
      blocks: [
        {
          kind: 'approval',
          title: '审批',
          summary: request.summary,
          risk: request.risk,
          options: request.options,
          ...(effectiveTicket !== undefined ? { ticket: effectiveTicket } : {}),
          ...(request.requestSeq !== undefined ? { requestSeq: request.requestSeq } : {}),
          ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
        },
      ],
    }
  }

  onApprovalAction(event: ChannelEvent): ApprovalAction | null {
    if (event.kind !== 'cardAction') return null
    const match = /^appr:([^:]+):(allow_once|allow_always|reject_once)$/.exec(event.value)
    if (!match) return null
    const key = match[1] as string
    const action = match[2]
    const requestSeq = key.startsWith('#') ? Number(key.slice(1)) : undefined
    if (requestSeq !== undefined && (!Number.isSafeInteger(requestSeq) || requestSeq < 1)) return null
    const verdict =
      action === 'allow_once' ? 'allowed-once' : action === 'allow_always' ? 'allowed-session' : 'rejected'
    return {
      ...(requestSeq !== undefined ? { requestSeq } : { ticket: key }),
      verdict,
      approverCredential: this.credentialOf(event),
    }
  }

  onSlotAction(event: ChannelEvent): SlotActionIntent | null {
    if (event.kind !== 'cardAction') return null
    const match = /^slot:(\d+):(.+)$/.exec(event.value)
    if (!match) return null
    const requestSeq = Number(match[1])
    return Number.isSafeInteger(requestSeq) && requestSeq >= 1
      ? {
          requestSeq,
          actionId: match[2] as string,
          credential: this.credentialOf(event),
        }
      : null
  }

  credentialOf(event: ChannelEvent): ChannelCredential {
    const credential: ChannelCredential = {
      kind: 'channel',
      channel: this.manifest.id,
      accountId: event.accountId,
      userId: event.sender.userId,
      chatId: event.chat.id,
      chatType: event.chat.type,
      ...(event.sender.unionId !== undefined ? { unionId: event.sender.unionId } : {}),
      ...(event.sender.displayName !== undefined ? { displayName: event.sender.displayName } : {}),
      raw: event.sender.raw,
    }
    return whitelistCredential(credential, this.manifest.credentials.exposes).cred
  }

  async *syncDirectory(_options: { since?: string; signal: AbortSignal }): AsyncIterable<DirectoryEntry> {
    for (const entry of this.directoryEntries) yield entry
  }

  capabilities(): ChannelCapabilities {
    return { ...this.caps }
  }

  private readonly disconnectNow = (): void => {
    this.abortSignal?.removeEventListener('abort', this.disconnectNow)
    this.abortSignal = undefined
    this.connected = false
    this.eventHandler = undefined
  }
}
