import type { RefinementWorkspaceRefs, WorkspaceReference } from '@agnes/core'
import type { MemorySession } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
} from '@agnes/host-infrastructure/refinement-registry'

const MEMORY_REF = 'workspace-memory/'
/** Saved paragraphs listed for one plan at most; Core shows the planner no more than this either. */
const MAX_LISTED = 40

export type WorkspaceRefsDeps = {
  dataDir: string
  /** The open session's canonical workspace root and memory, or undefined when it is not open here. */
  session(at: { key: string; lane: string }): { workspaceRoot: string; memory?: MemorySession } | undefined
  clock(): number
}

/**
 * The paragraphs refinement saved to this workspace that are still in force at `now`: active in the
 * registry, before their review date, and not barred by a revocation. A registry file that cannot be
 * believed reads as empty, so nothing in it is ever listed or renewed.
 */
function inForce(registry: RefinementRegistry, now: number): RegistryParagraph[] {
  return registry
    .read()
    .paragraphs.filter((p) => p.state === 'active' && now < p.reviewAfter && !registry.revoked(p.source))
}

/**
 * The managed paragraphs of the stored memory index by id, or undefined when they cannot be read for
 * the agent: no memory, a provider without paragraph access, memory switched off, or a failed read.
 */
async function storedParagraphs(memory: MemorySession | undefined, sessionKey: string) {
  if (!memory || typeof memory.paragraphs !== 'function') return undefined
  try {
    if ((await memory.inspect()).settings.mode === 'off') return undefined
    const port = memory.paragraphs({ sessionKey, turn: 0 }, new AbortController().signal)
    const { paragraphs } = await port.list()
    return new Map(paragraphs.map((p) => [p.id, p.text]))
  } catch {
    return undefined
  }
}

/** A saved paragraph's text, written as its title line and then its content. */
function titled(text: string): { title: string; summary: string } {
  const [first = '', ...rest] = text.trim().split('\n')
  const title = first.trim()
  return { title, summary: rest.join('\n').trim() || title }
}

/**
 * The host side of confirming entries saved to the workspace. `list` gives a session's planner the
 * memory paragraphs refinement saved to its workspace that are in force and still in the memory file,
 * each at its content version: the hash of its stored text (`normalizedContentHash`), so an edit in
 * place is a new version. `renew` starts a new review period for one of them, through the registry
 * alone: the memory file is never written and no approval is asked. It renews nothing for a paragraph
 * that is removed, converted, revoked, past its review date, edited since it was listed, gone from the
 * file, or while the registry cannot be read; and nothing when the registry was written between its
 * checks and the renewal (compare-and-swap on the registry revision, under the registry's lock).
 * Entries are read only when a plan is made, so with refinement off nothing here runs.
 */
export function createWorkspaceRefs(deps: WorkspaceRefsDeps): RefinementWorkspaceRefs {
  const registryOf = (workspaceRoot: string) =>
    new RefinementRegistry(deps.dataDir, workspaceRoot, deps.clock)
  return Object.freeze<RefinementWorkspaceRefs>({
    async list(at) {
      const where = deps.session(at)
      if (!where) return []
      const live = inForce(registryOf(where.workspaceRoot), deps.clock())
      if (live.length === 0) return []
      const stored = await storedParagraphs(where.memory, at.key)
      if (!stored) return []
      const out: WorkspaceReference[] = []
      for (const p of live) {
        const text = stored.get(p.id)
        if (text === undefined) continue
        const { sessionKey, kind, entryId } = p.source
        out.push({
          ref: `${MEMORY_REF}${p.id}`,
          ...titled(text),
          version: normalizedContentHash(text),
          source: { sessionKey, kind, entryId },
        })
        if (out.length >= MAX_LISTED) break
      }
      return out
    },
    async renew(at, ref, version) {
      const where = deps.session(at)
      if (!where || !ref.startsWith(MEMORY_REF)) return false
      const id = ref.slice(MEMORY_REF.length)
      const registry = registryOf(where.workspaceRoot)
      // Every check is made on one snapshot, and the renewal is written only while the registry is
      // still at that snapshot's revision: any write in between (a merge, a revocation) refuses it.
      const snap = registry.read()
      const found = snap.paragraphs.find(
        (p) =>
          p.id === id && p.state === 'active' && deps.clock() < p.reviewAfter && !registry.revoked(p.source),
      )
      if (!found) return false
      // The version is the text as it is stored now: text edited since the planner saw it is not renewed.
      const text = (await storedParagraphs(where.memory, at.key))?.get(id)
      if (text === undefined || normalizedContentHash(text) !== version) return false
      try {
        registry.update((draft) => {
          const p = draft.paragraphs.find((q) => q.id === id) as RegistryParagraph
          p.reviewAfter = deps.clock() + REVIEW_AFTER_MS
        }, snap.revision)
        return true
      } catch {
        return false
      }
    },
  })
}
