import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRunProgress, type RunProgress } from '@agnes/base/schedule'
import { validateAgainst } from '@agnes/protocol'
import {
  type WebhookConfig,
  type WebhookDelivery,
  type WebhookRule,
  WebhookSnapshot,
} from '@agnes/protocol/gen/app-server'
import { syncDirectorySync } from '@agnes/system-node'
import { validatePaths } from './payload.js'

export type State = {
  config: WebhookConfig
  rules: WebhookRule[]
  deliveries: WebhookDelivery[]
  dedup: { key: string; expires: number }[]
  rates: Record<string, number[]>
  progress?: Record<string, RunProgress>
}
export class WebhookStore {
  private healthy = true
  private lastSavedAt = Date.now()
  readonly state: State
  constructor(private readonly path: string) {
    this.state = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : {
          config: { enabled: false, path: '/hooks/events', maxPayloadBytes: 262144 },
          rules: [],
          deliveries: [],
          dedup: [],
          rates: {},
        }
    if (
      (this.state.progress !== undefined &&
        (!this.state.progress ||
          typeof this.state.progress !== 'object' ||
          Array.isArray(this.state.progress) ||
          Object.values(this.state.progress).some((value) => !isRunProgress(value)))) ||
      !validateAgainst(WebhookSnapshot, { ...this.snapshot(), secretRefs: [] }).ok ||
      !Array.isArray(this.state.dedup) ||
      this.state.dedup.length > 10000 ||
      this.state.dedup.some(
        (item) =>
          !item ||
          typeof item.key !== 'string' ||
          item.key.length > 1024 ||
          !Number.isSafeInteger(item.expires),
      ) ||
      !this.state.rates ||
      typeof this.state.rates !== 'object' ||
      Array.isArray(this.state.rates) ||
      Object.keys(this.state.rates).length > 128 ||
      Object.entries(this.state.rates).some(
        ([id, times]) =>
          !this.state.rules.some((rule) => rule.id === id) ||
          !Array.isArray(times) ||
          times.length > 1000 ||
          times.some((at) => !Number.isSafeInteger(at) || at < 0),
      ) ||
      new Set(this.state.rules.map((rule) => rule.id)).size !== this.state.rules.length
    )
      throw new Error('Invalid webhook store')
    for (const rule of this.state.rules) validatePaths(rule)
    // Rule ids such as "constructor" must never read Object.prototype as a rate bucket.
    this.state.rates = Object.assign(Object.create(null), this.state.rates)
    // No automatic retry after a crash: session admission may already have happened.
    for (const row of this.state.deliveries) if (row.status === 'pending') row.status = 'unknown'
  }
  snapshot() {
    return structuredClone({
      config: this.state.config,
      rules: this.state.rules,
      deliveries: this.state.deliveries,
    })
  }
  save(): void {
    if (!this.healthy) throw new Error('Webhook persistence unavailable')
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx', flush: true })
      renameSync(temp, this.path)
      syncDirectorySync(dirname(this.path))
      this.lastSavedAt = Date.now()
    } catch (error) {
      this.healthy = false
      throw error
    }
  }
  /** Unverified traffic may update diagnostics, but can drive at most one flush per five seconds.
   * The next durable administration or verified-delivery write also includes these bounded rows.
   * There is no background timer: a quiet tail may remain only in memory until that next write.
   */
  logUnverified(status: WebhookDelivery['status'], ruleId?: string): WebhookDelivery {
    const row = this.log(status, ruleId, undefined, false)
    if (Date.now() - this.lastSavedAt >= 5000) this.save()
    return row
  }
  log(
    status: WebhookDelivery['status'],
    ruleId?: string,
    sessionId?: string,
    durable = true,
  ): WebhookDelivery {
    const row: WebhookDelivery = {
      id: randomUUID(),
      at: Date.now(),
      status,
      ...(ruleId ? { ruleId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }
    this.state.deliveries.unshift(row)
    if (this.state.deliveries.length > 200) {
      // Keep the outstanding run even after many flagged recurrences; losing it would permit
      // another hidden parked session. At most one pending occurrence per rule is admitted.
      const disposable = this.state.deliveries.findLastIndex(
        (entry) => !entry.sessionId || !['waiting_approval', 'needs_attention'].includes(entry.status),
      )
      if (disposable >= 0) this.state.deliveries.splice(disposable, 1)
      else throw new Error('Webhook attention capacity reached')
    }
    if (durable) this.save()
    return row
  }
}
