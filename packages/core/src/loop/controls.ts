import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import { type Actor, type ContentBlock, MAX_FRAME_BYTES } from '@agnes/protocol'
import { validateUserMessageImages } from '../request/user-message-images.js'
import { inboxEvent, inputMessageEvents } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'
import { applyChildControl, controlledChildTree } from './child-controls.js'

export type SessionControl = 'pause' | 'resume' | 'cancel' | 'interrupt' | 'child-stop' | 'child-continue'
const PAUSE = 'x/core/pause-state'

/** Core-owned controls apply to the session's pinned factory, independent of its scheduler. */
export class SessionControls {
  interrupting = false
  private activeEffects = 0
  /** Public effect ports fence input delivery even when a plugin overlaps operations. */
  async beginEffect(): Promise<() => void> {
    return this.s.locked(async () => {
      if (await this.paused())
        throw new CoreError('E_LANE_BUSY', 'Session is paused', { reason: 'CONTROL_PAUSED' })
      this.activeEffects++
      return () => {
        this.activeEffects--
      }
    })
  }
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

  async state(afterSeq?: number) {
    const through = this.s.lastSeq
    const rows = await this.s.d.log.scan({
      type: 'x/core/control',
      lane: this.s.lane,
      toSeq: through,
      order: afterSeq === undefined ? 'desc' : 'asc',
      ...(afterSeq === undefined ? {} : { fromSeq: afterSeq + 1 }),
      limit: 200,
    })
    return {
      children: await controlledChildTree(this.s),
      factsMore: afterSeq !== undefined && rows.length === 200,
      factsThrough: afterSeq !== undefined && rows.length === 200 ? rows.at(-1)!.seq : through,
      facts: (afterSeq === undefined ? rows.reverse() : rows).map((row) => {
        const details = row.data as { action: string; outcome: string }
        return {
          seq: row.seq,
          ts: row.ts,
          actor: row.actor,
          action: details.action,
          outcome: details.outcome,
          details: row.data,
        }
      }),
      controls: {
        steer: this.s.d.loopFactory.controls?.steer === true,
        interrupt: this.s.d.loopFactory.controls?.interrupt === true,
        pause: this.s.d.loopFactory.controls?.pause === true,
        cancel: true,
      },
      paused: await this.paused(),
      pending: ((this.s.latest('inbox') as Inbox | undefined)?.items ?? []).map((item) => ({
        itemId: item.itemId,
        target: item.target,
        kind: item.kind ?? 'prompt',
        content: structuredClone(item.content),
      })),
    }
  }

  /** Queue claim and delivery share the same lock as edit/withdraw; stale selections never resurrect content. */
  async claim(itemId?: string) {
    return this.s.locked(async () => {
      const op = this.s.op()
      if (!op || this.activeEffects > 0 || (await this.paused())) return null
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
          ...inputMessageEvents(item, this.s.lane),
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
    content = structuredClone(content)
    return this.s.locked(async () => {
      const inbox = (this.s.latest('inbox') as Inbox | undefined) ?? { items: [] }
      if (!inbox.items.some((item) => item.itemId === itemId)) {
        await this.s.d.log.append([
          this.fact('steer', 'refused', actor, {
            itemId,
            admissionId,
            operation: 'edit',
            reason: 'QUEUED_INPUT_GONE',
          }),
        ])
        throw new CoreError('E_RELATION', 'queued input is no longer pending', { itemId })
      }
      const next = {
        items: inbox.items.map((item) => (item.itemId === itemId ? { ...item, content } : item)),
      }
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_FRAME_BYTES - 4096)
        throw new CoreError('E_ENVELOPE', 'Queued input is too large')
      const result = await this.s.d.log.append([
        inboxEvent(this.s.lane, actor, next),
        this.fact('steer', 'edited', actor, { itemId, admissionId }),
      ])
      return result.firstSeq
    })
  }

  async ending() {
    const op = this.s.op()
    if (!op) return null
    for await (const rows of scanPages((query) => this.s.d.log.scan(query), {
      type: 'x/core/control',
      lane: this.s.lane,
      fromSeq: op.meta.triggerSeq,
      toSeq: this.s.lastSeq,
      order: 'desc',
    })) {
      const row = rows.find((row) => {
        const data = row.data as { action?: string; outcome?: string }
        return data.outcome === 'requested' && (data.action === 'cancel' || data.action === 'interrupt')
      })
      if (!row) continue
      const data = row.data as { action: string; admissionId: string; itemId?: string }
      return {
        reason: data.action === 'interrupt' ? ('interrupted' as const) : ('aborted' as const),
        event: this.fact(data.action, 'applied', row.actor, {
          admissionId: data.admissionId,
          ...(data.itemId ? { itemId: data.itemId } : {}),
        }),
      }
    }
    return null
  }

  async apply(
    action: SessionControl,
    actor: Actor,
    admissionId: string,
    itemId?: string,
    child?: { id: string; text?: string },
  ): Promise<Seq> {
    if (action === 'child-stop' || action === 'child-continue') {
      if (!child?.id) throw new CoreError('E_ENVELOPE', 'Child control requires a child id')
      return applyChildControl(
        this.s,
        child.id,
        action === 'child-stop' ? 'stop' : 'continue',
        actor,
        admissionId,
        child.text,
      )
    }
    if (action === 'pause' || action === 'resume') {
      await this.require('pause', actor)
      const seq = await this.s.locked(async () => {
        if (!this.s.op()) {
          await this.s.d.log.append([
            this.fact(action, 'refused', actor, { admissionId, reason: 'CONTROL_NOT_RUNNING' }),
          ])
          throw new CoreError('E_RELATION', 'Pause/resume requires an open turn', {
            reason: 'CONTROL_NOT_RUNNING',
          })
        }
        const result = await this.s.d.log.append([
          this.s.ev(PAUSE, { paused: action === 'pause' }, { actor, origin: 'principal', ignorable: true }),
          this.fact(action, action === 'pause' ? 'requested' : 'applied', actor, { admissionId }),
        ])
        return result.firstSeq
      })
      if (action === 'resume' && !this.s.turn) await this.s.resume()
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
          inboxEvent(this.s.lane, actor, {
            items: inbox.items
              .filter((item) => item.kind !== 'steer')
              .map((item) =>
                item.target === 'next-step' ? { ...item, target: 'next-turn' as const } : item,
              ),
          }),
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
    await this.s.restartLoopDriver()
    return result.firstSeq
  }
}
