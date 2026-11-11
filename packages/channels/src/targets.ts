import { createHash } from 'node:crypto'
import type { ChannelTargetEvent } from '@agnes/extension-api'
import {
  type CardActionEvent,
  type CardBlock,
  type ChannelAdapter,
  type ChannelEvent,
  type MessageEvent,
  sessionKeyFor,
  type TextBlock,
} from './adapter.js'
import { type ChannelBindings, chatTargetId } from './bindings.js'
import { degrade } from './degrade.js'
import { MAX_CALLBACK_CHARS } from './runner/approval.js'
import { decideAttention } from './runner/attention.js'
import { backoffDelays } from './runner/backoff.js'
import type { RunnerConfig } from './runner/config.js'
import type { Runner } from './runner/runner.js'

type Pairing = { id: string; accountId: string; chatId: string; userId: string }

/** The Host port for one channel row's pairings of chats to plugin services. */
export interface ChannelTargetsPort {
  retain(instances: readonly { id: string; credentials: string }[]): void
  attach(
    instanceId: string,
    link: {
      provider: string
      textChars: number
      /** Whether the connected adapter renders cards; without them a card arrives as numbered text. */
      card: boolean
      cardBytes: number
      rendered(block: TextBlock | CardBlock): number
      connected(): boolean
      send(
        chatId: string,
        block: TextBlock | CardBlock,
        deliveryKey: string,
      ): Promise<{ messageId: string; cardBizId?: string }>
    },
  ): () => void
  expectsCode(instanceId: string, text: string): boolean
  confirm(
    instanceId: string,
    text: string,
    chat: {
      id: string
      accountId: string
      credentials: string
      route: string
      chatId: string
      userId: string
      label: string
    },
  ): { label: string } | undefined
  find(instanceId: string, chatId: string): Pairing | undefined
  deliver(pairing: Pairing, event: ChannelTargetEvent): Promise<void>
  drop(pairingId: string): void
  paired(instanceId: string, targetId: string): boolean
  pairings(instanceId: string): unknown[]
}

const NOTICE_INTERVAL_MS = 600_000
const ATTEMPTS = 3

/** Credential references only, never secret values: a changed reference ends the instance's pairings. */
export const credentialFingerprint = (refs: Record<string, string>) =>
  createHash('sha256').update(JSON.stringify(refs)).digest('hex')

/**
 * Routes one instance's direct chats that are paired with a plugin service, and the pairing codes that
 * pair them. It decides synchronously whether an event is its own; the work then runs on the instance's
 * binding queue (pairing) or in the background (delivery), and `drain` waits for it on shutdown.
 */
export function createTargetRouter(input: {
  targets: ChannelTargetsPort
  instanceId: string
  credentials: string
  cfg: RunnerConfig
  adapter: () => ChannelAdapter
  runner: () => Runner | undefined
  bindings: ChannelBindings
  signal: AbortSignal
  now?: () => number
  backoff?: { baseMs: number; maxMs: number }
}) {
  const { targets, instanceId, cfg } = input
  const now = input.now ?? Date.now
  const pending = new Set<Promise<void>>()
  const noticed = new Map<string, number>()
  const track = (work: Promise<void>) => {
    const task = work.catch(() => undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  const reply = async (event: MessageEvent, text: string) => {
    await input
      .runner()
      ?.sendDirect(
        { chatId: event.chat.id },
        { kind: 'text', markdown: text },
        `pairing-reply:${event.eventId}`,
      )
  }
  const pair = async (event: MessageEvent) => {
    const runner = input.runner()
    if (!runner || !(await runner.claim(event))) return
    const route =
      input.adapter().toSession(event, { tenant: cfg.tenant, agent: cfg.agent })?.sessionKey ??
      sessionKeyFor({ tenant: cfg.tenant, agent: cfg.agent, channel: cfg.channel, chat: event.chat })
    const id = chatTargetId(event.accountId, route)
    if (input.bindings.bound(id)) {
      await reply(event, '这个聊天已绑定到一个 AGH 会话，请先在 AGH 里解绑。')
      return
    }
    const paired = targets.confirm(instanceId, event.text, {
      id,
      accountId: event.accountId,
      credentials: input.credentials,
      route,
      chatId: event.chat.id,
      userId: event.sender.userId,
      label: event.sender.displayName ?? event.sender.userId,
    })
    await reply(
      event,
      paired
        ? `已与「${paired.label}」配对，之后发给我的消息会交给它。`
        : '配对码无效或已过期，请在 AGH 渠道页重新生成。',
    )
  }
  const deliver = async (event: MessageEvent | CardActionEvent, pairing: Pairing) => {
    const runner = input.runner()
    if (!runner || !(await runner.claim(event))) return
    if (event.accountId !== pairing.accountId) {
      // The instance now runs another platform account: the old pairing no longer names this chat.
      targets.drop(pairing.id)
      return
    }
    if (event.sender.userId !== pairing.userId || event.chat.id !== pairing.chatId) return
    const payload = targetEvent(event, pairing.id, instanceId)
    if (!payload) return
    const delays = backoffDelays(input.backoff)
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await targets.deliver(pairing, payload)
        return
      } catch {
        if (attempt < ATTEMPTS) await delay(delays.next().value, input.signal)
      }
    }
    const last = noticed.get(pairing.id)
    if (last !== undefined && now() - last < NOTICE_INTERVAL_MS) return
    noticed.set(pairing.id, now())
    await runner.sendDirect(
      { chatId: event.chat.id },
      { kind: 'text', markdown: '接收这个聊天的插件服务现在没在运行，这条没有收到，请稍后再发。' },
      `pairing-notice:${event.eventId}`,
    )
  }
  return {
    intercept(event: ChannelEvent): boolean {
      if (event.kind === 'cardAction') {
        // Every click in a paired chat stays here, dropped or not: the session approval path must never see it.
        const pairing = targets.find(instanceId, event.chat.id)
        if (!pairing) return false
        track(deliver(event, pairing))
        return true
      }
      if (event.kind !== 'message' || decideAttention(event, cfg, false) === 'ignore') return false
      if (event.chat.type === 'dm' && targets.expectsCode(instanceId, event.text)) {
        track(input.bindings.serial(() => pair(event)))
        return true
      }
      const pairing = targets.find(instanceId, event.chat.id)
      if (!pairing) return false
      track(deliver(event, pairing))
      return true
    },
    attach(runner: Runner, manifest: ChannelAdapter['manifest']) {
      return targets.attach(instanceId, {
        provider: manifest.id,
        textChars: manifest.limits.textChars,
        card: input.adapter().capabilities().card,
        cardBytes: manifest.limits.cardBytes,
        rendered: (block) =>
          degrade({ blocks: [block] }, input.adapter().capabilities()).msg.blocks.reduce(
            (sum, b) => sum + (b.kind === 'text' ? b.markdown.length : b.kind === 'card' ? b.body.length : 0),
            0,
          ),
        connected: () => runner.status().channel === 'connected',
        async send(chatId, block, deliveryKey) {
          const ref = await runner.sendDirect({ chatId }, block, deliveryKey)
          return { messageId: ref.messageId, ...(ref.cardBizId ? { cardBizId: ref.cardBizId } : {}) }
        },
      })
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...pending])
    },
  }
}

function targetEvent(
  event: MessageEvent | CardActionEvent,
  pairingId: string,
  instanceId: string,
): ChannelTargetEvent | undefined {
  const base = {
    origin: 'owner',
    pairingId,
    instanceId,
    eventId: event.eventId,
    at: event.at,
    chat: { id: event.chat.id, type: 'dm' },
    sender: { userId: event.sender.userId },
  } as const
  if (event.kind === 'cardAction') {
    if (!event.cardBizId || !event.value || event.value.length > MAX_CALLBACK_CHARS) return undefined
    return { ...base, kind: 'action', messageId: event.cardBizId, actionId: event.value }
  }
  if (!event.text) return undefined
  const quoted = event.quotedMessageId
  return {
    ...base,
    kind: 'message',
    messageId: event.messageId,
    text: event.text,
    ...(typeof quoted === 'string' && quoted ? { quotedMessageId: quoted } : {}),
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
