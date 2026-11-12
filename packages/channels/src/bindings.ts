import { createHash } from 'node:crypto'
import type { OwnedStore } from '@agnes/extension-api'
import type { ChannelEvent } from './adapter.js'
import type { Runner } from './runner/runner.js'

type Target = {
  accountId?: string
  chatType?: 'dm' | 'group'
  id: string
  key: string
  chatId: string
  threadId?: string
  label: string
}
type Binding = { sessionId: string; targetId: string; afterSeq: number; state: 'active' | 'pending' }
type State = { version: number; targets: Target[]; bindings: Binding[] }

/** The chat target id: the same chat on the same platform account always gets the same id. */
export const chatTargetId = (accountId: string, route: string) =>
  createHash('sha256').update(`${accountId}\0${route}`).digest('hex').slice(0, 32)

/** Stores routing metadata only. Pending transitions never resume automatically after a crash. */
export class ChannelBindings {
  private state: State
  private readonly fresh = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()
  runner?: Runner
  constructor(
    private readonly store: OwnedStore,
    private readonly key: string,
    private readonly assertCurrent: () => void,
    /** A chat target paired with a plugin service cannot also be bound to a session. */
    private readonly paired: (targetId: string) => boolean = () => false,
  ) {
    this.state = (store.get(key) as unknown as State | undefined) ?? { version: 0, targets: [], bindings: [] }
  }
  observe(event: ChannelEvent, route: string): void {
    if (event.kind !== 'message') return
    this.assertCurrent()
    const id = chatTargetId(event.accountId, route)
    const existing = this.state.targets.find((t) => t.id === id)
    if (existing) {
      if (!existing.accountId || !existing.chatType) {
        existing.accountId = event.accountId
        if (event.chat.type !== 'thread') existing.chatType = event.chat.type
        this.save()
      }
      this.fresh.add(id)
      return
    }
    if (this.state.targets.length >= 32) return
    this.fresh.add(id)
    this.state.targets.push({
      id,
      key: route,
      accountId: event.accountId,
      ...(event.chat.type !== 'thread' ? { chatType: event.chat.type } : {}),
      chatId: event.chat.id,
      ...(event.chat.threadId ? { threadId: event.chat.threadId } : {}),
      label:
        `${event.chat.type === 'dm' ? (event.sender.displayName ?? event.sender.userId) : event.chat.id}`.slice(
          0,
          128,
        ),
    })
    this.save()
  }
  async restore(): Promise<void> {
    await this.serial(async () => {
      this.assertCurrent()
      for (const binding of this.state.bindings) {
        if (binding.state !== 'active' || this.paired(binding.targetId)) continue
        const target = this.state.targets.find((item) => item.id === binding.targetId)
        if (
          !target?.accountId ||
          !target.chatType ||
          chatTargetId(target.accountId, target.key) !== target.id
        )
          continue
        this.fresh.add(target.id)
        try {
          await this.runner?.activate(target.key, {
            accountId: target.accountId,
            chatType: target.chatType,
            chatId: target.chatId,
            ...(target.threadId ? { threadId: target.threadId } : {}),
          })
        } catch (error) {
          this.fresh.delete(target.id)
          throw error
        }
      }
    })
  }
  resolve(key: string): { sessionId: string; afterSeq: number } | undefined {
    this.assertCurrent()
    const target = this.state.targets.find((t) => t.key === key && this.fresh.has(t.id))
    const binding =
      target && this.state.bindings.find((b) => b.targetId === target.id && b.state === 'active')
    return binding ? { sessionId: binding.sessionId, afterSeq: binding.afterSeq } : undefined
  }
  view(sessionId: string) {
    this.assertCurrent()
    return {
      version: this.state.version,
      targets: this.state.targets.map((t) => ({
        id: t.id,
        label: t.label,
        confirmed: this.fresh.has(t.id),
        unavailable:
          this.paired(t.id) ||
          this.state.bindings.some((b) => b.targetId === t.id && b.sessionId !== sessionId),
      })),
      bindings: this.state.bindings
        .filter((b) => b.sessionId === sessionId)
        .map((b) => ({
          targetId: b.targetId,
          label: this.state.targets.find((t) => t.id === b.targetId)?.label ?? b.targetId,
          state: b.state === 'pending' ? 'pending' : this.fresh.has(b.targetId) ? 'active' : 'waiting',
        })),
    }
  }
  /** Profile administration; the workbench filters session identities by authenticated read access. */
  summary() {
    this.assertCurrent()
    return {
      version: this.state.version,
      bindings: this.state.bindings.map((binding) => ({
        sessionId: binding.sessionId,
        targetId: binding.targetId,
        label: this.state.targets.find((target) => target.id === binding.targetId)?.label ?? binding.targetId,
        state:
          binding.state === 'pending' ? 'pending' : this.fresh.has(binding.targetId) ? 'active' : 'waiting',
      })),
    }
  }
  change(
    action: 'bind' | 'unbind',
    input: { targetId?: string; expectedVersion: number },
    sessionId: string,
  ) {
    return this.serial(async () => {
      this.assertCurrent()
      if (this.state.version !== input.expectedVersion)
        throw new Error('Channel binding changed; refresh before retrying')
      const old = this.state.bindings.find((b) => b.sessionId === sessionId)
      const target =
        action === 'bind'
          ? this.state.targets.find((t) => t.id === input.targetId)
          : this.state.targets.find((t) => t.id === old?.targetId)
      if (!target || !this.runner) throw new Error('Channel target unavailable')
      if (
        action === 'bind' &&
        (!this.fresh.has(target.id) ||
          this.state.bindings.some((b) => b.targetId === target.id && b.sessionId !== sessionId))
      )
        throw new Error('Channel target has not been confirmed or is already bound')
      if (action === 'bind' && this.paired(target.id))
        throw new Error('Channel target is paired with a plugin service; unpair it first')
      if (action === 'bind' && old && old.targetId !== target.id)
        throw new Error('Unbind the current target first')
      const pending: Binding = old ?? { sessionId, targetId: target.id, afterSeq: 0, state: 'pending' }
      pending.state = 'pending'
      if (!old) this.state.bindings.push(pending)
      this.save()
      await this.runner.unlink(target.key)
      this.assertCurrent()
      if (action === 'unbind') {
        this.state.bindings = this.state.bindings.filter((b) => b !== pending)
        this.save()
      } else {
        pending.afterSeq = await this.runner.baseline(sessionId)
        this.assertCurrent()
        pending.state = 'active'
        this.save()
        try {
          await this.runner.activate(target.key, {
            chatId: target.chatId,
            ...(target.accountId ? { accountId: target.accountId } : {}),
            ...(target.chatType ? { chatType: target.chatType } : {}),
            ...(target.threadId ? { threadId: target.threadId } : {}),
          })
        } catch (error) {
          pending.state = 'pending'
          this.save()
          throw error
        }
      }
      return this.view(sessionId)
    })
  }
  /** Whether a session is bound, or being bound, to the chat target. */
  bound(targetId: string): boolean {
    return this.state.bindings.some((b) => b.targetId === targetId)
  }
  /** Runs after every earlier binding change and pairing of this instance, one at a time. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(work)
    this.queue = task
    return task
  }
  private save() {
    this.assertCurrent()
    this.state.version++
    this.store.set(this.key, this.state as unknown as import('@agnes/protocol').JsonValue)
  }
}
