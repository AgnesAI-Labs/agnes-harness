import { createHash } from 'node:crypto'
import { type AcpPermissionKind, AGNES_ERRORS, fromAcpOptionKind } from '@agnes/protocol'
import {
  type Client,
  JsonRpcError,
  type PermissionOutcome,
  type PermissionRequest,
  type Session,
} from '@agnes/sdk'
import {
  type ChannelAdapter,
  type ChannelEvent,
  type ChatTarget,
  type MessageEvent,
  type MessageRef,
  whitelistCredential,
} from '../adapter.js'
import { escapeText } from '../degrade.js'
import type { RunnerConfig } from './config.js'

type Log = {
  warn(message: string, meta?: Record<string, unknown>): void
}

type Verdict = 'allowed-once' | 'allowed-session' | 'rejected'

// Wire actions carry the full protocol ApprovalVerdict ('allowed-permanent' included, for the
// durable-grant flow other surfaces support). Channels never renders a "grant permanently" button
// (OFFERED_OPTION_KINDS has no counterpart for it) and has no card affordance for it, so a verdict
// outside this set is treated as an unauthorized action rather than forwarded — the same rule the
// requestSeq path already applies via `pending.offered.has(...)`.
const KNOWN_VERDICTS = new Set<Verdict>(['allowed-once', 'allowed-session', 'rejected'])
function isKnownVerdict(v: string): v is Verdict {
  return KNOWN_VERDICTS.has(v as Verdict)
}

type Pending = {
  sessionKey: string
  ref: Promise<MessageRef>
  reference?: MessageRef
  chat: ChatTarget
  requesterUserId?: string
  offered: Set<Verdict>
  resolve(outcome: PermissionOutcome): void
  timer?: ReturnType<typeof setTimeout>
  signal: AbortSignal
  abort(): void
}

type Dependencies = {
  adapter: ChannelAdapter
  client: {
    approval: Pick<Client['approval'], 'decide'>
    claim: Pick<Client['claim'], 'once'>
    call?: Client['call']
  }
  cfg: Pick<RunnerConfig, 'allowFrom'>
  log: Log
  clock?: () => number
  signal?: AbortSignal
  slotActionTimeoutMs?: number
  validateSlotAction?: (
    sessionKey: string,
    event: ChannelEvent,
    requestSeq: number,
    actionId: string,
  ) => Promise<string | false>
}

const REJECTED: PermissionOutcome = { verdict: 'rejected' }
const APPROVAL_TEXT = /^(同意|拒绝)\s+(\S{6,128})$/
const MAX_CALLBACK_CHARS = 512
const MAX_ACTION_CHARS = 128
const ACTION_TTL_MS = 5 * 60_000
const MAX_RECENT_ACTIONS = 4_096

type RecentAction = { at: number; pending: boolean; work: Promise<void> }

export function isApprovalText(text: string): boolean {
  return APPROVAL_TEXT.test(text.trim())
}

function summaryOf(toolCall: Record<string, unknown>): string {
  const name = String(toolCall.name ?? toolCall.title ?? 'tool').slice(0, 64)
  if (!toolCall.args || typeof toolCall.args !== 'object') return name
  try {
    return `${name} ${JSON.stringify(toolCall.args).slice(0, 200)}`
  } catch {
    return name
  }
}

function outcomeOf(kind: AcpPermissionKind): Verdict {
  const verdict = fromAcpOptionKind(kind)
  return verdict === 'allowed-once' || verdict === 'allowed-session' ? verdict : 'rejected'
}

export class Approval {
  private readonly pending = new Map<number, Pending>()
  private readonly recentSlotActions = new Map<string, RecentAction>()
  private readonly recentParkedActions = new Map<string, RecentAction>()
  private sequence = 0

  constructor(private readonly dependencies: Dependencies) {}

  watch(
    sessionKey: string,
    session: Pick<Session, 'onPermissionRequest'>,
    chat: ChatTarget,
    requesterOf: () => string | undefined,
  ): () => void {
    const unsubscribe = session.onPermissionRequest((request, context) =>
      this.ask(sessionKey, request, chat, requesterOf(), context.signal),
    )
    return () => {
      unsubscribe()
      for (const [requestSeq, pending] of this.pending) {
        if (pending.sessionKey === sessionKey) this.finish(requestSeq, pending, REJECTED)
      }
    }
  }

  async handleAction(event: ChannelEvent): Promise<boolean> {
    if (event.kind === 'cardAction' && event.value.length > MAX_CALLBACK_CHARS) {
      await this.notice(chatOf(event), '无效操作')
      return true
    }
    const action = this.dependencies.adapter.onApprovalAction(event)
    if (!action) return false
    const actionChat = chatOf(event)
    if ('ticket' in action) {
      if (action.ticket.length === 0 || action.ticket.length > MAX_ACTION_CHARS) {
        await this.notice(actionChat, '审批无效')
        return true
      }
      if (!isKnownVerdict(action.verdict)) {
        await this.notice(actionChat, '无权审批')
        return true
      }
      return this.decideParked(action.ticket, action.verdict, event, actionChat)
    }
    const requestSeq = action.requestSeq
    const pending = this.pending.get(requestSeq)
    if (!pending) {
      await this.notice(actionChat, '该审批已处理')
      return true
    }

    let reference = pending.reference
    if (reference === undefined) {
      try {
        reference = await pending.ref
      } catch {
        return true
      }
      if (this.pending.get(requestSeq) !== pending) {
        await this.notice(actionChat, '该审批已处理')
        return true
      }
      pending.reference = reference
    }
    const expectedCardId = reference.cardBizId ?? reference.messageId
    if (event.kind !== 'cardAction' || event.cardBizId !== expectedCardId) {
      await this.notice(actionChat, '无权审批')
      return true
    }

    const credential = this.credentialOf(event)
    const approver = credential.kind === 'channel' ? credential.userId : ''
    const denied = this.denied(approver, pending.requesterUserId)
    const offered = isKnownVerdict(action.verdict) && pending.offered.has(action.verdict)
    if (!sameChat(pending.chat, actionChat) || denied !== null || !offered) {
      await this.notice(actionChat, denied ?? '无权审批')
      return true
    }

    this.finish(requestSeq, pending, { verdict: action.verdict })
    const label = escapeText((credential.displayName ?? approver).slice(0, 128))
    const status = action.verdict === 'rejected' ? '已拒绝' : '已批准'
    await pending.ref
      .then((ref) =>
        this.dependencies.adapter.update(ref, {
          blocks: [{ kind: 'text', markdown: `${status} by ${label}` }],
        }),
      )
      .catch(() => this.safeWarn('channel approval card update failed', { requestSeq }))
    return true
  }

  async handleText(
    _sessionKey: string,
    session: Pick<Session, 'projectUI'>,
    event: MessageEvent,
  ): Promise<boolean> {
    const match = APPROVAL_TEXT.exec(event.text.trim())
    if (!match) return false
    const prefix = match[2] as string
    const timeline = await session.projectUI(undefined, { surface: 'channel' })
    const tickets = new Set<string>()
    for (const node of timeline.nodes) {
      if (node.kind === 'approval' && node.state === 'pending' && node.ticket?.startsWith(prefix)) {
        tickets.add(node.ticket)
      }
    }
    if (tickets.size === 0) return false
    const chat = chatOf(event)
    const exact = tickets.has(prefix) ? prefix : undefined
    if (tickets.size > 1 && exact === undefined) {
      await this.notice(chat, '匹配到多条审批，请提供完整 ticket')
      return true
    }
    const ticket = exact ?? (tickets.values().next().value as string)
    const verdict: Verdict = match[1] === '同意' ? 'allowed-once' : 'rejected'
    return this.decideParked(ticket, verdict, event, chat)
  }

  async handleSlotAction(sessionKey: string, event: ChannelEvent): Promise<boolean> {
    if (event.kind === 'cardAction' && event.value.length > MAX_CALLBACK_CHARS) {
      await this.notice(chatOf(event), '无效操作')
      return true
    }
    const action = this.dependencies.adapter.onSlotAction?.(event)
    if (!action) return false
    if (action.actionId.length === 0 || action.actionId.length > MAX_ACTION_CHARS) {
      await this.notice(chatOf(event), '无效操作')
      return true
    }
    const credential = this.credentialOf(event)
    const approver = credential.kind === 'channel' ? credential.userId : ''
    const denied = this.denied(approver, undefined)
    if (denied !== null) {
      await this.notice(chatOf(event), denied)
      return true
    }
    let validatedSessionId: string | false = false
    try {
      validatedSessionId =
        this.dependencies.validateSlotAction !== undefined &&
        (await this.dependencies.validateSlotAction(sessionKey, event, action.requestSeq, action.actionId))
    } catch {
      this.safeWarn('channel slot action validation failed')
    }
    if (validatedSessionId === false) {
      await this.notice(chatOf(event), '无效操作')
      return true
    }
    const call = this.dependencies.client.call
    if (call === undefined) throw new Error('client call surface unavailable for slot response')
    const now = this.now()
    this.pruneActions(this.recentSlotActions, now)
    const key = `${sessionKey}\0${action.requestSeq}\0${action.actionId}`
    const existing = this.recentSlotActions.get(key)
    if (existing !== undefined && (existing.pending || now - existing.at < ACTION_TTL_MS)) {
      await existing.work
      await this.notice(chatOf(event), '已处理')
      return true
    }
    if (this.recentSlotActions.size >= MAX_RECENT_ACTIONS) {
      await this.notice(chatOf(event), '操作繁忙，请稍后重试')
      return true
    }
    const timeoutMs = this.dependencies.slotActionTimeoutMs ?? 10_000
    const work = this.bounded(
      call(
        '_agnes/v1/ext.ui.response',
        {
          sessionId: validatedSessionId,
          requestSeq: action.requestSeq,
          action: 'accept',
          data: { id: action.actionId },
        },
        { timeoutMs },
      ),
      timeoutMs,
    ).then(() => undefined)
    const tracked: RecentAction = { at: now, pending: true, work }
    this.recentSlotActions.set(key, tracked)
    try {
      await work
      tracked.pending = false
      tracked.at = this.now()
    } catch (error) {
      if (this.recentSlotActions.get(key)?.work === work) this.recentSlotActions.delete(key)
      throw error
    }
    return true
  }

  private async decideParked(
    ticket: string,
    verdict: Verdict,
    event: ChannelEvent,
    chat: ChatTarget,
  ): Promise<boolean> {
    const credential = this.credentialOf(event)
    const approver = credential.kind === 'channel' ? credential.userId : ''
    const denied = this.denied(approver, undefined)
    if (denied !== null) {
      await this.notice(chat, denied)
      return true
    }
    const now = this.now()
    this.pruneActions(this.recentParkedActions, now)
    const sourceId =
      event.kind === 'cardAction'
        ? event.cardBizId
        : event.kind === 'message' || event.kind === 'reaction'
          ? event.messageId
          : event.eventId
    const identity = `${this.dependencies.adapter.manifest.id}\0${event.accountId}\0${sourceId}\0${ticket}\0${verdict}\0${approver}`
    const key = createHash('sha256').update(identity).digest('hex')
    const existing = this.recentParkedActions.get(key)
    if (existing !== undefined && (existing.pending || now - existing.at < ACTION_TTL_MS)) {
      await existing.work
      await this.notice(chat, '已处理')
      return true
    }
    if (this.recentParkedActions.size >= MAX_RECENT_ACTIONS) {
      await this.notice(chat, '审批繁忙，请稍后重试')
      return true
    }
    const work = this.submitParked(key, ticket, verdict, credential, chat)
    const tracked: RecentAction = { at: now, pending: true, work }
    this.recentParkedActions.set(key, tracked)
    try {
      await work
      tracked.pending = false
      tracked.at = this.now()
    } catch (error) {
      if (this.recentParkedActions.get(key)?.work === work) this.recentParkedActions.delete(key)
      throw error
    }
    return true
  }

  private async submitParked(
    claimKey: string,
    ticket: string,
    verdict: Verdict,
    credential: ReturnType<Approval['credentialOf']>,
    chat: ChatTarget,
  ): Promise<void> {
    try {
      await this.bounded(
        this.dependencies.client.approval.decide(ticket, verdict, credential),
        this.dependencies.slotActionTimeoutMs ?? 10_000,
      )
      await this.dependencies.client.claim
        .once('channel-approval-action', claimKey)
        .catch(() => this.safeWarn('channel parked approval completion claim failed'))
      await this.notice(chat, '已提交审批')
    } catch (error) {
      if (!(error instanceof JsonRpcError) || error.code !== AGNES_ERRORS.APPROVAL_REJECTED) throw error
      const reason = String(error.data.reason ?? '').toLowerCase()
      const message = reason.includes('expired')
        ? '审批已过期'
        : reason.includes('self')
          ? '不能自批'
          : '审批无效'
      await this.notice(chat, message)
    }
  }

  private ask(
    sessionKey: string,
    request: PermissionRequest,
    chat: ChatTarget,
    requesterUserId: string | undefined,
    signal: AbortSignal,
  ): Promise<PermissionOutcome> {
    if (signal.aborted) return Promise.resolve(REJECTED)
    const requestSeq = this.nextSequence()
    const deadline = request.deadlineMs
    const expiresAt =
      deadline !== undefined && Number.isFinite(deadline)
        ? new Date(Math.max(0, deadline)).toISOString()
        : undefined
    return new Promise<PermissionOutcome>((resolve) => {
      const ref = Promise.resolve().then(() =>
        this.dependencies.adapter.send(
          chat,
          this.dependencies.adapter.renderApproval({
            requestSeq,
            summary: summaryOf(request.toolCall),
            risk: 'unknown',
            options: request.options.map((option) => option.kind),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(requesterUserId === undefined ? {} : { requesterUserId }),
          }),
        ),
      )
      const abort = () => {
        const pending = this.pending.get(requestSeq)
        if (pending) this.finish(requestSeq, pending, REJECTED)
      }
      const pending: Pending = {
        sessionKey,
        ref,
        chat,
        ...(requesterUserId === undefined ? {} : { requesterUserId }),
        offered: new Set(request.options.map((option) => outcomeOf(option.kind))),
        resolve,
        signal,
        abort,
      }
      this.pending.set(requestSeq, pending)
      void ref
        .then((reference) => {
          if (this.pending.get(requestSeq) === pending) pending.reference = reference
        })
        .catch(() => undefined)
      void ref.catch(() => {
        if (this.pending.get(requestSeq) === pending) this.finish(requestSeq, pending, REJECTED)
        this.safeWarn('channel approval card send failed', { requestSeq })
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      if (deadline !== undefined && this.pending.get(requestSeq) === pending) {
        const delay = Math.max(0, Math.min(2_147_483_647, deadline - this.now()))
        pending.timer = setTimeout(() => this.expire(requestSeq, pending), delay)
        pending.timer.unref?.()
      }
    })
  }

  private expire(requestSeq: number, pending: Pending): void {
    if (this.pending.get(requestSeq) !== pending) return
    this.finish(requestSeq, pending, REJECTED)
    void pending.ref
      .then((ref) =>
        this.dependencies.adapter.update(ref, {
          blocks: [{ kind: 'text', markdown: '审批已超时' }],
        }),
      )
      .catch(() => this.safeWarn('channel approval timeout update failed', { requestSeq }))
  }

  private finish(requestSeq: number, pending: Pending, outcome: PermissionOutcome): void {
    if (this.pending.get(requestSeq) !== pending) return
    this.pending.delete(requestSeq)
    if (pending.timer) clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.abort)
    pending.resolve(outcome)
  }

  private denied(approver: string, requester: string | undefined): string | null {
    if (!approver) return '无权审批'
    if (this.dependencies.cfg.allowFrom.length > 0 && !this.dependencies.cfg.allowFrom.includes(approver))
      return '无权审批'
    if (requester !== undefined && requester === approver) return '不能审批自己的请求'
    return null
  }

  private async notice(chat: ChatTarget, markdown: string): Promise<void> {
    await this.dependencies.adapter.send(chat, {
      blocks: [{ kind: 'text', markdown }],
      ephemeral: true,
    })
  }

  private nextSequence(): number {
    this.sequence = this.sequence >= Number.MAX_SAFE_INTEGER ? 1 : this.sequence + 1
    while (this.pending.has(this.sequence)) this.sequence++
    return this.sequence
  }

  private credentialOf(event: ChannelEvent) {
    const filtered = whitelistCredential(
      this.dependencies.adapter.credentialOf(event),
      this.dependencies.adapter.manifest.credentials.exposes,
    )
    if (filtered.dropped.length > 0) {
      this.safeWarn('channel approval credential fields dropped', { fields: filtered.dropped.sort() })
    }
    return filtered.cred
  }

  private pruneActions(actions: Map<string, RecentAction>, now: number): void {
    for (const [key, entry] of actions) {
      if (!entry.pending && now - entry.at >= ACTION_TTL_MS) actions.delete(key)
    }
  }

  private bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    const signal = this.dependencies.signal
    if (signal?.aborted) return Promise.reject(new Error('channel action cancelled'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error('channel action timed out'))), timeoutMs)
      timer.unref?.()
      const onAbort = () => finish(() => reject(new Error('channel action cancelled')))
      const finish = (settle: () => void): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        settle()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      work.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  private now(): number {
    return (this.dependencies.clock ?? Date.now)()
  }

  private safeWarn(message: string, meta?: Record<string, unknown>): void {
    try {
      this.dependencies.log.warn(message, meta)
    } catch {
      // A diagnostic sink cannot affect approval completion.
    }
  }
}

function sameChat(left: ChatTarget, right: ChatTarget): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId
}

function chatOf(event: ChannelEvent): ChatTarget {
  return {
    chatId: event.chat.id,
    ...(event.chat.threadId === undefined ? {} : { threadId: event.chat.threadId }),
  }
}
