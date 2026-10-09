import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { RegisterParams } from '../gen/ts/mhs-v1.js'
import * as MhsV1 from '../gen/ts/mhs-v1.js'

type DefName = keyof typeof MhsV1 & string
const DEFS = MhsV1 as unknown as Record<DefName, TSchema>

/** Why value does not satisfy a definition of mhs-v1.json, one line per problem; empty when valid. */
export function problems(def: DefName, value: unknown): string[] {
  const schema = DEFS[def]
  if (Value.Check(schema, value)) return []
  const found = [...Value.Errors(schema, value)].map((e) => `${e.path || '(root)'}: ${e.message}`)
  return found.length > 0 ? found.slice(0, 5) : [`not a valid ${def}`]
}

/**
 * The rules of a device description that a schema cannot state (REG-2, REG-4, 6.3, 13.5, MAP-1):
 * unique ids, uses naming declared resources, references to declared sources, and the placement
 * of a fixed device.
 */
export function registerProblems(params: RegisterParams): string[] {
  const found: string[] = []
  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) found.push(`${what} ${id} is declared twice`)
      seen.add(id)
    }
  }
  const sources = params.sources ?? []
  const tools = params.tools ?? []
  const resources = new Set(Object.keys(params.resources ?? {}))
  const sourceIds = new Set(sources.map((s) => s.id))
  unique(
    'source',
    sources.map((s) => s.id),
  )
  unique(
    'tool',
    tools.map((t) => t.name),
  )
  unique(
    'axis',
    (params.manual?.axes ?? []).map((a) => a.id),
  )
  for (const tool of tools)
    for (const use of tool.uses ?? [])
      if (!resources.has(use)) found.push(`tool ${tool.name} uses ${use}, which is not in resources`)
  for (const source of sources) {
    const of = (source as { of?: string }).of
    if (of !== undefined && !sourceIds.has(of))
      found.push(`source ${source.id} is computed from ${of}, which is not declared`)
  }
  if (params.localization === 'fixed' && !params.placement)
    found.push('localization fixed needs placement {map, x, y, yaw} (REG-4)')
  unique(
    'map',
    (params.maps ?? []).map((m) => m.id),
  )
  for (const map of params.maps ?? [])
    unique(
      `map ${map.id}: place`,
      (map.places ?? []).map((p) => p.id),
    )
  const primary = params.ui?.primary
  if (primary !== undefined && !sourceIds.has(primary))
    found.push(`ui.primary names ${primary}, which is not declared`)
  return found
}
