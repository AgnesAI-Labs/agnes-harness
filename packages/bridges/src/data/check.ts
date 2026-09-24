import { isHookEvent } from '@agnes/protocol'
import { CC_HOOK_EVENTS, type Check, type HooksMap, SKILL_HOSTS, type SkillRoot } from './types.js'

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
function unknownKeys(x: Obj, allowed: string[], at: string): string[] {
  return Object.keys(x)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${at}: unknown key ${key}`)
}
function stringMap(x: unknown, at: string, p: string[]): void {
  if (!isObj(x)) {
    p.push(`${at}: must be an object`)
    return
  }
  for (const [key, value] of Object.entries(x))
    if (typeof value !== 'string' || !value) p.push(`${at}.${key}: must be a non-empty string`)
}
function entry(x: unknown, event: string, p: string[]): void {
  if (!isObj(x)) {
    p.push(`${event}: entry must be an object`)
    return
  }
  p.push(...unknownKeys(x, ['to', 'reason', 'fields', 'unsupportedFields'], event))
  if (x.to === null) {
    if (typeof x.reason !== 'string' || !x.reason) p.push(`${event}: unmapped entry needs reason`)
    if (x.fields !== undefined) p.push(`${event}.fields: unmapped entry must not declare fields`)
  } else if (!Array.isArray(x.to) || x.to.length === 0)
    p.push(`${event}: to must be a non-empty array or null`)
  else {
    const seen = new Set<string>()
    for (const target of x.to) {
      if (typeof target !== 'string' || !isHookEvent(target))
        p.push(`${event}: unknown target ${String(target)}`)
      else if (seen.has(target)) p.push(`${event}.to: duplicate ${target}`)
      else seen.add(target)
    }
    if (!isObj(x.fields)) p.push(`${event}.fields: mapped entry needs field contracts`)
    else {
      p.push(...unknownKeys(x.fields, ['in', 'out'], `${event}.fields`))
      stringMap(x.fields.in, `${event}.fields.in`, p)
      stringMap(x.fields.out, `${event}.fields.out`, p)
    }
  }
  if (x.reason !== undefined && (typeof x.reason !== 'string' || !x.reason))
    p.push(`${event}.reason: must be a non-empty string`)
  if (x.unsupportedFields !== undefined) {
    if (!Array.isArray(x.unsupportedFields)) p.push(`${event}.unsupportedFields: must be an array`)
    else {
      const seen = new Set<string>()
      for (const field of x.unsupportedFields)
        if (typeof field !== 'string' || !field)
          p.push(`${event}.unsupportedFields: entries must be non-empty strings`)
        else if (seen.has(field)) p.push(`${event}.unsupportedFields: duplicate ${field}`)
        else seen.add(field)
    }
  }
}

export function checkSkillRoots(x: unknown): Check<SkillRoot[]> {
  if (!Array.isArray(x)) return { ok: false, problems: ['not an array'] }
  const p: string[] = [],
    seen = new Set<string>()
  for (const [i, root] of x.entries()) {
    if (!isObj(root)) {
      p.push(`[${i}]: must be an object`)
      continue
    }
    p.push(...unknownKeys(root, ['root', 'host', 'layout', 'trust', 'note'], `[${i}]`))
    if (typeof root.root !== 'string' || !root.root) p.push(`[${i}].root: missing`)
    else if (seen.has(root.root)) p.push(`[${i}].root: duplicate ${root.root}`)
    else seen.add(root.root)
    if (typeof root.host !== 'string' || !(SKILL_HOSTS as readonly string[]).includes(root.host))
      p.push(`[${i}].host: unknown host ${String(root.host)}`)
    if (root.layout !== 'dir/SKILL.md') p.push(`[${i}].layout: must be dir/SKILL.md`)
    if (root.trust !== undefined && root.trust !== 'user' && root.trust !== 'workspace')
      p.push(`[${i}].trust: unknown trust ${String(root.trust)}`)
    if (root.note !== undefined && typeof root.note !== 'string') p.push(`[${i}].note: must be a string`)
  }
  return p.length ? { ok: false, problems: p } : { ok: true, value: x as SkillRoot[] }
}
export function checkHooksMap(x: unknown): Check<HooksMap> {
  if (!isObj(x)) return { ok: false, problems: ['not an object'] }
  const p = unknownKeys(x, ['version', 'events'], 'root')
  if (x.version !== 1) p.push('version: must be 1')
  if (!isObj(x.events)) return { ok: false, problems: [...p, 'events: must be an object'] }
  for (const event of CC_HOOK_EVENTS) if (!Object.hasOwn(x.events, event)) p.push(`missing ${event}`)
  for (const [event, value] of Object.entries(x.events)) {
    if (!(CC_HOOK_EVENTS as readonly string[]).includes(event)) p.push(`unknown CC event ${event}`)
    entry(value, event, p)
  }
  return p.length ? { ok: false, problems: p } : { ok: true, value: x as HooksMap }
}
