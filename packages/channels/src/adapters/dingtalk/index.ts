import { createHash, randomUUID } from 'node:crypto'
import type {
  AcpPermissionKind,
  ApprovalAction,
  ChannelCapabilities,
  ChannelManifest,
  ContentBlock,
  UINode,
} from '@agnes/protocol'
import { fromAcpOptionKind } from '@agnes/protocol'
import type {
  ApprovalView,
  Attachment,
  ChannelAdapter,
  ChannelCredential,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  ConnectOptions,
  InboundIntent,
  MessageRef,
  RenderContext,
  SlotActionIntent,
} from '../../adapter.js'
import { sessionKeyFor, whitelistCredential } from '../../adapter.js'
import { degrade } from '../../degrade.js'
import { ChannelError } from '../../errors.js'
import { loadManifest } from '../../manifest.js'
import { backoffDelays } from '../../runner/backoff.js'
import { TokenBucket } from '../../runner/throttle.js'
import { buildCard, cardBizIdFor } from './cards.js'
import {
  attachmentsOf,
  isSafeAttachmentUrl,
  MAX_ATTACHMENT_BYTES,
  safeAttachmentMime,
  safeAttachmentName,
  toEvent,
} from './events.js'
import type { DingtalkGateway, RawCardCallback, RawRobotMessage } from './gateway.js'

const MAX_TRACKED_CHATS = 1_024
const MAX_RECONNECT_QUEUE = 100
const MAX_CALLBACK_VALUE_CHARS = 512
const MAX_CALLBACK_ID_CHARS = 256
const MAX_ACTION_ID_CHARS = 128

export type DingtalkOptions = {
  gateway?: DingtalkGateway
  snapshotPath?: string
  backoff?: { baseMs: number; maxMs: number }
  rate?: { perChatPerMin?: number; perAccountPerSec?: number }
  cardTemplateId?: string
}

type QueuedOutbound = {
  run(): Promise<void>
  reject(error: ChannelError): void
}

export class DingtalkAdapter implements ChannelAdapter {
  protected botUserId = ''
  private accountId = 'dingtalk'
  private onEvent: ((event: ChannelEvent) => void) | undefined
  private log: ConnectOptions['log'] | undefined
  private connectionEpoch = 0
  private readonly inboundLanes = new Map<string, Promise<void>>()
  private removeAbortListener: (() => void) | undefined
  private cancelReconnectDelay: (() => void) | undefined
  private connected = false
  private closed = true
  private reconnecting = false
  private reconnectRequested = false
  private everConnected = false
  private flushingOutbound = false
  private readonly outboundQueue: QueuedOutbound[] = []
  private readonly buckets = new Map<string, TokenBucket>()
  private readonly chatTargets = new Map<string, { conversationType: '1' | '2'; userId?: string }>()
  private readonly cardChats = new Map<string, { chatId: string; conversationType: '1' | '2' }>()
  private readonly chatTails = new Map<string, Promise<unknown>>()
  private readonly accountBucket: TokenBucket
  private outboundAbort = new AbortController()
  private parkedOutbound = 0

  constructor(
    readonly manifest: ChannelManifest,
    private readonly gateway: DingtalkGateway,
    protected readonly options: DingtalkOptions,
  ) {
    const perSecond = options.rate?.perAccountPerSec ?? manifest.limits.rate?.perAccountPerSec ?? 20
    if (!Number.isFinite(perSecond) || perSecond <= 0) {
      throw new ChannelError('E_CONFIG_INVALID', 'DingTalk per-account rate must be greater than zero')
    }
    this.accountBucket = new TokenBucket({
      tokensPerSecond: perSecond,
      capacity: Math.max(1, perSecond),
    })
  }

  async connect(options: ConnectOptions): Promise<void> {
    requireCredential(options.credentials, 'clientId')
    requireCredential(options.credentials, 'clientSecret')
    if (options.signal.aborted) {
      throw new ChannelError('E_CONNECT_FAILED', 'connection signal is already aborted')
    }
    if (this.outboundAbort.signal.aborted) this.outboundAbort = new AbortController()
    const credentialGateway = this.gateway as DingtalkGateway & {
      setCredentials?: (credentials: { clientId: string; clientSecret: string; robotCode?: string }) => void
    }
    credentialGateway.setCredentials?.({
      clientId: options.credentials.clientId as string,
      clientSecret: options.credentials.clientSecret as string,
      ...(options.credentials.robotCode === undefined ? {} : { robotCode: options.credentials.robotCode }),
    })
    this.accountId = options.credentials.robotCode ?? 'dingtalk'
    this.cardChats.clear()
    this.closed = false
    this.connected = false
    this.reconnectRequested = false
    this.onEvent = options.onEvent
    this.log = options.log
    try {
      await this.startGateway(options)
    } catch (error) {
      // A backend may allocate resources before start rejects. Best-effort cleanup must not
      // replace the original connection error or leave callbacks reachable afterwards.
      await this.gateway.stop().catch(() => undefined)
      this.closed = true
      this.connected = false
      this.reconnectRequested = false
      this.cancelReconnectDelay?.()
      this.cancelReconnectDelay = undefined
      this.onEvent = undefined
      this.log = undefined
      this.botUserId = ''
      this.rejectOutboundQueue('connection failed before queued sends could be delivered')
      this.removeAbortListener?.()
      this.removeAbortListener = undefined
      this.connectionEpoch++
      this.outboundAbort.abort(new ChannelError('E_CONNECT_FAILED', 'DingTalk adapter connection failed'))
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.connected = false
    this.reconnectRequested = false
    this.cancelReconnectDelay?.()
    this.cancelReconnectDelay = undefined
    this.removeAbortListener?.()
    this.removeAbortListener = undefined
    this.connectionEpoch++
    this.outboundAbort.abort(new ChannelError('E_CONNECT_FAILED', 'DingTalk adapter disconnected'))
    try {
      await this.gateway.stop()
    } finally {
      this.rejectOutboundQueue('adapter disconnected before queued sends could be delivered')
      this.onEvent = undefined
      this.log = undefined
      this.botUserId = ''
    }
  }

  capabilities(): ChannelCapabilities {
    return { ...this.manifest.capabilities }
  }

  protected handleRaw(message: RawRobotMessage, epoch = this.connectionEpoch): void {
    const conversationId = typeof message.conversationId === 'string' ? message.conversationId : ''
    const lane = `${epoch}:${conversationId}`
    const previous = this.inboundLanes.get(lane) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.deliverRaw(message, epoch))
    this.inboundLanes.set(lane, current)
    void current
      .finally(() => {
        if (this.inboundLanes.get(lane) === current) this.inboundLanes.delete(lane)
      })
      .catch(() => undefined)
  }

  toSession(event: ChannelEvent, context: { tenant: string; agent: string }): InboundIntent | null {
    if (event.kind !== 'message') return null
    const text = (event.mentions.bot ? event.text.replace(/^@\S+\s*/, '') : event.text).trim()
    const commandMatch = /^\/(help|status|new|cancel|preset)(?:\s+(.*))?$/.exec(text)
    const content: ContentBlock[] = text.length > 0 ? [{ type: 'text', text }] : []
    for (const attachment of event.attachments) {
      const resource = resourceLink(attachment)
      if (resource !== undefined) content.push(resource)
    }
    if (content.length === 0) return null
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
      content,
      kind: commandMatch === null ? 'message' : 'command',
      ...(commandMatch === null
        ? {}
        : {
            command: {
              name: commandMatch[1] as string,
              args: (commandMatch[2] ?? '').split(/\s+/).filter(Boolean),
            },
          }),
    }
  }

  resolveScope(event: ChannelEvent): { scope: string; isDirectMessage: boolean } {
    return { scope: event.chat.id, isDirectMessage: event.chat.type === 'dm' }
  }

  credentialOf(event: ChannelEvent): ChannelCredential {
    const credential: ChannelCredential = {
      kind: 'channel',
      channel: this.manifest.id,
      accountId: event.accountId,
      userId: event.sender.userId,
      chatId: event.chat.id,
      chatType: event.chat.type,
      ...(event.sender.unionId === undefined ? {} : { unionId: event.sender.unionId }),
      ...(event.sender.displayName === undefined ? {} : { displayName: event.sender.displayName }),
      raw: event.sender.raw,
    }
    return whitelistCredential(credential, this.manifest.credentials.exposes).cred
  }

  render(_node: UINode, _context: RenderContext): ChannelMessage | null {
    return null
  }

  async send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef> {
    return this.scheduleOutbound(target.chatId, () =>
      this.whenConnected(target.chatId, () => this.sendNow(target, message)),
    )
  }

  async update(reference: MessageRef, message: ChannelMessage): Promise<void> {
    return this.scheduleOutbound(reference.chatId, () =>
      this.whenConnected(reference.chatId, () => this.updateNow(reference, message)),
    )
  }

  protected async sendNow(_target: ChatTarget, _message: ChannelMessage): Promise<MessageRef> {
    const target = this.dingtalkTarget(_target)
    if (_message.ephemeral === true) {
      const { processQueryKey } = await this.gateway.sendMarkdown(
        target,
        ' ',
        markdownForEphemeral(_message, this.capabilities()),
      )
      return { chatId: _target.chatId, messageId: processQueryKey }
    }
    const cardBizId = cardBizIdFor(_target.chatId, _target.deliveryKey ?? randomUUID())
    const { cardData } = buildCard(_message.blocks, { cardBizId }, this.manifest.limits.cardBytes)
    await this.gateway.createCard(cardBizId, cardData, target)
    this.rememberCard(cardBizId, _target.chatId, target.conversationType)
    return { chatId: _target.chatId, messageId: cardBizId, cardBizId }
  }

  protected async updateNow(_reference: MessageRef, _message: ChannelMessage): Promise<void> {
    if (_reference.cardBizId === undefined) {
      throw new ChannelError('E_NOT_IMPLEMENTED', 'DingTalk markdown messages cannot be updated')
    }
    const { cardData } = buildCard(
      _message.blocks,
      { cardBizId: _reference.cardBizId },
      this.manifest.limits.cardBytes,
    )
    await this.gateway.updateCard(_reference.cardBizId, cardData)
  }

  renderApproval(request: ApprovalView, ticket?: string): ChannelMessage {
    return {
      blocks: [
        {
          kind: 'approval',
          title: '需要审批',
          summary: request.summary,
          risk: request.risk,
          options: request.options,
          ...((ticket ?? request.ticket) === undefined ? {} : { ticket: ticket ?? request.ticket }),
          ...(request.requestSeq === undefined ? {} : { requestSeq: request.requestSeq }),
          ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
        },
      ],
    }
  }

  protected handleCard(callback: RawCardCallback, epoch = this.connectionEpoch): void {
    if (this.closed || epoch !== this.connectionEpoch) return
    try {
      const raw = callback as unknown as Record<string, unknown>
      const cardBizId = boundedString(raw.outTrackId, MAX_CALLBACK_ID_CHARS)
      const userId = boundedString(raw.userId, MAX_CALLBACK_ID_CHARS)
      const privateData = raw.cardPrivateData
      if (cardBizId === null || userId === null || !isRecord(privateData)) return
      const actionIds = privateData.actionIds
      if (!Array.isArray(actionIds) || actionIds.length !== 1) return
      const value = boundedString(actionIds[0], MAX_CALLBACK_VALUE_CHARS)
      if (value === null) return

      const remembered = this.cardChats.get(cardBizId)
      const suppliedChat = optionalBoundedString(raw.conversationId, MAX_CALLBACK_ID_CHARS)
      if (
        suppliedChat === false ||
        (remembered !== undefined && suppliedChat && suppliedChat !== remembered.chatId)
      )
        return
      const chatId = suppliedChat || remembered?.chatId
      if (chatId === undefined) return
      const suppliedType = raw.conversationType
      if (suppliedType !== undefined && suppliedType !== '1' && suppliedType !== '2') return
      if (
        remembered !== undefined &&
        suppliedType !== undefined &&
        suppliedType !== remembered.conversationType
      )
        return
      const conversationType = suppliedType ?? remembered?.conversationType ?? '2'
      const chatType = conversationType === '1' ? 'dm' : 'group'
      const eventId = createHash('sha256')
        .update(JSON.stringify([cardBizId, value, userId, chatId, conversationType]))
        .digest('hex')
      this.onEvent?.({
        kind: 'cardAction',
        eventId: `dingtalk-card:${eventId}`,
        accountId: this.accountId,
        at: new Date().toISOString(),
        chat: { id: chatId, type: chatType },
        sender: {
          userId,
          raw: { staffId: userId, conversationId: chatId, conversationType },
        },
        cardBizId,
        value,
      })
    } catch {
      this.safeWarn('Dingtalk card callback was invalid and has been dropped')
    }
  }

  onApprovalAction(event: ChannelEvent): ApprovalAction | null {
    if (event.kind !== 'cardAction' || event.value.length > MAX_CALLBACK_VALUE_CHARS) return null
    const match = /^appr:([^:\s]+):(allow_once|allow_always|reject_once|reject_always)$/.exec(event.value)
    if (match === null) return null
    const key = match[1] as string
    if (key.length === 0 || key.length > MAX_ACTION_ID_CHARS) return null
    const option = match[2] as AcpPermissionKind
    const verdict = fromAcpOptionKind(option)
    if (verdict === 'cancelled' || verdict === 'unavailable') return null
    if (key.startsWith('#')) {
      const requestSeq = Number(key.slice(1))
      if (!Number.isSafeInteger(requestSeq) || requestSeq < 1) return null
      return { requestSeq, verdict, approverCredential: this.credentialOf(event) }
    }
    return { ticket: key, verdict, approverCredential: this.credentialOf(event) }
  }

  onSlotAction(event: ChannelEvent): SlotActionIntent | null {
    if (event.kind !== 'cardAction' || event.value.length > MAX_CALLBACK_VALUE_CHARS) return null
    const match = /^slot:(\d+):(.+)$/.exec(event.value)
    if (match === null) return null
    const requestSeq = Number(match[1])
    const actionId = match[2] as string
    if (!Number.isSafeInteger(requestSeq) || requestSeq < 1 || actionId.length > MAX_ACTION_ID_CHARS)
      return null
    return { requestSeq, actionId, credential: this.credentialOf(event) }
  }

  protected handleDisconnect(_error: Error, options: ConnectOptions, epoch = this.connectionEpoch): void {
    if (this.closed || options.signal.aborted || epoch !== this.connectionEpoch) return
    this.connected = false
    this.connectionEpoch++
    this.removeAbortListener?.()
    this.removeAbortListener = undefined
    // This seam does not own the secrets map and therefore cannot safely redact arbitrary
    // backend messages. Keep the log stable and leave detailed, redacted diagnostics to the
    // real gateway implementation.
    this.safeWarn('Dingtalk stream disconnected; reconnecting')
    this.reconnectRequested = true
    this.startReconnectDriver(options)
  }

  private async startGateway(options: ConnectOptions): Promise<number> {
    if (this.closed || options.signal.aborted) {
      throw new ChannelError('E_CONNECT_FAILED', 'connection was aborted during startup')
    }
    const epoch = ++this.connectionEpoch
    this.removeAbortListener?.()
    const onAbort = () => {
      if (this.connectionEpoch !== epoch) return
      this.closed = true
      this.connected = false
      this.reconnectRequested = false
      this.connectionEpoch++
      this.outboundAbort.abort(new ChannelError('E_CONNECT_FAILED', 'DingTalk adapter connection aborted'))
      this.cancelReconnectDelay?.()
      this.cancelReconnectDelay = undefined
      this.onEvent = undefined
      this.log = undefined
      this.botUserId = ''
      this.rejectOutboundQueue('connection aborted before queued sends could be delivered')
    }
    const removeAbortListener = () => options.signal.removeEventListener('abort', onAbort)
    this.removeAbortListener = removeAbortListener
    options.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const { botUserId } = await this.gateway.start(
        {
          onMessage: (message) => this.handleRaw(message, epoch),
          onCard: (callback) => this.handleCard(callback, epoch),
          onDisconnect: (error) => this.handleDisconnect(error, options, epoch),
        },
        options.signal,
      )
      if (epoch !== this.connectionEpoch || options.signal.aborted || this.closed) {
        throw new ChannelError('E_CONNECT_FAILED', 'connection was aborted during startup')
      }
      this.botUserId = botUserId
      this.connected = true
      this.everConnected = true
      this.startOutboundFlush()
      return epoch
    } catch (error) {
      if (this.removeAbortListener === removeAbortListener) {
        removeAbortListener()
        this.removeAbortListener = undefined
      }
      if (this.connectionEpoch === epoch) this.connectionEpoch++
      throw error
    }
  }

  private startReconnectDriver(options: ConnectOptions): void {
    if (this.reconnecting) return
    this.reconnecting = true
    void this.runReconnectDriver(options)
      .catch(() => undefined)
      .finally(() => {
        this.reconnecting = false
        if (this.reconnectRequested && !this.closed && !options.signal.aborted) {
          this.startReconnectDriver(options)
        }
      })
  }

  private async runReconnectDriver(options: ConnectOptions): Promise<void> {
    while (this.reconnectRequested && !this.closed && !options.signal.aborted) {
      this.reconnectRequested = false
      await this.reconnect(options)
    }
  }

  private async reconnect(options: ConnectOptions): Promise<void> {
    const delays = backoffDelays(this.options.backoff)
    for (let attempt = 1; !this.closed && !options.signal.aborted; attempt++) {
      try {
        const epoch = await this.startGateway(options)
        if (epoch !== this.connectionEpoch || !this.connected) continue
        this.safeInfo('Dingtalk stream reconnected', { attempt })
        return
      } catch {
        // Failed and superseded starts may both allocate resources. Clean them up before the
        // next serial attempt without exposing backend error text to logs.
        await this.gateway.stop().catch(() => undefined)
        if (this.closed || options.signal.aborted) return
        this.safeWarn('Dingtalk reconnect attempt failed', { attempt })
        await this.waitForReconnect(delays.next().value, options.signal)
      }
    }
  }

  private waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        if (this.cancelReconnectDelay === finish) this.cancelReconnectDelay = undefined
        resolve()
      }
      timer = setTimeout(finish, delayMs)
      this.cancelReconnectDelay = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private bucket(chatId: string): TokenBucket {
    let bucket = this.buckets.get(chatId)
    if (bucket !== undefined) {
      this.buckets.delete(chatId)
      this.buckets.set(chatId, bucket)
      return bucket
    }
    this.trimChatState(this.buckets, 1)
    const perMinute = this.options.rate?.perChatPerMin ?? this.manifest.limits.rate?.perChatPerMin ?? 20
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      throw new ChannelError('E_CONFIG_INVALID', 'DingTalk per-chat rate must be greater than zero')
    }
    bucket = new TokenBucket({
      tokensPerSecond: perMinute / 60,
      capacity: Math.max(1, Math.min(perMinute, 5)),
    })
    this.buckets.set(chatId, bucket)
    return bucket
  }

  private async dispatchOutbound<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const signal = this.outboundAbort.signal
    await this.bucket(chatId).take(signal)
    await this.accountBucket.take(signal)
    signal.throwIfAborted()
    if (this.everConnected && !this.connected) {
      throw new ChannelError('E_CONNECT_FAILED', 'DingTalk adapter is not connected')
    }
    return operation()
  }

  private scheduleOutbound<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.chatTails.has(chatId) && this.chatTails.size >= MAX_TRACKED_CHATS) {
      return Promise.reject(new ChannelError('E_CONNECT_FAILED', 'DingTalk active chat capacity reached'))
    }
    const parked = !this.connected && !this.closed
    if (parked && this.parkedOutbound >= MAX_RECONNECT_QUEUE) {
      return Promise.reject(
        new ChannelError('E_CONNECT_FAILED', 'send queue full while DingTalk is reconnecting'),
      )
    }
    if (parked) this.parkedOutbound++
    const previous = this.chatTails.get(chatId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.chatTails.set(chatId, current)
    void current
      .finally(() => {
        if (parked) this.parkedOutbound--
        if (this.chatTails.get(chatId) === current) this.chatTails.delete(chatId)
      })
      .catch(() => undefined)
    return current
  }

  private whenConnected<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    if (this.connected && !this.flushingOutbound) {
      const epoch = this.connectionEpoch
      return this.dispatchOutbound(chatId, operation).catch((error: unknown) => {
        if (!this.closed && this.connectionEpoch !== epoch) {
          return this.queueOutbound(chatId, operation)
        }
        throw error
      })
    }
    if (this.closed) {
      // Task 19's fake-gateway conformance sends before connect. Preserve that narrow test seam,
      // while an explicitly disconnected production adapter remains terminal.
      if (!this.everConnected) return this.dispatchOutbound(chatId, operation)
      return Promise.reject(new ChannelError('E_CONNECT_FAILED', 'DingTalk adapter is disconnected'))
    }
    return this.queueOutbound(chatId, operation)
  }

  private queueOutbound<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    if (this.outboundQueue.length >= 100) {
      return Promise.reject(
        new ChannelError('E_CONNECT_FAILED', 'send queue full while DingTalk is reconnecting'),
      )
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedOutbound = {
        run: async () => {
          const epoch = this.connectionEpoch
          try {
            resolve(await this.dispatchOutbound(chatId, operation))
          } catch (error) {
            if (!this.closed && this.connectionEpoch !== epoch) {
              this.outboundQueue.unshift(queued)
              return
            }
            reject(error)
          }
        },
        reject,
      }
      this.outboundQueue.push(queued)
      if (this.connected) this.startOutboundFlush()
    })
  }

  private startOutboundFlush(): void {
    if (this.flushingOutbound) return
    this.flushingOutbound = true
    void (async () => {
      while (this.connected) {
        const queued = this.outboundQueue.shift()
        if (queued === undefined) break
        await queued.run()
      }
    })().finally(() => {
      this.flushingOutbound = false
      if (this.connected && this.outboundQueue.length > 0) this.startOutboundFlush()
    })
  }

  private rejectOutboundQueue(message: string): void {
    const error = new ChannelError('E_CONNECT_FAILED', message)
    for (const queued of this.outboundQueue.splice(0)) queued.reject(error)
  }

  private async deliverRaw(message: RawRobotMessage, epoch: number): Promise<void> {
    let attachments: Attachment[] = []
    try {
      attachments = await attachmentsOf(message, (downloadCode, maxBytes) =>
        this.gateway.download(downloadCode, maxBytes),
      )
    } catch {
      this.safeWarn('Dingtalk attachment download failed; continuing without attachment')
    }
    try {
      const event = toEvent(message, this.botUserId, attachments)
      if (epoch === this.connectionEpoch) {
        this.rememberTarget(message)
        this.onEvent?.(event)
      }
    } catch {
      this.safeWarn('Dingtalk inbound message was invalid and has been dropped')
    }
  }

  private dingtalkTarget(target: ChatTarget): {
    conversationId: string
    conversationType: '1' | '2'
    userIds?: string[]
  } {
    const remembered = this.chatTargets.get(target.chatId)
    if (remembered !== undefined) {
      this.chatTargets.delete(target.chatId)
      this.chatTargets.set(target.chatId, remembered)
    }
    const conversationType = remembered?.conversationType ?? '2'
    return {
      conversationId: target.chatId,
      conversationType,
      ...(conversationType === '1' && remembered?.userId !== undefined
        ? { userIds: [remembered.userId] }
        : {}),
    }
  }

  private rememberTarget(message: RawRobotMessage): void {
    this.chatTargets.delete(message.conversationId)
    this.chatTargets.set(message.conversationId, {
      conversationType: message.conversationType,
      ...(message.conversationType === '1' ? { userId: message.senderStaffId } : {}),
    })
    this.trimChatState(this.chatTargets)
  }

  private rememberCard(cardBizId: string, chatId: string, conversationType: '1' | '2'): void {
    this.cardChats.delete(cardBizId)
    this.cardChats.set(cardBizId, { chatId, conversationType })
    while (this.cardChats.size > MAX_TRACKED_CHATS) {
      const oldest = this.cardChats.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cardChats.delete(oldest)
    }
  }

  private trimChatState(map: Map<string, unknown>, reserve = 0): void {
    while (map.size + reserve > MAX_TRACKED_CHATS) {
      const candidate = [...map.keys()].find((key) => !this.chatTails.has(key))
      if (candidate === undefined) {
        throw new ChannelError('E_CONNECT_FAILED', 'DingTalk active chat capacity reached')
      }
      map.delete(candidate)
    }
  }

  private safeInfo(message: string, meta?: Record<string, unknown>): void {
    try {
      this.log?.info(message, meta)
    } catch {
      // A logger must not break stream callback isolation.
    }
  }

  private safeWarn(message: string, meta?: Record<string, unknown>): void {
    try {
      this.log?.warn(message, meta)
    } catch {
      // A logger must not break stream callback isolation.
    }
  }
}

export async function createDingtalkAdapter(
  manifestPath: string,
  options: DingtalkOptions = {},
): Promise<ChannelAdapter> {
  const manifest = await loadManifest(manifestPath)
  const gateway =
    options.gateway ??
    (await import('./gateway-real.js')).createRealGateway({
      ...(options.cardTemplateId === undefined ? {} : { cardTemplateId: options.cardTemplateId }),
    })
  return new DingtalkAdapter(manifest, gateway, options)
}

function requireCredential(credentials: Record<string, string>, key: string): void {
  if (typeof credentials[key] !== 'string' || credentials[key]?.length === 0) {
    throw new ChannelError('E_CONNECT_FAILED', `missing ${key}`, { key })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars ? value : null
}

function optionalBoundedString(value: unknown, maxChars: number): string | undefined | false {
  if (value === undefined) return undefined
  return boundedString(value, maxChars) ?? false
}

function resourceLink(attachment: Attachment): ContentBlock | undefined {
  let uri: string | undefined
  if (attachment.url !== undefined && isSafeAttachmentUrl(attachment.url)) {
    uri = attachment.url
  } else if (attachment.bytes instanceof Uint8Array && attachment.bytes.length <= MAX_ATTACHMENT_BYTES) {
    uri = `attachment://${createHash('sha256').update(attachment.bytes).digest('hex')}`
  }
  if (uri === undefined) return undefined
  return {
    type: 'resource_link',
    uri,
    name: safeAttachmentName(attachment.name, 'attachment'),
    mimeType: safeAttachmentMime(attachment.mime),
  }
}

function markdownForEphemeral(message: ChannelMessage, capabilities: ChannelCapabilities): string {
  return degrade(message, { ...capabilities, card: false, attachment: false })
    .msg.blocks.map((block) => {
      switch (block.kind) {
        case 'text':
          return block.markdown
        case 'link':
          return `[${block.title}](${block.url})`
        case 'file':
          return block.url === undefined ? `${block.name}（无可发送链接）` : `[${block.name}](${block.url})`
        case 'table':
        case 'card':
        case 'approval':
          return ''
      }
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n\n')
}

export default createDingtalkAdapter
