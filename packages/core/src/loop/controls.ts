import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import type { Actor, ContentBlock } from '@agnes/protocol'
import { validateUserMessageImages } from '../request/user-message-images.js'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'

export type SessionControl = 'pause' | 'resume' | 'cancel' | 'interrupt'
const PAUSE = 'x/core/pause-state'

/** Core-owned controls apply to the session's pinned factory, independent of its scheduler. */
export class SessionControls {
  interrupting = false
  constructor(private readonly s: SessionImpl) {}

  fact(action: string, outcome: string, actor: Actor, details: Record<string, unknown> = {}): EventInput {
    return this.s.ev(
      'x/core/control',
      { action, outcome, loop: this.s.loop, ...details },
      {
        origin: 'principal',
        actor,
        ignorable: true,
      },
    )
  }

  async require(action: 'steer' | 'interrupt' | 'pause', actor: Actor): Promise<void> {
    if (this.s.d.loopFactory.controls?.[action] === true) return
    await this.s.d.log.append([this.fact(action, 'refused', actor, { reason: 'LOOP_CONTROL_UNSUPPORTED' })])
    throw new CoreError('E_UNSUPPORTED', `Pinned Loop does not support ${action}`, {
      reason: 'LOOP_CONTROL_UNSUPPORTED',
      control: action,
      loop: this.s.loop,
    })
  }

  async paused(): Promise<boolean> {
    const [row] = await this.s.d.log.scan({ type: PAUSE, lane: this.s.lane, order: 'desc', limit: 1 })
    return (row?.data as { paused?: boolean } | undefined)?.paused === true
  }

  async boundary(): Promise<boolean> {
    return this.s.locked(async () => {
      const [row] = await this.s.d.log.scan({ type: PAUSE, lane: this.s.lane, order: 'desc', limit: 1 })
      const data = row?.data as { paused?: boolean; applied?: boolean } | undefined
      if (!row || !data?.paused) return false
      if (!data.applied)
        await this.s.d.log.append([
          this.s.ev(
            PAUSE,
            { paused: true, applied: true },
            { actor: row.actor, origin: 'principal', ignorable: true },
          ),
          this.fact('pause', 'applied', row.actor),
        ])
      return true
    })
  }

  async state() {
    return {
      controls: { ...this.s.d.loopFactory.controls, cancel: true },
      paused: await this.paused(),
      pending: structuredClone((this.s.latest('inbox') as Inbox | undefined)?.items ?? []),
    }
  }

  /** Queue claim and delivery share the same lock as edit/withdraw; stale selections never resurrect content. */
  async claim(itemId?: string) {
    return this.s.locked(async () => {
      const op = this.s.op()
      if (!op) return null
      const inbox = (this.s.latest('inbox') as Inbox | undefined) ?? { items: [] }
      const item = inbox.items.find(
        (item) => item.target === 'next-step' && (!itemId || item.itemId === itemId),
      )
      if (!item) return null
      const next =
        op.phase.kind === 'failure_drain'
          ? withPhase(op, {
              kind: 'checkpoint',
              continuation: 'need_assistant',
              triggerSeq: op.meta.triggerSeq,
              skipInboxOnce: true,
            })
          : op.phase.kind === 'checkpoint'
            ? withPhase(op, { ...op.phase, continuation: 'need_assistant', skipInboxOnce: true })
            : op
      await this.s.d.log.append(
        [
          inboxEvent(this.s.lane, this.s.d.actor, {
            items: inbox.items.filter((candidate) => candidate.itemId !== item.itemId),
          }),
          this.s.ev(
            'user/message',
            { content: item.content, kind: item.kind ?? 'steer' },
            { origin: 'principal', trust: item.trust ?? 'trusted', actor: item.actor },
          ),
          this.fact('steer', 'delivered', item.actor, { itemId: item.itemId }),
        ],
        {
          expectedRegisterSeq: { register: 'op.state', key: this.s.lane, seq: this.s.opSeq() },
          opState: { lane: this.s.lane, data: next },
        },
      )
      return structuredClone(item)
    })
  }

  async edit(itemId: string, content: ContentBlock[], actor: Actor, admissionId: string): Promise<Seq> {
    await this.require('steer', actor)
    validateUserMessageImages(content)
    if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 256_000)
      throw new CoreError('E_ENVELOPE', 'Queued input is too large')
    return this.s.locked(async () => {
      const inbox = (this.s.latest('inbox') as Inbox | undefined) ?? { items: [] }
      if (!inbox.items.some((item) => item.itemId === itemId))
        throw new CoreError('E_RELATION', 'queued input is no longer pending', { itemId })
      const result = await this.s.d.log.append([
        inboxEvent(this.s.lane, actor, {
          items: inbox.items.map((item) =>
            item.itemId === itemId ? { ...item, content: structuredClone(content) } : item,
          ),
        }),
        this.fact('steer', 'edited', actor, { itemId, admissionId }),
      ])
      return result.firstSeq
    })
  }

  async ending() {
    const op = this.s.op()
    if (!op) return null
    const rows = await this.s.d.log.scan({
      type: 'x/core/control',
      lane: this.s.lane,
      fromSeq: op.meta.triggerSeq,
      order: 'desc',
      limit: 100,
    })
    const row = rows.find((row) => {
      const data = row.data as { action?: string; outcome?: string }
      return data.outcome === 'requested' && (data.action === 'cancel' || data.action === 'interrupt')
    })
    if (!row) return null
    const data = row.data as { action: string; admissionId: string; itemId?: string }
    return {
      reason: data.action === 'interrupt' ? ('interrupted' as const) : ('aborted' as const),
      event: this.fact(data.action, 'applied', row.actor, {
        admissionId: data.admissionId,
        ...(data.itemId ? { itemId: data.itemId } : {}),
      }),
    }
  }

  async apply(action: SessionControl, actor: Actor, admissionId: string, itemId?: string): Promise<Seq> {
    if (action === 'pause' || action === 'resume') {
      await this.require('pause', actor)
      const seq = await this.s.locked(async () => {
        if (!this.s.op()) throw new CoreError('E_RELATION', 'Pause/resume requires an open turn')
        const result = await this.s.d.log.append([
          this.s.ev(PAUSE, { paused: action === 'pause' }, { actor, origin: 'principal', ignorable: true }),
          this.fact(action, action === 'pause' ? 'requested' : 'applied', actor, { admissionId }),
        ])
        return result.firstSeq
      })
      if (action === 'resume') await this.s.resume()
      return seq
    }
    if (action === 'interrupt') {
      await this.require('interrupt', actor)
      if (!itemId) throw new CoreError('E_ENVELOPE', 'Interrupt requires a queued input')
      return this.s.sendQueuedNow(itemId, actor, admissionId)
    }
    const result = await this.s.locked(async () => {
      const inbox = (this.s.latest('inbox') as Inbox | undefined) ?? { items: [] }
      const returned = inbox.items.filter((item) => item.kind === 'steer')
      const op = this.s.op()
      return this.s.d.log.append(
        [
          inboxEvent(this.s.lane, actor, { items: inbox.items.filter((item) => item.kind !== 'steer') }),
          this.s.ev(PAUSE, { paused: false }, { actor, origin: 'principal', ignorable: true }),
          this.fact(action, 'requested', actor, { admissionId, returned }),
          ...(!op ? [this.fact(action, 'applied', actor, { admissionId })] : []),
        ],
        op
          ? {
              expectedRegisterSeq: { register: 'op.state', key: this.s.lane, seq: this.s.opSeq() },
              opState: {
                lane: this.s.lane,
                data: withPhase(op, op.phase, {
                  control: {
                    status: 'cancel_requested',
                    by: actor,
                    requestedAt: new Date(this.s.d.clock()).toISOString(),
                  },
                }),
              },
            }
          : {},
      )
    })
    await this.s.abort(actor)
    await this.s.drainCancelledTurn()
    return result.firstSeq
  }
}
