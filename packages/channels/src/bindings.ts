import { createHash } from 'node:crypto'
import type { OwnedStore } from '@agnes/extension-api'
import type { ChannelEvent } from './adapter.js'
import type { Runner } from './runner/runner.js'

type Target = { id: string; key: string; chatId: string; threadId?: string; label: string }
type Binding = { sessionId: string; targetId: string; afterSeq: number; state: 'active' | 'pending' }
type State = { version: number; targets: Target[]; bindings: Binding[] }

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
  ) {
    this.state = (store.get(key) as unknown as State | undefined) ?? { version: 0, targets: [], bindings: [] }
  }
  observe(event: ChannelEvent, route: string): void {
    if (event.kind !== 'message') return
    this.assertCurrent()
    const id = createHash('sha256').update(`${event.accountId}\0${route}`).digest('hex').slice(0, 32)
    if (this.state.targets.some((t) => t.id === id)) {
      this.fresh.add(id)
      return
    }
    if (this.state.targets.length >= 32) return
    this.fresh.add(id)
    this.state.targets.push({
      id,
      key: route,
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
        unavailable: this.state.bindings.some((b) => b.targetId === t.id && b.sessionId !== sessionId),
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
    const task = this.queue
      .catch(() => {})
      .then(async () => {
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
    this.queue = task
    return task
  }
  private save() {
    this.assertCurrent()
    this.state.version++
    this.store.set(this.key, this.state as unknown as import('@agnes/protocol').JsonValue)
  }
}
