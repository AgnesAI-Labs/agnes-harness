import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { parseAgentRef } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'

/** The session a reference is checked for, as the host finds it. */
export type ReferenceSession = { key: string; lane: string }
/** A skill as the host lists it for that session now: its current revision and whether it may be used. */
export type ReferencedSkill = { resourceId: string; revision: string; usable: boolean; name?: string }

/**
 * How the host answers which approved resources skill and subagent entries may be bound to for a
 * session now. `skills` lists the skills visible in that session's workspace, `usable` only while one
 * is enabled, trusted, ready and visible to the model; `agents` lists the roles the session may
 * delegate to now. One check asks each at most once, however many entries it looks at. A read that
 * throws, or does not answer within `REFERENCE_LOOKUP_MS`, lists nothing: every reference of that
 * kind is then unavailable.
 */
export type RefinementReferences = {
  skills(session: ReferenceSession): readonly ReferencedSkill[] | Promise<readonly ReferencedSkill[]>
  agents(session: ReferenceSession): readonly string[] | Promise<readonly string[]>
}

/** How long one host lookup may take before it counts as unavailable. */
export const REFERENCE_LOOKUP_MS = 5_000
const MAX_REFERENCE = 512
// No whitespace or control characters: a reference is an identifier, never text the model reads as prose.
const PLAIN = /^[^\s\p{Cc}]+$/u

type Parsed = { kind: 'skill'; resourceId: string; revision: string } | { kind: 'subagent'; ref: string }

/**
 * A reference as its kind spells it: `<resourceId>@<revision>` for a skill, an agent reference
 * (`<package>#<bundle>`) for a subagent. Undefined when it is not one, or the kind takes none.
 */
function parse(kind: HarnessEntry['kind'], reference: unknown): Parsed | undefined {
  if (typeof reference !== 'string' || reference.length > MAX_REFERENCE || !PLAIN.test(reference))
    return undefined
  if (kind === 'skill') {
    const at = reference.lastIndexOf('@')
    if (at <= 0 || at === reference.length - 1) return undefined
    return { kind, resourceId: reference.slice(0, at), revision: reference.slice(at + 1) }
  }
  if (kind !== 'subagent') return undefined
  try {
    return { kind, ref: parseAgentRef(reference) }
  } catch {
    return undefined
  }
}

/** Whether `reference` is well formed for an entry of `kind`; only skills and subagents take one. */
export const isReference = (kind: HarnessEntry['kind'], reference: unknown): reference is string =>
  parse(kind, reference) !== undefined

/** `read()`, or an empty list when it throws or takes longer than the lookup bound. */
async function bounded<T>(read: () => readonly T[] | Promise<readonly T[]>): Promise<readonly T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), REFERENCE_LOOKUP_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    const listed = await Promise.race([Promise.resolve().then(read), late])
    return Array.isArray(listed) ? listed : []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

type Found = { ref: string } | { resourceId: string; name?: string }
type Lookup = (kind: HarnessEntry['kind'], reference: string) => Promise<Found | undefined>

/**
 * One check's view of what the host lists for the session: skills and roles are each read at most
 * once, and only when a reference of that kind is looked up.
 */
function resolver(s: SessionImpl): Lookup {
  const port = s.d.refinement?.references
  const at = { key: s.key, lane: s.lane }
  let skills: Promise<readonly ReferencedSkill[]> | undefined
  let agents: Promise<readonly string[]> | undefined
  return async (kind, reference) => {
    const parsed = parse(kind, reference)
    if (!port || !parsed) return undefined
    if (parsed.kind === 'subagent') {
      agents ??= bounded(() => port.agents(at))
      return (await agents).includes(parsed.ref) ? { ref: parsed.ref } : undefined
    }
    skills ??= bounded(() => port.skills(at))
    const skill = (await skills).find((item) => item?.resourceId === parsed.resourceId)
    return skill?.usable === true && skill.revision === parsed.revision
      ? { resourceId: parsed.resourceId, ...(typeof skill.name === 'string' ? { name: skill.name } : {}) }
      : undefined
  }
}

type Bound = { op: string; kind: HarnessEntry['kind']; id: string; reference?: string }

/**
 * The upserts among `edits` whose reference cannot be used now (not visible, not enabled, not
 * trusted, not visible to the model, another revision, or a role the session may not delegate to), as `kind/id`. Without a host
 * that can check references, every reference is unavailable.
 */
export async function unavailableReferences(s: SessionImpl, edits: readonly Bound[]): Promise<string[]> {
  const lookup = resolver(s)
  const out: string[] = []
  for (const edit of edits)
    if (edit.op === 'upsert' && edit.reference !== undefined && !(await lookup(edit.kind, edit.reference)))
      out.push(`${edit.kind}/${edit.id}`)
  return out
}

/** The metadata text of an entry whose reference cannot be used now: no instructions are delivered. */
export const UNAVAILABLE_TEXT =
  'unavailable: the approved resource it names cannot be used in this session now; do not try to use it.'

/**
 * Entries as they are delivered: one bound to a reference is checked again, and says either how to
 * invoke the real resource (the skill through `skill_read`, the role through `subagent_spawn`) ahead
 * of its text, or that it is unavailable, without its text. Other entries are returned as they are.
 */
export async function deliveredReferences<T extends { entry: HarnessEntry }>(
  s: SessionImpl,
  items: readonly T[],
): Promise<T[]> {
  const lookup = resolver(s)
  const out: T[] = []
  for (const item of items) {
    const { entry } = item
    if (entry.reference === undefined || (entry.kind !== 'skill' && entry.kind !== 'subagent')) {
      out.push(item)
      continue
    }
    const found = await lookup(entry.kind, entry.reference)
    const via = !found
      ? undefined
      : 'ref' in found
        ? `Use it through subagent_spawn with role "${found.ref}".`
        : found.name
          ? `Read it with skill_read "${found.name}".`
          : `It is the skill ${found.resourceId}.`
    out.push({ ...item, entry: { ...entry, content: via ? `${via} ${entry.content}` : UNAVAILABLE_TEXT } })
  }
  return out
}
