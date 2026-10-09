import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
}
export class WebhookStore {
  private healthy = true
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
    } catch (error) {
      this.healthy = false
      throw error
    }
  }
  log(status: WebhookDelivery['status'], ruleId?: string, sessionId?: string): WebhookDelivery {
    const row: WebhookDelivery = {
      id: randomUUID(),
      at: Date.now(),
      status,
      ...(ruleId ? { ruleId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }
    this.state.deliveries.unshift(row)
    this.state.deliveries.length = Math.min(200, this.state.deliveries.length)
    this.save()
    return row
  }
}
