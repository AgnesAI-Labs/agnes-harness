import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ChannelDelivery,
  ChannelPairing,
  ChannelTargetAction,
  ChannelTargetEvent,
  ChannelTargetSend,
  ManagedChannelTargets,
  PersistenceMetadataNamespace,
} from '@agnes/extension-api'
import type { CardActionEvent, CardBlock, MessageRef, TextBlock } from '@agnes/extension-api/channel-contract'
import { grantKey } from '@agnes/plugin-runtime/host'
import { rpcError } from '@agnes/protocol'

/** A managed service that may receive a paired chat: `owner` is the `grantKey` of its package row. */
export type ChannelTarget = { owner: string; service: string }
/** Instance ids are unique only within one channel row, so the row's `grantKey` is part of the reference. */
export type ChannelInstanceRef = { channel: string; instanceId: string }

export type OwnerPairing = {
  /** The chat target id the session bindings use for the same chat: `sha256(accountId\0route)`, 32 hex. */
  id: string
  instance: ChannelInstanceRef
  accountId: string
  /** `sha256` of the instance's credential references, never of secret values. */
  credentials: string
  route: string
  chatId: string
  userId: string
  label: string
  provider: string
  textChars: number
  target: ChannelTarget
  pairedAt: string
}

type DeliveryRow = {
  accountId?: string
  chatType?: 'dm' | 'group'
  state: 'sending' | 'delivered' | 'unknown'
  incarnation: string
  messageId?: string
  /** The id a click on this message reports, when the channel's differs from `messageId`. */
  cardBizId?: string
  /** Who sent it: a click counts only on a message the clicked chat's current service sent. */
  pairingId?: string
  service?: string
  at: string
}
type Code = { digest: Buffer; instance: ChannelInstanceRef; target: ChannelTarget; expiresAt: number }
type Service = {
  packageId: string
  label: string
  resume?(): Promise<void>
  watches?: Map<
    string,
    { pairingId: string; sessionId: string; route: string; assertSession(): Promise<void>; stop?: () => void }
  >
  onEvent?: (event: ChannelTargetEvent) => Promise<void>
  onPairingChange?: () => void
}

/** What a connected channel instance lends the Host so a service can send through its runner. */
export interface ChannelTargetLink {
  watchSession?(
    route: string,
    sessionId: string,
    chat: { chatId: string; accountId: string; chatType: 'dm' },
    assertCurrent: () => Promise<void>,
  ): Promise<() => void>
  interaction?(event: CardActionEvent, routes: readonly string[]): Promise<boolean>
  update?(ref: MessageRef, block: TextBlock | CardBlock): Promise<void>
  provider: string
  textChars: number
  /** Whether the adapter renders cards; the bridge degrades a card to numbered text when it does not. */
  card: boolean
  cardBytes: number
  /** The text length the channel will receive for `block`: titles and, without cards, the button list included. */
  rendered(block: TextBlock | CardBlock): number
  /** False while the instance reconnects or stops; a send then is refused before the ledger is written. */
  connected(): boolean
  send(
    chat: { chatId: string; accountId: string; chatType: 'dm' },
    block: TextBlock | CardBlock,
    deliveryKey: string,
  ): Promise<Omit<MessageRef, 'chatId'>>
}

/** The Host port one channel row's bridge receives; every call is scoped to that row. */
export interface ChannelTargetsBridge {
  retain(instances: readonly { id: string; credentials: string }[]): void
  attach(instanceId: string, link: ChannelTargetLink): () => void
  /** Whether `text` should be checked as a pairing code: the instance has a live code and the text is code-shaped. */
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
  find(instanceId: string, chatId: string): OwnerPairing | undefined
  interact(pairing: OwnerPairing, event: CardActionEvent): Promise<boolean>
  deliver(pairing: OwnerPairing, event: ChannelTargetEvent): Promise<void>
  drop(pairingId: string): void
  paired(instanceId: string, targetId: string): boolean
  pairings(instanceId: string): {
    id: string
    label: string
    target: ChannelTarget & { packageId: string }
    pairedAt: string
    running: boolean
  }[]
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 3_600_000
const MAX_MISSES = 5
const LEDGER_TTL_MS = 7 * 86_400_000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const normalize = (text: string) => text.replace(/[\s-]/g, '').toUpperCase()
const codeDigest = (code: string) => createHash('sha256').update(normalize(code)).digest()
const targetKey = (target: ChannelTarget) => `${target.owner}\0${target.service}`
const instanceKey = (instance: ChannelInstanceRef) => `${instance.channel}\0${instance.instanceId}`
const sameInstance = (a: ChannelInstanceRef, b: ChannelInstanceRef) =>
  a.channel === b.channel && a.instanceId === b.instanceId
const refused = (code: 'NOT_PAIRED' | 'CHANNEL_UNAVAILABLE') => rpcError('SEMANTIC_REJECTED', { code })
const MAX_TITLE = 100
const MAX_ACTIONS = 6
const MAX_LABEL = 40
/**
 * The most text the platform adds around a valid send's `text`: a text title line, or on a channel without
 * cards `【title】`, one `N. label` line per action and the `回复 1 / 2 … 选择` line. Reserved inside the limit.
 */
export const SEND_OVERHEAD = Math.max(
  MAX_TITLE + 5,
  MAX_TITLE + 3 + MAX_ACTIONS * (MAX_LABEL + 4) + 1 + 3 + (MAX_ACTIONS * 4 - 3) + 3,
)
const sendable = (textChars: number) => Math.max(1, textChars - SEND_OVERHEAD)
const ACTION_ID = /^[A-Za-z0-9:_-]{1,64}$/
const STYLES = new Set(['primary', 'default', 'danger'])
const oneLine = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\r\n]/.test(value)

/** The block one send becomes, or undefined when `title` or `actions` break the documented limits. */
function compose(input: ChannelTargetSend): TextBlock | CardBlock | undefined {
  const { text, title, actions } = input
  if (title !== undefined && !oneLine(title, MAX_TITLE)) return undefined
  if (actions === undefined)
    return { kind: 'text', markdown: title === undefined ? text : `**${title}**\n${text}` }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) return undefined
  const buttons: NonNullable<CardBlock['actions']> = []
  for (const action of actions as unknown[]) {
    const { id, label, style } = (action ?? {}) as Partial<ChannelTargetAction>
    if (typeof id !== 'string' || !ACTION_ID.test(id) || buttons.some((b) => b.id === id)) return undefined
    if (!oneLine(label, MAX_LABEL) || (style !== undefined && !STYLES.has(style))) return undefined
    buttons.push({ id, label, ...(style === 'primary' || style === 'danger' ? { style } : {}) })
  }
  return { kind: 'card', title: title ?? '', body: text, actions: buttons }
}

/** Whether `text` is, as a whole, a pairing code: eight code letters, ignoring case, spaces and hyphens. */
export function pairingCodeShaped(text: string): boolean {
  const value = normalize(text)
  return value.length === 8 && [...value].every((letter) => ALPHABET.includes(letter))
}

const shared = new Map<string, { targets: ChannelTargets; refs: number }>()

/**
 * Pairings of channel chats to managed services, their one-time codes and the send ledger. The Host is
 * the only writer; the bridge and the services reach it through ports and read it fresh on every call.
 * Pairings and the ledger persist in a Host metadata namespace; codes, service handlers and connected
 * instances live only in this process. One instance serves every generation of a profile in a process.
 */
export class ChannelTargets {
  private readonly codes = new Map<string, Code>()
  private readonly misses = new Map<string, number>()
  private readonly services = new Map<string, Service>()
  private readonly links = new Map<string, ChannelTargetLink>()
  private readonly incarnation = randomUUID()
  private readonly sweep: ReturnType<typeof setInterval>

  /** The instance for `key`, shared by every caller in this process until each has released it. */
  static retain(key: string, store: () => PersistenceMetadataNamespace, clock: () => number = Date.now) {
    const entry = shared.get(key) ?? { targets: new ChannelTargets(store(), clock), refs: 0 }
    entry.refs++
    shared.set(key, entry)
    let released = false
    return {
      targets: entry.targets,
      release() {
        if (released) return
        released = true
        if (--entry.refs > 0 || shared.get(key) !== entry) return
        shared.delete(key)
        clearInterval(entry.targets.sweep)
      },
    }
  }

  constructor(
    private readonly store: PersistenceMetadataNamespace,
    private readonly clock: () => number = Date.now,
  ) {
    this.prune()
    this.sweep = setInterval(() => this.prune(), 3_600_000)
    this.sweep.unref?.()
  }

  /** Services a code can be minted for now: declared, running and not yet paired. */
  targets() {
    return [...this.services].map(([key, service]) => {
      const [owner = '', name = ''] = key.split('\0')
      return {
        owner,
        service: name,
        packageId: service.packageId,
        label: service.label,
        paired: !!this.byTarget({ owner, service: name }),
      }
    })
  }

  /** Why `target` cannot be paired through `instance` now, or undefined when it can. */
  mintRefusal(instance: ChannelInstanceRef, target: ChannelTarget): string | undefined {
    if (!this.services.has(targetKey(target))) return 'TARGET_UNAVAILABLE'
    if (this.byTarget(target)) return 'TARGET_PAIRED'
    if (!this.link(instance)) return 'CHANNEL_UNAVAILABLE'
    return undefined
  }

  /** A fresh code for `target`, replacing any earlier one. Only an approved mint calls this. */
  mint(instance: ChannelInstanceRef, target: ChannelTarget): { code: string; expiresAt: number } {
    const refusal = this.mintRefusal(instance, target)
    if (refusal) throw rpcError('SEMANTIC_REJECTED', { code: refusal })
    const letters = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const code = `${letters.slice(0, 4)}-${letters.slice(4)}`
    const expiresAt = this.clock() + CODE_TTL_MS
    this.codes.set(targetKey(target), { digest: codeDigest(code), instance, target, expiresAt })
    return { code, expiresAt }
  }

  /** Revoking only removes a permission, so it needs no approval. */
  revoke(pairingId: string): void {
    const pairing = this.pairing(pairingId)
    if (!pairing) throw refused('NOT_PAIRED')
    this.remove([pairing])
  }

  /** A removed package takes every pairing it was either side of, and its ledger rows, with it. */
  releasePackage(packageId: string): void {
    const prefix = grantKey(packageId, '')
    this.remove(
      this.all().filter((p) => p.instance.channel.startsWith(prefix) || p.target.owner.startsWith(prefix)),
    )
    for (const [key, code] of this.codes)
      if (code.instance.channel.startsWith(prefix) || code.target.owner.startsWith(prefix))
        this.codes.delete(key)
    this.store.transaction(() => {
      for (const { key } of this.store.entries()) if (key.startsWith(`d:${prefix}`)) this.store.delete(key)
    })
  }

  /** The port of one channel row; `channel` is that row's `grantKey`. */
  bridge(channel: string): ChannelTargetsBridge {
    const ref = (instanceId: string): ChannelInstanceRef => ({ channel, instanceId })
    return {
      retain: (instances) =>
        this.remove(
          this.all().filter(
            (p) =>
              p.instance.channel === channel &&
              !instances.some((i) => i.id === p.instance.instanceId && i.credentials === p.credentials),
          ),
        ),
      attach: (instanceId, link) => {
        const key = instanceKey(ref(instanceId))
        this.links.set(key, link)
        for (const service of this.services.values()) void service.resume?.().catch(() => {})
        return () => {
          if (this.links.get(key) !== link) return
          this.links.delete(key)
          for (const service of this.services.values())
            for (const [route, watch] of service.watches ?? []) {
              const pairing = this.pairing(watch.pairingId)
              if (pairing && sameInstance(pairing.instance, ref(instanceId))) {
                watch.stop?.()
                service.watches?.delete(route)
              }
            }
        }
      },
      expectsCode: (instanceId, text) =>
        pairingCodeShaped(text) && this.liveCodes(ref(instanceId)).length > 0,
      confirm: (instanceId, text, chat) => this.confirm(ref(instanceId), text, chat),
      find: (instanceId, chatId) =>
        this.all().find((p) => sameInstance(p.instance, ref(instanceId)) && p.chatId === chatId),
      interact: async (pairing, event) => {
        const current = this.pairing(pairing.id)
        if (
          !current ||
          current.pairedAt !== pairing.pairedAt ||
          !sameInstance(current.instance, ref(current.instance.instanceId)) ||
          event.accountId !== current.accountId ||
          event.chat.id !== current.chatId ||
          event.sender.userId !== current.userId
        )
          return true
        const service = this.services.get(targetKey(current.target))
        const routes: string[] = []
        for (const watch of service?.watches?.values() ?? []) {
          if (watch.pairingId !== current.id) continue
          await watch.assertSession()
          routes.push(watch.route)
        }
        return (await this.link(current.instance)?.interaction?.(event, routes)) ?? false
      },
      deliver: async (pairing, event) => {
        let delivered = event
        if (event.kind === 'action') {
          // Not a failure to retry or report: the click was on a message this service did not send.
          const messageId = this.sentBy(pairing, event.messageId)
          if (!messageId) return
          delivered = { ...event, messageId }
        }
        const service = this.services.get(targetKey(pairing.target))
        if (!service?.onEvent || !this.pairing(pairing.id)) throw refused('CHANNEL_UNAVAILABLE')
        await service.onEvent(structuredClone(delivered))
      },
      drop: (pairingId) => {
        const pairing = this.pairing(pairingId)
        if (pairing?.instance.channel === channel) this.remove([pairing])
      },
      paired: (instanceId, targetId) => {
        const pairing = this.pairing(targetId)
        return !!pairing && sameInstance(pairing.instance, ref(instanceId))
      },
      pairings: (instanceId) =>
        this.all()
          .filter((p) => sameInstance(p.instance, ref(instanceId)))
          .map((p) => {
            const service = this.services.get(targetKey(p.target))
            const packageId = p.target.owner.slice(0, p.target.owner.indexOf('#'))
            return {
              id: p.id,
              label: p.label,
              target: { ...p.target, packageId },
              pairedAt: p.pairedAt,
              running: !!service,
            }
          }),
    }
  }

  /**
   * The port of one running managed service. It registers the service as a pairing target until
   * `signal` aborts; every call checks `assertCurrent` and refuses anything not paired to this caller.
   */
  port(
    caller: ChannelTarget & {
      packageId: string
      signal: AbortSignal
      assertCurrent(): void
      assertSession?(sessionId: string): Promise<void>
    },
  ): ManagedChannelTargets {
    const target = { owner: caller.owner, service: caller.service }
    const key = targetKey(target)
    const opening = new Map<string, Promise<void>>()
    const service: Service = { packageId: caller.packageId, label: caller.packageId, watches: new Map() }
    if (!caller.signal.aborted) {
      this.services.set(key, service)
      caller.signal.addEventListener(
        'abort',
        () => {
          if (this.services.get(key) === service) this.services.delete(key)
          this.codes.delete(key)
          for (const watch of service.watches?.values() ?? []) watch.stop?.()
        },
        { once: true },
      )
    }
    const own = (pairingId: string) => {
      caller.assertCurrent()
      const pairing = this.pairing(pairingId)
      if (!pairing || targetKey(pairing.target) !== key) throw refused('NOT_PAIRED')
      return pairing
    }
    const port: ManagedChannelTargets = {
      pairing: async () => {
        caller.assertCurrent()
        const pairing = this.byTarget(target)
        return pairing && this.view(pairing)
      },
      onEvent: (handler) => {
        caller.assertCurrent()
        service.onEvent = handler
      },
      onPairingChange: (handler) => {
        caller.assertCurrent()
        service.onPairingChange = handler
      },
      send: async (pairingId, input) => this.send(own(pairingId), input, caller.assertCurrent),
      watchSession: async (pairingId, sessionId) => {
        const pairing = own(pairingId)
        if (!caller.assertSession || typeof sessionId !== 'string' || !sessionId)
          throw rpcError('CAPABILITY_DENIED')
        await caller.assertSession(sessionId)
        const current = own(pairingId)
        if (current.pairedAt !== pairing.pairedAt) throw refused('NOT_PAIRED')
        const link = this.link(current.instance)
        if (!link?.watchSession) throw refused('CHANNEL_UNAVAILABLE')
        const route = `managed:${pairing.id}:${pairing.pairedAt}:${sessionId}`
        if (service.watches?.has(route)) return
        const pending = opening.get(route)
        if (pending) return pending
        const assertSession = async () => {
          const live = own(pairingId)
          if (live.pairedAt !== pairing.pairedAt) throw refused('NOT_PAIRED')
          await caller.assertSession!(sessionId)
        }
        this.store.set(`w:${route}`, { pairingId, pairedAt: pairing.pairedAt, sessionId })
        const task = (async () => {
          const stop = await link.watchSession!(
            route,
            sessionId,
            { chatId: pairing.chatId, accountId: pairing.accountId, chatType: 'dm' },
            assertSession,
          )
          try {
            await assertSession()
          } catch (error) {
            stop()
            throw error
          }
          service.watches?.set(route, { pairingId, sessionId, route, stop, assertSession })
        })()
        opening.set(route, task)
        try {
          await task
        } finally {
          opening.delete(route)
        }
      },
      update: async (pairingId, messageId, input) => {
        const pairing = own(pairingId)
        const sent = this.sentReference(pairing, messageId)
        if (!sent?.messageId) throw rpcError('CAPABILITY_DENIED')
        const link = this.link(pairing.instance)
        if (!link?.update) throw refused('CHANNEL_UNAVAILABLE')
        const block = compose({ ...input, deliveryKey: 'update' })
        if (
          !block ||
          typeof input.text !== 'string' ||
          input.text.length > sendable(link.textChars) ||
          link.rendered(block) > link.textChars
        )
          throw rpcError('INVALID_PARAMS')
        await link.update(
          {
            chatId: pairing.chatId,
            messageId: sent.messageId,
            ...(sent.cardBizId ? { cardBizId: sent.cardBizId } : {}),
            ...(sent.accountId ? { accountId: sent.accountId } : {}),
            ...(sent.chatType ? { chatType: sent.chatType } : {}),
          },
          block,
        )
        own(pairingId)
      },
      delivery: async (pairingId, deliveryKey) => this.delivery(own(pairingId), deliveryKey),
      unpair: async (pairingId) => this.remove([own(pairingId)]),
    }
    service.resume = async () => {
      for (const { key, value } of this.store.entries()) {
        if (!key.startsWith('w:')) continue
        const watch = value as { pairingId: string; pairedAt: string; sessionId: string }
        const pairing = this.pairing(watch.pairingId)
        if (
          !pairing ||
          pairing.pairedAt !== watch.pairedAt ||
          targetKey(pairing.target) !== targetKey(target)
        )
          continue
        await port.watchSession(pairing.id, watch.sessionId).catch(() => {})
      }
    }
    void service.resume()
    return port
  }

  private view(pairing: OwnerPairing): ChannelPairing {
    const link = this.link(pairing.instance)
    return {
      id: pairing.id,
      instanceId: pairing.instance.instanceId,
      provider: link?.provider ?? pairing.provider,
      userId: pairing.userId,
      chatId: pairing.chatId,
      label: pairing.label,
      running: !!link,
      textChars: sendable(link?.textChars ?? pairing.textChars),
    }
  }

  private async send(
    pairing: OwnerPairing,
    input: ChannelTargetSend,
    assertCurrent: () => void,
  ): Promise<{ messageId: string }> {
    const { deliveryKey, text } = input ?? ({} as typeof input)
    if (
      typeof deliveryKey !== 'string' ||
      deliveryKey.length < 1 ||
      deliveryKey.length > 256 ||
      typeof text !== 'string'
    )
      throw rpcError('INVALID_PARAMS')
    const block = compose(input)
    if (!block) throw rpcError('INVALID_PARAMS')
    const row = this.ledgerKey(pairing, deliveryKey)
    const stored = this.store.get(row) as DeliveryRow | undefined
    if (stored?.state === 'delivered' && stored.messageId) return { messageId: stored.messageId }
    if (stored?.state === 'sending' && stored.incarnation === this.incarnation)
      throw refused('CHANNEL_UNAVAILABLE')
    const link = this.link(pairing.instance)
    if (!link) throw refused('CHANNEL_UNAVAILABLE')
    if (text.length === 0 || text.length > sendable(link.textChars) || link.rendered(block) > link.textChars)
      throw rpcError('INVALID_PARAMS', { code: 'TOO_LARGE' })
    if (block.kind === 'card' && link.card && Buffer.byteLength(JSON.stringify(block)) > link.cardBytes)
      throw rpcError('INVALID_PARAMS', { code: 'TOO_LARGE' })
    this.write(row, 'sending')
    try {
      const adapterKey = sha256(`${pairing.target.owner}\0${pairing.id}\0${deliveryKey}`)
      const { messageId, cardBizId, accountId, chatType } = await link.send(
        { chatId: pairing.chatId, accountId: pairing.accountId, chatType: 'dm' },
        block,
        adapterKey,
      )
      if (typeof messageId !== 'string' || !messageId) throw new Error('channel send returned no message id')
      this.write(row, 'delivered', {
        messageId,
        ...(accountId ? { accountId } : {}),
        ...(chatType ? { chatType } : {}),
        ...(typeof cardBizId === 'string' && cardBizId && cardBizId !== messageId ? { cardBizId } : {}),
        pairingId: pairing.id,
        service: pairing.target.service,
      })
      assertCurrent()
      return { messageId }
    } catch (error) {
      if ((this.store.get(row) as DeliveryRow | undefined)?.state !== 'delivered') this.write(row, 'unknown')
      const code =
        (error as { code?: unknown; data?: { code?: unknown } } | null)?.data?.code ??
        (error as { code?: unknown })?.code
      // Fixed codes only: platform errors may carry tokens or response bodies.
      throw rpcError('OUTCOME_UNKNOWN', {
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CHANNEL_SEND_FAILED',
      })
    }
  }

  private delivery(pairing: OwnerPairing, deliveryKey: string): ChannelDelivery {
    if (typeof deliveryKey !== 'string' || deliveryKey.length < 1 || deliveryKey.length > 256)
      throw rpcError('INVALID_PARAMS')
    const row = this.store.get(this.ledgerKey(pairing, deliveryKey)) as DeliveryRow | undefined
    if (row?.state === 'delivered' && row.messageId) return { state: 'delivered', messageId: row.messageId }
    if (row?.state === 'sending' && row.incarnation === this.incarnation) return { state: 'pending' }
    return { state: 'unknown' }
  }

  private confirm(
    instance: ChannelInstanceRef,
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
  ): { label: string } | undefined {
    const codes = this.liveCodes(instance)
    if (!codes.length || !/^[a-f0-9]{32}$/.test(chat.id)) return undefined
    const digest = codeDigest(text)
    const match = codes.find((code) => timingSafeEqual(code.digest, digest))
    const service = match && this.services.get(targetKey(match.target))
    if (!match || !service || this.byTarget(match.target) || this.pairing(chat.id)) {
      const misses = (this.misses.get(instanceKey(instance)) ?? 0) + 1
      this.misses.set(instanceKey(instance), misses)
      if (misses >= MAX_MISSES) {
        for (const code of codes) this.codes.delete(targetKey(code.target))
        this.misses.delete(instanceKey(instance))
      }
      return undefined
    }
    const link = this.links.get(instanceKey(instance))
    const pairing: OwnerPairing = {
      id: chat.id,
      instance,
      accountId: chat.accountId,
      credentials: chat.credentials,
      route: chat.route,
      chatId: chat.chatId,
      userId: chat.userId,
      label: chat.label.slice(0, 128),
      provider: link?.provider ?? '',
      textChars: link?.textChars ?? 0,
      target: match.target,
      pairedAt: new Date(this.clock()).toISOString(),
    }
    this.codes.delete(targetKey(match.target))
    this.misses.delete(instanceKey(instance))
    this.store.set(`p:${pairing.id}`, pairing)
    this.notify(match.target)
    return { label: service.label }
  }

  private link(instance: ChannelInstanceRef): ChannelTargetLink | undefined {
    const link = this.links.get(instanceKey(instance))
    try {
      return link?.connected() ? link : undefined
    } catch {
      return undefined
    }
  }

  private liveCodes(instance: ChannelInstanceRef): Code[] {
    const now = this.clock()
    const live: Code[] = []
    for (const [key, code] of this.codes)
      if (code.expiresAt <= now) this.codes.delete(key)
      else if (sameInstance(code.instance, instance)) live.push(code)
    return live
  }

  private remove(pairings: readonly OwnerPairing[]): void {
    if (!pairings.length) return
    this.store.transaction(() => {
      for (const pairing of pairings) {
        this.store.delete(`p:${pairing.id}`)
        for (const { key, value } of this.store.entries())
          if (
            (key.startsWith('w:') || key.startsWith('d:')) &&
            (value as { pairingId?: string }).pairingId === pairing.id
          )
            this.store.delete(key)
      }
    })
    for (const pairing of pairings) {
      const watches = this.services.get(targetKey(pairing.target))?.watches
      for (const [key, watch] of watches ?? [])
        if (watch.pairingId === pairing.id) {
          watch.stop?.()
          watches?.delete(key)
        }
      this.notify(pairing.target)
    }
  }

  private notify(target: ChannelTarget): void {
    try {
      this.services.get(targetKey(target))?.onPairingChange?.()
    } catch {
      // A hint only; the service reads its pairing again on its own.
    }
  }

  private pairing(id: string): OwnerPairing | undefined {
    return this.store.get(`p:${id}`) as OwnerPairing | undefined
  }

  private byTarget(target: ChannelTarget): OwnerPairing | undefined {
    return this.all().find((p) => targetKey(p.target) === targetKey(target))
  }

  private all(): OwnerPairing[] {
    return this.store
      .entries()
      .filter((row) => row.key.startsWith('p:'))
      .map((row) => row.value as OwnerPairing)
  }

  private ledgerKey(pairing: OwnerPairing, deliveryKey: string): string {
    return `d:${pairing.target.owner}:${sha256(`${pairing.id}\0${deliveryKey}`)}`
  }

  private write(
    key: string,
    state: DeliveryRow['state'],
    sent: Pick<
      DeliveryRow,
      'messageId' | 'cardBizId' | 'pairingId' | 'service' | 'accountId' | 'chatType'
    > = {},
  ): void {
    const row: DeliveryRow = {
      state,
      incarnation: this.incarnation,
      at: new Date(this.clock()).toISOString(),
      ...sent,
    }
    this.store.set(key, row)
  }

  /** The send-returned id of the live ledger row `clicked` names, when this pairing's service sent it. */
  private sentBy(pairing: OwnerPairing, clicked: string): string | undefined {
    return this.sentReference(pairing, clicked)?.messageId
  }

  private sentReference(pairing: OwnerPairing, clicked: string): DeliveryRow | undefined {
    const prefix = `d:${pairing.target.owner}:`
    const before = this.clock() - LEDGER_TTL_MS
    for (const { key, value } of this.store.entries()) {
      const row = value as DeliveryRow
      if (
        key.startsWith(prefix) &&
        row.state === 'delivered' &&
        row.pairingId === pairing.id &&
        row.service === pairing.target.service &&
        Date.parse(row.at) > before &&
        (row.messageId === clicked || row.cardBizId === clicked)
      )
        return row
    }
    return undefined
  }

  private prune(): void {
    const before = this.clock() - LEDGER_TTL_MS
    this.store.transaction(() => {
      for (const { key, value } of this.store.entries())
        if (key.startsWith('d:') && !(Date.parse((value as DeliveryRow).at) > before)) this.store.delete(key)
    })
  }
}

/** What a managed service without the reviewed `channelTargets` declaration receives. */
export const deniedChannelTargets: ManagedChannelTargets = {
  pairing: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  onEvent: () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  onPairingChange: () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  send: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  watchSession: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  update: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  delivery: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  unpair: async () => {
    throw rpcError('CAPABILITY_DENIED')
  },
}
