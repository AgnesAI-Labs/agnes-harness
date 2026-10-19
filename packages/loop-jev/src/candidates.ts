// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { LoopTurnView } from '@agnes/extension-api'
import { completeArgs } from './profile.js'
import {
  type Candidate,
  DEFAULT_ARGUMENTS,
  LLM_PARAMETERS,
  type ResolvedTool,
  type Workspace,
} from './types.js'
import { clip } from './util.js'
import { fileActivity, knownPaths } from './workspace.js'

/*
 * Target candidates: complete calls built from the paths earlier results showed, newest first, and
 * the paths the user's message of this turn named (see mentions.ts), which come first and say so in
 * their label. The goal is otherwise never parsed or used to rank, and no argument other than the
 * target path varies.
 */

export const CANDIDATE_CAP = 20
export const CHANGED_LABEL = ' [changed since last read; fresh read preferred]'
export const READ_LABEL =
  ' [read this turn; coverage may be partial or evicted; check available range and freshness before reusing evidence]'

export const MENTIONED_LABEL = ' [named in the request; not yet seen in any result]'

const LABEL_CHARS = 300
const SYNTHETIC_KEYS: ReadonlySet<string> = new Set([LLM_PARAMETERS, DEFAULT_ARGUMENTS])

/** Observed complete calls for one tool, newest reference first; [] for a tool without a reference kind. */
export function targetCandidates(tool: ResolvedTool, schema: unknown, ws: Workspace): Candidate[] {
  const { referenceKind: kind, targetParam, bindingDefaults } = tool
  if (kind === null || targetParam === null || bindingDefaults === null) return []
  const activity = kind === 'file' ? fileActivity(ws) : null
  const changed = new Set(activity?.changed_unread ?? [])
  const read = new Set(activity?.read_current ?? [])
  const candidates: Candidate[] = []
  const seen = knownPaths(ws, kind)
  const named = new Set(ws.mentioned.filter((ref) => ref.kind === kind).map((ref) => ref.value))
  // Named paths first: the unseen ones, then the seen ones the message names again; the rest follow newest first.
  const unseen = [...named].filter((key) => !seen.includes(key))
  const keys = [
    ...unseen,
    ...seen.filter((key) => named.has(key)),
    ...seen.filter((key) => !named.has(key)),
  ].slice(0, CANDIDATE_CAP)
  for (const key of keys) {
    if (SYNTHETIC_KEYS.has(key)) continue
    const args = { ...structuredClone(bindingDefaults), [targetParam]: key }
    if (!completeArgs(schema, args)) continue
    const origin = unseen.includes(key) ? ('mentioned' as const) : undefined
    const note = changed.has(key) ? CHANGED_LABEL : read.has(key) ? READ_LABEL : origin ? MENTIONED_LABEL : ''
    // A long path gives way to its freshness or origin label, which stays whole.
    const label = `${clip(key, LABEL_CHARS - note.length)}${note}`
    candidates.push({ key, kind, label, args, ...(origin ? { origin } : {}) })
  }
  return candidates
}

/** Candidates of every tool on the decision surface, keyed by tool name, schemas taken from the view. */
export function candidatesFor(
  tools: readonly ResolvedTool[],
  view: Pick<LoopTurnView, 'tools'>,
  ws: Workspace,
): Record<string, Candidate[]> {
  const entries: Array<[string, Candidate[]]> = []
  for (const tool of tools) {
    if (entries.some(([name]) => name === tool.name)) continue
    const schema = view.tools.find((item) => item.name === tool.name)?.parameters
    entries.push([tool.name, targetCandidates(tool, schema, ws)])
  }
  // fromEntries defines own properties, so a tool named like an Object.prototype key stays a key.
  return Object.fromEntries(entries)
}
