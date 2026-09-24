import type { HarnessEntry } from '../reduce/shapes.js'
import type { RegistrySnapshot } from '../registry/tools.js'

// Owned here: the author-facing package does not publish this name, and every core module that
// assembles a request reads it from this file.
export type PromptSection = { id: string; order: number; text: string; source: string }

export type Contribution = {
  op: string
  tools?: string[]
  promptSections?: PromptSection[]
  runtimeContext?: Record<string, unknown>
}
export type Conflict = { key: string; ops: string[] }
/** One section's token cost, as recorded for observability -- text itself is not kept, only its
 * estimated size, so this stays cheap enough to write unconditionally every turn. */
export type ContextSectionSummary = { id: string; order: number; source: string; tokens: number }
export type ContextBreakdownDiag = { sections: ContextSectionSummary[] }
export type Merged = {
  tools: string[]
  sections: PromptSection[]
  runtimeContext: Record<string, unknown>
  conflicts: Conflict[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every op that has written at `key` or anywhere beneath it, in the order they first did. */
function ownersAt(owner: Map<string, string>, key: string): string[] {
  const out: string[] = []
  const direct = owner.get(key)
  if (direct !== undefined) out.push(direct)
  const prefix = `${key}.`
  for (const [k, v] of owner) if (k.startsWith(prefix) && !out.includes(v)) out.push(v)
  return out
}

function forgetSubtree(owner: Map<string, string>, key: string): void {
  const prefix = `${key}.`
  for (const k of [...owner.keys()]) if (k === key || k.startsWith(prefix)) owner.delete(k)
}

function note(conflicts: Map<string, Set<string>>, key: string, prior: string[], op: string): void {
  const set = conflicts.get(key) ?? new Set<string>()
  for (const p of prior) set.add(p)
  set.add(op)
  conflicts.set(key, set)
}

function deepMerge(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
  owner: Map<string, string>,
  op: string,
  conflicts: Map<string, Set<string>>,
  path = '',
): void {
  for (const [k, v] of Object.entries(src)) {
    const key = path ? `${path}.${k}` : k
    if (isObj(v)) {
      // Always descend into plain objects, even where the target has nothing yet: ownership is
      // recorded per leaf path, so writing a whole `{ git: { branch } }` block registers
      // `git.branch`, and a later contribution touching `git.branch` is seen as the conflict it is.
      if (!isObj(target[k])) {
        // A block landing on top of a scalar is a conflict at this path, not a silent overwrite:
        // nothing beneath it can record one, because the scalar owned no leaf below `key`.
        const prior = ownersAt(owner, key).filter((o) => o !== op)
        if (Object.hasOwn(target, k) && prior.length > 0) note(conflicts, key, prior, op)
        forgetSubtree(owner, key)
        target[k] = {}
      }
      deepMerge(target[k] as Record<string, unknown>, v, owner, op, conflicts, key)
      continue
    }
    // Symmetrically, a scalar landing on top of a block discards every leaf beneath it, so the
    // owners of those leaves are the parties to the conflict.
    const prior = ownersAt(owner, key).filter((o) => o !== op)
    if (prior.length > 0) note(conflicts, key, prior, op)
    forgetSubtree(owner, key)
    target[k] = Array.isArray(v) ? [...v] : v
    owner.set(key, op)
  }
}

/**
 * Folds what the ops contributed into one request input. Tools are a union clipped to the snapshot,
 * so an op naming a tool that is not registered contributes nothing rather than a name the model
 * would be offered and could not call.
 */
export function mergeContributions(contribs: Contribution[], snapshot: RegistrySnapshot): Merged {
  const tools = new Set<string>()
  for (const c of contribs) for (const t of c.tools ?? []) if (snapshot.byName.has(t)) tools.add(t)
  const sections = contribs
    .flatMap((c) => (c.promptSections ?? []).map((s, i) => ({ s, op: c.op, i })))
    .sort((a, b) => a.s.order - b.s.order || a.op.localeCompare(b.op) || a.i - b.i)
    .map((x) => x.s)
  const runtimeContext: Record<string, unknown> = {}
  const owner = new Map<string, string>()
  const conflicts = new Map<string, Set<string>>()
  for (const c of contribs)
    if (c.runtimeContext) deepMerge(runtimeContext, c.runtimeContext, owner, c.op, conflicts)
  return {
    tools: [...tools].sort(),
    sections,
    runtimeContext,
    conflicts: [...conflicts].map(([key, ops]) => ({ key, ops: [...ops] })),
  }
}

/**
 * The prompt-visible half of the harness register. `skill` and `subagent` entries are deliberately
 * absent: they take effect through the resource library and the subagent spec, and pasting them
 * into the prompt would both duplicate them and grow the prefix every session.
 */
export function harnessSections(entries: Iterable<HarnessEntry>): PromptSection[] {
  const chosen = new Map<string, HarnessEntry>()
  for (const e of entries) {
    if (e.kind !== 'prompt' && e.kind !== 'memory') continue
    const k = `${e.kind}/${e.id}`
    const cur = chosen.get(k)
    if (!cur || (cur.scope === 'global' && e.scope === 'local')) chosen.set(k, e)
  }
  const out: PromptSection[] = []
  for (const [kind, order] of [
    ['prompt', 180],
    ['memory', 181],
  ] as const) {
    const items = [...chosen.values()].filter((e) => e.kind === kind).sort((a, b) => a.id.localeCompare(b.id))
    if (items.length)
      out.push({
        id: `harness:${kind}`,
        order,
        text: items.map((e) => `- ${e.title}: ${e.content}`).join('\n'),
        source: 'harness',
      })
  }
  return out
}
