import hooksJson from '../../data/hooks-map.json' with { type: 'json' }
import rootsJson from '../../data/skill-roots.json' with { type: 'json' }
import { checkHooksMap, checkSkillRoots } from './check.js'
import type { Check, HooksMap, SkillRoot } from './types.js'

function parse(text: string): Check<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, problems: ['invalid JSON: parse failed'] }
  }
}
export function parseSkillRootsJson(text: string): Check<SkillRoot[]> {
  const result = parse(text)
  return result.ok ? checkSkillRoots(result.value) : result
}
export function parseHooksMapJson(text: string): Check<HooksMap> {
  const result = parse(text)
  return result.ok ? checkHooksMap(result.value) : result
}
function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}
function accept<T>(name: string, result: Check<T>): T {
  if (!result.ok) throw new Error(`${name}: ${result.problems.join('; ')}`)
  return freeze(result.value)
}
const roots = accept('invalid data/skill-roots.json', checkSkillRoots(rootsJson))
const hooks = accept('invalid data/hooks-map.json', checkHooksMap(hooksJson))
export const loadSkillRoots = (): readonly SkillRoot[] => roots
export const loadHooksMap = (): Readonly<HooksMap> => hooks
