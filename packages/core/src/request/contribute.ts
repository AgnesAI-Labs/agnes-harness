import type { Conflict } from '@agnes/core-common/context-diagnostics'
import type { RegistrySnapshot } from '../registry/tools.js'

// Owned here: the author-facing package does not publish this name, and every core module that
// assembles a request reads it from this file.
export type PromptSection = {
  id: string
  order: number
  text: string
  source: string
  /** Omitted means stable-section. Live items become durable, latest-deduplicated tail notes. */
  delivery?: 'stable-section' | 'live-note'
}

export type Contribution = {
  op: string
  tools?: string[]
  promptSections?: PromptSection[]
  runtimeContext?: Record<string, unknown>
}
export type {
  Conflict,
  ContextBreakdownDiag,
  ContextSectionSummary,
} from '@agnes/core-common/context-diagnostics'
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
