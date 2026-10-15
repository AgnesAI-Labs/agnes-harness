import { randomUUID } from 'node:crypto'
import { type Json, MhsError, object } from '@agnes/mhs-device'
import type { Activity } from './activity.js'
import type { DeviceView } from './hub.js'
import { digest, type Journal } from './journal.js'
import type { Invocation } from './ports.js'

type Condition = Record<string, Json>
type Watch = {
  id: string
  device: string
  until: Condition
  note?: string
  deadline: number
  sessionId: string
  target: { bindingId: string }
  active: boolean
  generation: string
  after: number
}
function validate(condition: Condition): void {
  const keys = Object.keys(condition)
  const selector = ['state', 'source', 'health', 'trust'].filter((k) => Object.hasOwn(condition, k))
  if (selector.length !== 1 || typeof condition[selector[0] ?? ''] !== 'string')
    throw new MhsError('invalid-condition')
  if (condition.health !== undefined || condition.trust !== undefined) {
    if (
      keys.length !== 1 ||
      (condition.health !== undefined && !['ok', 'attention', 'bad'].includes(String(condition.health))) ||
      (condition.trust !== undefined && !['trusted', 'uncertain', 'lost'].includes(String(condition.trust)))
    )
      throw new MhsError('invalid-condition')
    return
  }
  const operators = ['lt', 'gt', 'eq', 'ne', 'has', 'says'].filter((k) => Object.hasOwn(condition, k))
  if (operators.length !== 1 || keys.some((k) => !['state', 'source', 'field', ...operators].includes(k)))
    throw new MhsError('invalid-condition')
  if (condition.state && keys.includes('field')) throw new MhsError('invalid-condition')
}
function matches(condition: Condition, view: DeviceView, source?: string, data?: Json): boolean {
  if (condition.health) return view.health === condition.health
  if (condition.trust) return view.trust === condition.trust
  let value: Json | undefined
  if (typeof condition.state === 'string') value = view.state[condition.state]
  else {
    if (source !== condition.source) return false
    if (condition.has) {
      const payload = object(data)
      return (
        Array.isArray(payload.items) && payload.items.some((item) => object(item).label === condition.has)
      )
    }
    if (condition.says)
      return (
        typeof object(data).text === 'string' &&
        String(object(data).text).toLowerCase().includes(String(condition.says).toLowerCase())
      )
    value =
      data !== null && typeof data === 'object' && !Array.isArray(data) ? data[String(condition.field)] : data
  }
  if (value === undefined) return false
  if (condition.lt !== undefined)
    return typeof value === 'number' && typeof condition.lt === 'number' && value < condition.lt
  if (condition.gt !== undefined)
    return typeof value === 'number' && typeof condition.gt === 'number' && value > condition.gt
  if (condition.eq !== undefined) return value === condition.eq
  if (condition.ne !== undefined) return value !== condition.ne
  return false
}
export class Watches {
  private readonly generation = randomUUID()
  private sequence = 0
  private running: Promise<void> = Promise.resolve()
  constructor(
    private readonly journal: Journal,
    private readonly activity: Activity,
    private readonly views: () => DeviceView[],
    private readonly now = Date.now,
  ) {}
  async create(
    device: string,
    until: Condition,
    timeout: number,
    invocation: Invocation,
    note?: string,
  ): Promise<{ watch: string }> {
    validate(until)
    if (note !== undefined && note.length > 1024) throw new MhsError('invalid-watch')
    if (
      !invocation.target ||
      !invocation.sessionId ||
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      timeout > 3600
    )
      throw new MhsError('invalid-watch')
    const id = invocation.operationId
    await this.journal.accept(
      device,
      { device, until, timeout, note: note ?? null, binding: invocation.target.bindingId },
      invocation,
      (tx) => {
        tx.put(
          `watch/${digest(id)}`,
          {
            id,
            device,
            until,
            ...(note ? { note } : {}),
            deadline: this.now() + timeout * 1000,
            sessionId: invocation.sessionId ?? '',
            target: { bindingId: invocation.target?.bindingId ?? '' },
            active: true,
            generation: this.generation,
            after: this.sequence,
          },
          null,
        )
      },
    )
    return { watch: id }
  }
  async cancel(id: string, invocation: Invocation): Promise<void> {
    await this.journal.finish(id, { status: 'interrupted', reason: 'cancel' }, (tx) => {
      const key = `watch/${digest(id)}`
      const prior = tx.get(key)
      if (!prior) throw new MhsError('watch-not-found')
      const watch = prior.value as unknown as Watch
      if (
        !invocation.sessionId ||
        watch.sessionId !== invocation.sessionId ||
        watch.target.bindingId !== invocation.target?.bindingId
      )
        throw new MhsError('watch-owner-mismatch')
      tx.put(key, { ...watch, active: false }, prior.revision)
    })
    await this.journal.flush()
  }
  tick(changedDevice?: string): Promise<void> {
    return this.schedule(changedDevice)
  }
  observe(device: string, source: string, data: Json): Promise<void> {
    return this.schedule(device, source, data)
  }
  private schedule(device?: string, source?: string, data?: Json): Promise<void> {
    const sequence = ++this.sequence
    const next = this.running.catch(() => {}).then(() => this.check(sequence, device, source, data))
    this.running = next
    return next
  }
  private async check(sequence: number, device?: string, source?: string, data?: Json): Promise<void> {
    await this.journal.each('watch/', async (row) => {
      const watch = row as unknown as Watch
      if (!watch.active) return
      const view = this.views().find((v) => v.id === watch.device)
      const timedOut = this.now() >= watch.deadline
      if (
        !timedOut &&
        !(
          (watch.generation !== this.generation || sequence > watch.after) &&
          device === watch.device &&
          view &&
          matches(watch.until, view, source, data)
        )
      )
        return
      const outcome = { status: 'done' as const, reason: timedOut ? 'timeout' : 'condition' }
      // Terminal receipt, active index and outbox share the same commit.
      await this.journal.finish(watch.id, outcome, (tx) => {
        const key = `watch/${digest(watch.id)}`
        const prior = tx.get(key)
        if (prior) tx.put(key, { ...object(prior.value), active: false } as Json, prior.revision)
      })
      await this.activity.append(
        'watch',
        { watch: watch.id, reason: outcome.reason },
        watch.device,
        watch.sessionId,
      )
    })
    await this.journal.flush()
  }
}
