import type {
  AcpPermissionKind,
  ApprovalAction,
  ChannelCapabilities,
  ChannelManifest,
  ContentBlock,
  DirectoryEntry,
  ChannelCredential as ProtocolChannelCredential,
  UINode,
  UiActionParams,
  UiRevision,
} from '@agnes/protocol'

export type { ApprovalAction, ChannelCapabilities, ChannelManifest, DirectoryEntry } from '@agnes/protocol'

export type ChatRef = {
  id: string
  type: 'dm' | 'group' | 'thread'
  threadId?: string
}

export type Sender = {
  userId: string
  unionId?: string
  displayName?: string
  raw: Record<string, string>
}

export type Attachment = {
  name: string
  mime: string
  bytes?: Uint8Array
  url?: string
  sizeBytes?: number
}

type EventBase = {
  eventId: string
  accountId: string
  chat: ChatRef
  sender: Sender
  at: string
}

export type MessageEvent = EventBase & {
  kind: 'message'
  messageId: string
  text: string
  attachments: Attachment[]
  mentions: { bot: boolean; replyToBot: boolean; quoteBot: boolean }
  /** The platform id of the message this one replies to or quotes, when the channel reports it. */
  quotedMessageId?: string
}

export type CardActionEvent = EventBase & {
  kind: 'cardAction'
  cardBizId: string
  value: string
  /** Bounded values from the verified platform form callback. */
  formValues?: Record<string, string | string[]>
}

export type GroupJoinEvent = EventBase & { kind: 'groupJoin' }

export type ReactionEvent = EventBase & {
  kind: 'reaction'
  messageId: string
  emoji: string
}

export type ChannelEvent = MessageEvent | CardActionEvent | GroupJoinEvent | ReactionEvent

// Protocol owns the credential wire shape. Channels re-exports the exact type instead of
// maintaining a second declaration that could drift from the generated schema.
export type ChannelCredential = ProtocolChannelCredential

export type InboundIntent = {
  sessionKey: string
  laneKey?: string
  credential: ChannelCredential
  eventId: string
  messageId: string
  content: ContentBlock[]
  kind: 'message' | 'command'
  command?: { name: string; args: string[] }
}

export type TextBlock = { kind: 'text'; markdown: string }

export type TableBlock = {
  kind: 'table'
  title?: string
  columns: string[]
  rows: string[][]
}

export type CardBlock = {
  kind: 'card'
  title: string
  body: string
  fields?: Array<[string, string]>
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>
  requestSeq?: number
}

export type ApprovalBlock = {
  kind: 'approval'
  title: string
  summary: string
  risk: 'destructive' | 'always' | 'budget' | 'unknown'
  options: AcpPermissionKind[]
  decisionKey?: string
  requestSeq?: number
  expiresAt?: string
}

type ChannelFormFieldBase = {
  name: string
  label: string
  required: boolean
  binding: 'input' | 'selection'
  /** Form component id for nested input. Omitted only for a direct binding. */
  inputKey?: string
}
export type ChannelFormField = ChannelFormFieldBase &
  (
    | { kind: 'text'; multiline?: boolean; maxLength?: number }
    | {
        kind: 'single'
        allowFreeText?: boolean
        options: readonly { value: string; label: string; description?: string }[]
      }
    | {
        kind: 'multi'
        allowFreeText?: boolean
        options: readonly { value: string; label: string; description?: string }[]
        minItems?: number
        maxItems?: number
      }
  )
export type ChannelSurfaceAction = Pick<
  UiActionParams,
  'sessionId' | 'surfaceId' | 'revision' | 'actionId' | 'input' | 'selection'
>
export type ChannelSurfaceBlock = {
  kind: 'surface'
  sessionId: string
  surfaceId: string
  revision: UiRevision
  title: string
  body?: string
  fallbackUrl: string
  form:
    | { state: 'open'; actionId: string; submitLabel: string; fields: readonly ChannelFormField[] }
    | { state: 'closed'; summary: string }
}

export type FileBlock = {
  kind: 'file'
  name: string
  mime: string
  bytes?: Uint8Array
  url?: string
}

export type LinkBlock = { kind: 'link'; title: string; url: string }

export type Block =
  | TextBlock
  | TableBlock
  | CardBlock
  | ApprovalBlock
  | ChannelSurfaceBlock
  | FileBlock
  | LinkBlock

export type MessageRef = {
  /** Verified send context retained for edits after transport restart. */
  accountId?: string
  chatType?: 'dm' | 'group'
  chatId: string
  messageId: string
  cardBizId?: string
}

export type ChatTarget = {
  /** Verified platform account for durable interaction correlation. */
  accountId?: string
  /** Verified chat type for sends after a transport restart. */
  chatType?: 'dm' | 'group'
  chatId: string
  threadId?: string
  /** Stable per-part delivery identity used by adapters that support remote idempotency keys. */
  deliveryKey?: string
}

export type ChannelMessage = {
  blocks: Block[]
  replyTo?: MessageRef
  ephemeral?: boolean
}

export type RenderContext = {
  sessionKey: string
  caps: ChannelCapabilities
  locale: string
}

export type ApprovalView = {
  requestSeq?: number
  decisionKey?: string
  summary: string
  risk: 'destructive' | 'always' | 'budget' | 'unknown'
  options: AcpPermissionKind[]
  expiresAt?: string
  requesterUserId?: string
}

export type SlotActionIntent = {
  requestSeq: number
  actionId: string
  credential: ChannelCredential
}

export type Attention = 'respond' | 'observe' | 'ignore'

export type ConnectOptions = {
  credentials: Record<string, string>
  signal: AbortSignal
  onEvent: (event: ChannelEvent) => void
  log: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
    error(message: string, meta?: Record<string, unknown>): void
  }
}

export interface ChannelAdapter {
  readonly manifest: ChannelManifest
  connect(options: ConnectOptions): Promise<void>
  disconnect(): Promise<void>
  toSession(event: ChannelEvent, context: { tenant: string; agent: string }): InboundIntent | null
  attention?(event: ChannelEvent): Attention
  resolveScope(event: ChannelEvent): { scope: string; isDirectMessage: boolean }
  render(node: UINode, context: RenderContext): ChannelMessage | null
  send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
  update(reference: MessageRef, message: ChannelMessage): Promise<void>
  react?(reference: MessageRef, emoji: string): Promise<void>
  renderApproval(request: ApprovalView, decisionKey?: string): ChannelMessage
  onApprovalAction(payload: ChannelEvent): ApprovalAction | null
  onSurfaceAction?(payload: ChannelEvent): ChannelSurfaceAction | null
  onSlotAction?(payload: ChannelEvent): SlotActionIntent | null
  credentialOf(event: ChannelEvent): ChannelCredential
  syncDirectory?(options: { since?: string; signal: AbortSignal }): AsyncIterable<DirectoryEntry>
  capabilities(): ChannelCapabilities
}

const SESSION_KEY_SEPARATOR = ':'

function sessionKeySegment(name: string, value: string): string {
  if (value.length === 0 || value.includes(SESSION_KEY_SEPARATOR)) {
    throw new Error(`session key segment ${name} invalid: ${JSON.stringify(value)}`)
  }
  return value
}

export function sessionKeyFor(input: {
  tenant: string
  agent: string
  channel: string
  chat: ChatRef
}): string {
  const scope = input.chat.type === 'dm' ? 'dm' : 'group'
  const base = [
    'agnes',
    sessionKeySegment('tenant', input.tenant),
    sessionKeySegment('agent', input.agent),
    sessionKeySegment('channel', input.channel),
    scope,
    sessionKeySegment('chat', input.chat.id),
  ].join(SESSION_KEY_SEPARATOR)

  if (input.chat.type !== 'thread') return base
  if (input.chat.threadId === undefined) {
    throw new Error('session key segment thread invalid: thread chat requires threadId')
  }
  return `${base}:thread:${sessionKeySegment('thread', input.chat.threadId)}`
}

export function whitelistCredential(
  credential: ChannelCredential,
  exposes: readonly string[],
): { cred: ChannelCredential; dropped: string[] } {
  const allowed = new Set(exposes)
  const kept: Array<[string, string]> = []
  const dropped: string[] = []

  // TypeBox's generated TRecord currently erases its index signature at some consumer sites.
  // The protocol schema still constrains every raw value to string, so narrow only that field here.
  const raw = (credential.raw ?? {}) as Record<string, string>
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key)) kept.push([key, value])
    else dropped.push(key)
  }

  return {
    cred: { ...credential, raw: Object.fromEntries(kept) },
    dropped,
  }
}
