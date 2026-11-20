import type { ConfigAccount, EventEnvelope } from '@agnes/protocol'
import { telemetryModel, telemetryRoute } from './routes.js'
import { postTelemetry, record, type Surface, telemetryId, type telemetryRuntime } from './wire.js'

type Counts = {
  turns: number
  errors: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
}

type Model = Counts & { route: string; model: string; surface: Surface }
const emptyCounts = (): Counts => ({
  turns: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
})
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

export const ACTIVITY_EVENTS = new Set([
  'turn/start',
  'request/sent',
  'cost/ledger',
  'turn/end',
  'x/core/compaction-end',
])

export class ActivityWindow {
  readonly start: number
  readonly surfaces = new Set<Surface>()
  readonly activity = { sessions_created: 0, turns_submitted: 0, compactions: 0 }
  readonly models = new Map<string, Model>()
  constructor(start: number) {
    this.start = start
  }

  model(route: string, model: string, surface: Surface): Model | undefined {
    const key = JSON.stringify([route, model, surface])
    const prior = this.models.get(key)
    if (prior) return prior
    if (this.models.size >= 1000) return undefined
    const row = { route, model, surface, ...emptyCounts() }
    this.models.set(key, row)
    return row
  }

  reportModels(accounts: readonly ConfigAccount[]) {
    const grouped = new Map<
      string,
      Omit<Model, 'route' | 'model'> & {
        provider_id: string
        model_id: string
        auth_type: ReturnType<typeof telemetryRoute>['auth_type']
      }
    >()
    for (const { route, model, surface, ...counts } of this.models.values()) {
      const provider = telemetryRoute(accounts, route)
      const model_id = telemetryModel(provider, model, accounts)
      const key = JSON.stringify([provider.provider_id, model_id, provider.auth_type, surface])
      let row = grouped.get(key)
      if (!row) {
        if (grouped.size >= 100) continue
        row = { ...provider, model_id, surface, ...emptyCounts() }
        grouped.set(key, row)
      }
      for (const field of Object.keys(counts) as (keyof Counts)[]) row[field] += counts[field]
    }
    return [...grouped.values()]
  }
}

type LastRequest = { route: string; model: string; awaitingCost: boolean; errored: boolean }
const TURNS = new Set(['prompt', 'steer', 'follow_up'])

export function activityObserver() {
  const requests = new Map<string, LastRequest>()
  return {
    clear: () => requests.clear(),
    observe(window: ActivityWindow, session: string, surface: Surface, event: EventEnvelope) {
      window.surfaces.add(surface)
      const data = record(event.data)
      const lane = JSON.stringify([session, event.lane ?? 'main'])
      const last = requests.get(lane)
      switch (event.type) {
        case 'turn/start':
          if (TURNS.has(String(data.trigger))) window.activity.turns_submitted++
          break
        case 'x/core/compaction-end':
          window.activity.compactions++
          break
        case 'request/sent': {
          const { id, route } = record(data.model)
          if (typeof id !== 'string' || typeof route !== 'string') break
          const row = window.model(route, id, surface)
          if (row) row.turns++
          const oldest = requests.keys().next().value
          if (requests.size >= 1024 && oldest !== undefined) requests.delete(oldest)
          requests.set(lane, { route, model: id, awaitingCost: true, errored: false })
          break
        }
        case 'cost/ledger': {
          if (data.adjustment || typeof data.model !== 'string') break
          const match = data.purpose === 'inference' && last?.model === data.model ? last : undefined
          const route = typeof data.route === 'string' ? data.route : match ? match.route : ''
          const row = window.model(route, data.model, surface)
          if (!row) break
          if (!match?.awaitingCost) row.turns++
          if (match) match.awaitingCost = false
          const tokens = record(data.tokens)
          row.input_tokens += number(tokens.input)
          row.output_tokens += number(tokens.output)
          row.cache_read_tokens += number(tokens.cacheRead)
          row.cache_write_tokens += number(tokens.cacheWrite)
          row.reasoning_tokens += number(tokens.reasoning)
          if (data.interrupted === true) {
            row.errors++
            if (match) match.errored = true
          }
          break
        }
        case 'turn/end': {
          if (data.reason === 'error' && last && !last.errored) {
            const row = window.model(last.route, last.model, surface)
            if (row) row.errors++
          }
          requests.delete(lane)
          break
        }
      }
    },
  }
}

export async function sendActivityReport(options: {
  current: ActivityWindow
  starts: number
  runtime: ReturnType<typeof telemetryRuntime>
  installId: string
  endpoint: URL
  clock: () => number
  traceEnabled: () => boolean
  accounts: () => Promise<readonly ConfigAccount[]>
  signal: AbortSignal
}): Promise<void> {
  const { current, starts, runtime, installId, endpoint, clock, traceEnabled, signal } = options
  const accounts = await options.accounts()
  signal.throwIfAborted()
  const now = clock()
  const body = JSON.stringify({
    schema_version: 1,
    report_id: telemetryId(now),
    window_start: new Date(current.start).toISOString(),
    window_end: new Date(now).toISOString(),
    context: { ...runtime, install_id: installId, trace_upload_enabled: traceEnabled() },
    activity: { ...current.activity, surfaces: [...current.surfaces], daemon_starts: starts },
    models: current.reportModels(accounts),
  })
  await postTelemetry(endpoint, '/v1/telemetry/report', body, signal)
}
