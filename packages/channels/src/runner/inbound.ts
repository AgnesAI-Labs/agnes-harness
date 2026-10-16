import { createHash } from 'node:crypto'
import { AGNES_ERRORS } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk'
import type {
  ChannelAdapter,
  ChannelCredential,
  ChannelEvent,
  ChatTarget,
  InboundIntent,
} from '../adapter.js'
import { whitelistCredential } from '../adapter.js'
import { isApprovalText } from './approval.js'
import { decideAttention } from './attention.js'
import { parseCommand, runCommand } from './commands.js'
import type { RunnerConfig } from './config.js'
import { historyRefusalText, shouldAck } from './notices.js'
import type { BoundSession, SessionCache } from './session-cache.js'

export { SessionCache } from './session-cache.js'

export function commandIdFor(sessionKey: string, messageId: string): string {
  return createHash('sha256').update(`${sessionKey}\n${messageId}`).digest('hex')
}

type Log = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

type CachePort = Pick<SessionCache, 'get' | 'busy' | 'current' | 'markParticipant' | 'unmarkParticipant'>

export type InboundDeps = {
  adapter: ChannelAdapter
  claim: { once(kind: string, value: string, expiresAtMs?: number): Promise<boolean> }
  joinParticipant?: (sessionKey: string, credential: ChannelCredential) => Promise<void>
  cache: CachePort
  config: {
    allowFrom: string[]
    requireMention: boolean
    tenant: string
    agent: string
    ackReaction?: RunnerConfig['ackReaction']
  }
  log: Log
  onCreated?: (key: string, session: BoundSession) => void
  onSession?: (key: string, session: BoundSession, chat: ChatTarget, requesterUserId: string) => void
  handleText?: (
    key: string,
    session: BoundSession,
    event: Extract<ChannelEvent, { kind: 'message' }>,
  ) => Promise<boolean>
  onNewSession?: (oldKey: string) => Promise<void>
  onHistoryRefused?: (key: string) => void
  signal?: AbortSignal
  maxPendingLanes?: number
  ackTimeoutMs?: number
}

export class Inbound {
  private readonly lanes = new Map<string, Promise<void>>()
  // Keep refusals even after cache eviction: queued/new messages must never reopen that history.
  private readonly refused = new Set<string>()

  constructor(private readonly dependencies: InboundDeps) {}

  handle(event: ChannelEvent): Promise<void> {
    const intent = this.dependencies.adapter.toSession(event, {
      tenant: this.dependencies.config.tenant,
      agent: this.dependencies.config.agent,
    })
    if (intent === null) return Promise.resolve()
    if (this.refused.has(intent.sessionKey) && !isNewSession(intent)) return Promise.resolve()

    const maxPendingLanes = Math.max(1, this.dependencies.maxPendingLanes ?? 1_024)
    // Refusal markers are not evicted to make room; at capacity, fail closed for new routes.
    if (
      !this.lanes.has(intent.sessionKey) &&
      !this.refused.has(intent.sessionKey) &&
      this.dependencies.cache.current(intent.sessionKey) === undefined &&
      this.lanes.size + this.refused.size >= maxPendingLanes
    ) {
      this.safeWarn('channel inbound lane capacity reached; dropping event', {
        sessionKey: intent.sessionKey,
      })
      return Promise.resolve()
    }
    const previous = this.lanes.get(intent.sessionKey) ?? Promise.resolve()
    let current: Promise<void>
    current = previous
      .catch(() => undefined)
      .then(() => this.process(event, intent))
      .catch(async (error: unknown) => {
        if (!(await this.refuseHistory(intent.sessionKey, chatTarget(event), error))) throw error
      })
      .finally(() => {
        if (this.lanes.get(intent.sessionKey) === current) this.lanes.delete(intent.sessionKey)
      })
    this.lanes.set(intent.sessionKey, current)
    return current
  }

  async refuseHistory(key: string, target: ChatTarget, error: unknown): Promise<boolean> {
    const text = historyRefusalText(error)
    if (text === null) return false
    if (this.refused.has(key)) return true
    this.refused.add(key)
    const sessionId = this.dependencies.cache.current(key)?.id ?? key
    this.dependencies.onHistoryRefused?.(key)
    if (this.isStopped()) return true
    try {
      // One delivery attempt, with a stable id for adapters that support deduplication. A send
      // failure must neither retry the session nor erase its terminal marker.
      await this.dependencies.adapter.send(
        { ...target, deliveryKey: commandIdFor(sessionId, 'history-refusal') },
        { blocks: [{ kind: 'text', markdown: text }] },
      )
    } catch {
      this.safeWarn('channel history refusal notice delivery failed')
    }
    return true
  }

  private async process(event: ChannelEvent, intent: InboundIntent): Promise<void> {
    if (this.isStopped() || (this.refused.has(intent.sessionKey) && !isNewSession(intent))) return
    const attention =
      this.dependencies.adapter.attention?.(event) ??
      decideAttention(event, this.dependencies.config, intent.kind === 'command')
    const possibleApproval = event.kind === 'message' && isApprovalText(event.text)
    if (attention !== 'respond' && !possibleApproval) return

    const claimKey = `${this.dependencies.adapter.manifest.id}:${intent.credential.accountId}:${intent.eventId}`
    let fresh = false
    try {
      fresh = await this.dependencies.claim.once('channel-event', claimKey)
    } catch {
      this.safeWarn('channel event claim unavailable; treating event as already processed')
    }
    if (!fresh) return

    if (this.refused.has(intent.sessionKey)) {
      if (this.dependencies.onNewSession === undefined) return
      await this.dependencies.onNewSession(intent.sessionKey)
      this.refused.delete(intent.sessionKey)
      await this.dependencies.adapter.send(chatTarget(event), {
        blocks: [{ kind: 'text', markdown: '已开始新会话' }],
        ephemeral: true,
      })
      return
    }

    if (
      event.kind === 'message' &&
      this.dependencies.adapter.capabilities().reactions === true &&
      this.dependencies.adapter.react !== undefined &&
      shouldAck(
        this.dependencies.config.ackReaction ?? 'off',
        event.chat.type,
        event.mentions.bot || event.mentions.replyToBot || event.mentions.quoteBot,
      )
    ) {
      this.acknowledge(event)
    }

    const { session, created } = await this.dependencies.cache.get(intent.sessionKey)
    if (this.refused.has(intent.sessionKey)) return
    if (
      possibleApproval &&
      event.kind === 'message' &&
      (await this.dependencies.handleText?.(intent.sessionKey, session, event))
    ) {
      return
    }
    if (attention !== 'respond') return
    if (created) this.dependencies.onCreated?.(intent.sessionKey, session)
    const credential = whitelistCredential(
      intent.credential,
      this.dependencies.adapter.manifest.credentials.exposes,
    ).cred
    this.dependencies.onSession?.(
      intent.sessionKey,
      session,
      {
        chatId: event.chat.id,
        ...(event.chat.threadId === undefined ? {} : { threadId: event.chat.threadId }),
      },
      credential.userId,
    )
    if (
      this.dependencies.joinParticipant !== undefined &&
      this.dependencies.cache.markParticipant(intent.sessionKey, credential.userId)
    ) {
      try {
        await this.dependencies.joinParticipant(intent.sessionKey, credential)
      } catch {
        // A failed daemon call must remain retryable on the next event. Keeping the optimistic
        // marker would permanently skip identity binding while continuing to submit messages.
        this.dependencies.cache.unmarkParticipant(intent.sessionKey, credential.userId)
        this.safeWarn('channel participant join failed', { sessionKey: intent.sessionKey })
      }
    }

    if (intent.kind === 'command' && intent.command !== undefined) {
      const command = parseCommand(`/${intent.command.name} ${intent.command.args.join(' ')}`)
      if (command !== null) {
        const text = await runCommand(command, {
          session,
          newSession: async () => {
            await this.dependencies.onNewSession?.(intent.sessionKey)
          },
        })
        await this.dependencies.adapter.send(
          {
            chatId: event.chat.id,
            ...(event.chat.threadId === undefined ? {} : { threadId: event.chat.threadId }),
          },
          { blocks: [{ kind: 'text', markdown: text }], ephemeral: true },
        )
        return
      }
    }

    await this.dispatch(session, intent)
  }

  private async dispatch(session: BoundSession, intent: InboundIntent): Promise<void> {
    if (this.refused.has(intent.sessionKey)) return
    const options = { commandId: commandIdFor(intent.sessionKey, intent.messageId) }
    if (this.dependencies.cache.busy(intent.sessionKey)) {
      try {
        await session.steer(intent.content, options)
        return
      } catch (error) {
        if (!(error instanceof JsonRpcError) || error.code !== AGNES_ERRORS.SESSION_BUSY) throw error
      }
    }
    if (this.refused.has(intent.sessionKey)) return
    await session.followUp(intent.content, options)
  }

  private safeWarn(message: string, meta?: Record<string, unknown>): void {
    try {
      this.dependencies.log.warn(message, meta)
    } catch {
      // Diagnostics must not break or replay the session lane.
    }
  }

  private acknowledge(event: Extract<ChannelEvent, { kind: 'message' }>): void {
    const reaction = this.dependencies.adapter.react
    if (reaction === undefined || this.isStopped()) return
    void settleReaction(
      Promise.resolve().then(() =>
        reaction.call(this.dependencies.adapter, { chatId: event.chat.id, messageId: event.messageId }, '👀'),
      ),
      this.dependencies.ackTimeoutMs ?? 1_000,
      this.dependencies.signal,
    ).catch(() => this.safeWarn('channel acknowledgement reaction failed', { eventId: event.eventId }))
  }

  private isStopped(): boolean {
    return this.dependencies.signal?.aborted === true
  }
}

function isNewSession(intent: InboundIntent): boolean {
  return intent.kind === 'command' && intent.command?.name === 'new'
}

function chatTarget(event: ChannelEvent): ChatTarget {
  return {
    chatId: event.chat.id,
    ...(event.chat.threadId === undefined ? {} : { threadId: event.chat.threadId }),
  }
}

function settleReaction(work: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (error === undefined) resolve()
      else reject(error)
    }
    const aborted = (): void => finish()
    const timer = setTimeout(() => finish(new Error('channel acknowledgement reaction timed out')), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', aborted, { once: true })
    void work.then(() => finish(), finish)
  })
}
