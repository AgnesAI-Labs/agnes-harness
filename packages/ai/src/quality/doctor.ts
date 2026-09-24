import type { ModelRecord, ProbeReport } from '@agnes/protocol'
import type { Registry } from '../registry.js'
import { probeAdapter } from './probe.js'

export type Observation = {
  modelId: string
  thinking: boolean
  nativeToolCalls: boolean
  usageComplete: boolean
  doneReason?: 'stop' | 'toolUse' | 'length'
}
export type DoctorReport = {
  at: string
  ok: boolean
  routes: Array<ProbeReport & { adapter: string }>
  models: Array<{ route: string; id: string; observed: boolean; mismatches: string[] }>
}

export function compareDeclaration(record: ModelRecord, obs: Observation): string[] {
  if (record.id !== obs.modelId) return ['probe: observation belongs to another model']
  const out: string[] = []
  if (record.reasoning && !obs.thinking) out.push('reasoning: declared but not observed by this probe')
  if (record.toolCallFormats.includes('native') && !obs.nativeToolCalls)
    out.push('toolCallFormats: native declared but not observed by this probe')
  if (!obs.usageComplete) out.push('usage: incomplete')
  return out
}

function observations(report: ProbeReport, declared: ReadonlySet<string>): Observation[] {
  const out: Observation[] = []
  for (const check of report.checks) {
    if (check.name !== 'minimal_inference') continue
    if (!check.ok || !check.detail) return []
    try {
      const value: unknown = JSON.parse(check.detail)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const v = value as Record<string, unknown>
      if (
        typeof v.modelId !== 'string' ||
        !v.modelId ||
        !declared.has(v.modelId) ||
        v.modelId.length > 256 ||
        typeof v.thinking !== 'boolean' ||
        typeof v.nativeToolCalls !== 'boolean' ||
        typeof v.usageComplete !== 'boolean' ||
        (v.doneReason !== undefined && !['stop', 'toolUse', 'length'].includes(String(v.doneReason))) ||
        Object.keys(v).some(
          (key) => !['modelId', 'thinking', 'nativeToolCalls', 'usageComplete', 'doneReason'].includes(key),
        )
      )
        return []
      out.push(v as Observation)
    } catch {
      return []
    }
  }
  return out
}

export async function runDoctor(
  registry: Registry,
  opts: { signal: AbortSignal; timeoutMs?: number },
): Promise<DoctorReport> {
  const declarations = registry.routes(),
    catalogue = registry.models()
  const routes: DoctorReport['routes'] = [],
    models: DoctorReport['models'] = []
  for (const declaration of declarations) {
    const hit = registry.lookup(declaration.route)
    if (!hit) throw new Error('diagnostic registry route is missing')
    const report = await probeAdapter(hit.adapter, declaration.route, opts)
    routes.push({ ...report, adapter: hit.adapter.id })
    const routeModels = catalogue.filter((entry) => entry.route === declaration.route)
    const observed = observations(report, new Set(routeModels.map((entry) => entry.id)))
    for (const model of routeModels) {
      const matches = observed.filter((entry) => entry.modelId === model.id)
      const observation = matches.length === 1 ? matches[0] : undefined
      models.push({
        route: model.route,
        id: model.id,
        observed: Boolean(observation),
        mismatches: observation
          ? compareDeclaration(model, observation)
          : ['probe: model observation is missing or ambiguous'],
      })
    }
  }
  return {
    at: new Date().toISOString(),
    routes,
    models,
    ok:
      routes.length > 0 &&
      models.length > 0 &&
      routes.every((route) => route.ok && models.some((model) => model.route === route.route)) &&
      models.every((model) => model.observed && model.mismatches.length === 0),
  }
}
