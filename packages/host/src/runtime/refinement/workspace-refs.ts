import type { RefinementWorkspaceRefs, SavedEntry, WorkspaceReference } from '@agnes/core'
import type { MemorySession } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
  type RegistrySkill,
} from '@agnes/host-infrastructure/refinement-registry'
import { registryView } from './registry-view.js'
import { SECRET_LIKE } from './save-rules.js'
import { workspaceSkillText } from './skill-drafts.js'

const MEMORY_REF = 'workspace-memory/'
const USER_REF = 'user-memory/'
const SKILL_REF = 'workspace-skill/'
/** The longest title or summary of a saved skill shown to the planner: its catalogue line's limit. */
const SKILL_LINE_MAX = 200
/** Saved paragraphs listed for one plan at most; Core shows the planner no more than this either. */
const MAX_LISTED = 40

export type WorkspaceRefsDeps = {
  dataDir: string
  /** The open session's canonical workspace root and memory, or undefined when it is not open here. */
  session(at: { key: string; lane: string }): { workspaceRoot: string; memory?: MemorySession } | undefined
  clock(): number
  /** The registry of sections saved to user memory; absent: none are delivered. */
  userRegistry?: () => RefinementRegistry
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

/**
 * The managed paragraphs of one layer by id, for the snapshot: `null` when that layer is not read for
 * the agent (no memory, no paragraph access, memory off, user memory not enabled). A failed read throws:
 * it must never pass for "nothing saved", which would withdraw what the model was given.
 */
async function layerParagraphs(
  memory: MemorySession | undefined,
  sessionKey: string,
  layer: 'workspace' | 'user',
): Promise<ReadonlyMap<string, string> | null> {
  const open = layer === 'user' ? memory?.userParagraphs : memory?.paragraphs
  if (!memory || typeof open !== 'function') return null
  const settings = (await memory.inspect()).settings
  if (settings.mode === 'off' || (layer === 'user' && !settings.userEnabled)) return null
  const port = open.call(memory, { sessionKey, turn: 0 }, new AbortController().signal)
  const { paragraphs } = await port.list()
  return new Map(paragraphs.map((p) => [p.id, p.text]))
}

/** `layerParagraphs` for the planner's confirmation list, where a failed read lists nothing. */
async function storedSections(memory: MemorySession | undefined, sessionKey: string) {
  try {
    return (await layerParagraphs(memory, sessionKey, 'user')) ?? undefined
  } catch {
    return undefined
  }
}

/** Saved prompt and memory paragraphs in force, in full, as the snapshot gives them. */
function savedEntries(
  prefix: 'ws.' | 'user.',
  live: readonly RegistryParagraph[],
  stored: ReadonlyMap<string, string> | null,
): SavedEntry[] {
  if (!stored) return []
  const out: SavedEntry[] = []
  for (const p of live) {
    const kind = p.source.kind
    if (kind !== 'prompt' && kind !== 'memory') continue
    const text = stored.get(p.id)
    // A paragraph a person has since turned into something that looks like a secret is not delivered.
    if (text === undefined || SECRET_LIKE.test(text)) continue
    const { title, summary } = titled(text)
    const { sessionKey, entryId } = p.source
    out.push({
      ref: `${prefix}${p.id}`,
      kind,
      title,
      content: summary,
      version: normalizedContentHash(text),
      savedAt: p.reviewAfter - REVIEW_AFTER_MS,
      untouched: normalizedContentHash(text) === p.contentHash,
      source: { sessionKey, kind, entryId },
    })
  }
  return out
}

/**
 * The saved skills in force at `now`: active (switched on) and before their review date. An uninstalled
 * skill is never here. Revocations bar saves, not this list: after the user rolls a skill back, the
 * version kept is still a skill a plan may confirm and renew.
 */
function skillsInForce(registry: RefinementRegistry, now: number): RegistrySkill[] {
  return registry.read().skills.filter((k) => k.state === 'active' && now < k.reviewAfter)
}

const clipLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= SKILL_LINE_MAX ? line : line.slice(0, SKILL_LINE_MAX)
}

/**
 * A saved skill's title and summary, from its `SKILL.md` as it is installed now: the front matter's
 * description and the first line of the instructions, each at most `SKILL_LINE_MAX` characters.
 */
function skillLines(text: string): { title: string; summary: string } | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text)
  if (!match) return undefined
  const raw = /^description:[ \t]*(.*)$/mu.exec(match[1] ?? '')?.[1]?.trim()
  if (!raw) return undefined
  let description = raw
  if (raw.startsWith('"'))
    try {
      description = String(JSON.parse(raw))
    } catch {
      return undefined
    }
  const title = clipLine(description)
  const first = (match[2] ?? '').split('\n').find((line) => line.trim()) ?? ''
  return title ? { title, summary: clipLine(first) || title } : undefined
}

/** A saved skill's installed `SKILL.md`, read without following links; undefined when it cannot be. */
const installedText = (workspaceRoot: string, name: string): string | undefined => {
  const found = workspaceSkillText(workspaceRoot, name)
  return typeof found?.text === 'string' ? found.text : undefined
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
 * Skills refinement installed in the workspace are listed and renewed the same way (`workspace-skill/
 * <name>`): switched on and before their review date, at the hash of their `SKILL.md` as it is
 * installed now, titled by its description. Entries are read only when a plan is made, so with
 * refinement off nothing here runs.
 */
export function createWorkspaceRefs(deps: WorkspaceRefsDeps): RefinementWorkspaceRefs {
  const registryOf = (workspaceRoot: string) =>
    new RefinementRegistry(deps.dataDir, workspaceRoot, deps.clock)
  /** Sections saved to user memory in force, for a plan to confirm (`user-memory/<id>`). */
  const userRefs = async (at: { key: string }, memory: MemorySession | undefined) => {
    const registry = deps.userRegistry?.()
    const live = registry ? inForce(registry, deps.clock()) : []
    if (live.length === 0) return []
    const stored = await storedSections(memory, at.key)
    if (!stored) return []
    const out: WorkspaceReference[] = []
    for (const p of live) {
      const text = stored.get(p.id)
      if (text === undefined) continue
      const { sessionKey, kind, entryId } = p.source
      out.push({
        ref: `${USER_REF}${p.id}`,
        ...titled(text),
        version: normalizedContentHash(text),
        source: { sessionKey, kind, entryId },
      })
      if (out.length >= MAX_LISTED) break
    }
    return out
  }
  return Object.freeze<RefinementWorkspaceRefs>({
    async list(at) {
      const where = deps.session(at)
      if (!where) return []
      const registry = registryOf(where.workspaceRoot)
      const skills = listSkills(registry, where.workspaceRoot, deps.clock())
      const user = await userRefs(at, where.memory)
      const live = inForce(registry, deps.clock())
      if (live.length === 0) return [...user, ...skills]
      const stored = await storedParagraphs(where.memory, at.key)
      if (!stored) return [...user, ...skills]
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
      return [...out, ...user, ...skills]
    },
    async entries(at) {
      const where = deps.session(at)
      if (!where) return []
      const now = deps.clock()
      const live = inForce(registryOf(where.workspaceRoot), now)
      const workspace = live.length
        ? savedEntries('ws.', live, await layerParagraphs(where.memory, at.key, 'workspace'))
        : []
      const userRegistry = deps.userRegistry?.()
      const userLive = userRegistry ? inForce(userRegistry, now) : []
      const user = userLive.length
        ? savedEntries('user.', userLive, await layerParagraphs(where.memory, at.key, 'user'))
        : []
      return [...workspace, ...user]
    },
    revision(at) {
      const where = deps.session(at)
      if (!where) return ''
      const userRegistry = deps.userRegistry?.()
      return [
        registryView(registryOf(where.workspaceRoot), deps.clock).revision(),
        userRegistry ? registryView(userRegistry, deps.clock).revision() : '',
      ].join(':')
    },
    async renew(at, ref, version) {
      const where = deps.session(at)
      if (where && ref.startsWith(SKILL_REF))
        return renewSkill(registryOf(where.workspaceRoot), where.workspaceRoot, ref, version, deps.clock)
      const user = ref.startsWith(USER_REF)
      if (!where || !(user || ref.startsWith(MEMORY_REF))) return false
      const id = ref.slice(user ? USER_REF.length : MEMORY_REF.length)
      const registry = user ? deps.userRegistry?.() : registryOf(where.workspaceRoot)
      if (!registry) return false
      // Every check is made on one snapshot, and the renewal is written only while the registry is
      // still at that snapshot's revision: any write in between (a merge, a revocation) refuses it.
      const snap = registry.read()
      const found = snap.paragraphs.find(
        (p) =>
          p.id === id && p.state === 'active' && deps.clock() < p.reviewAfter && !registry.revoked(p.source),
      )
      if (!found) return false
      // The version is the text as it is stored now: text edited since the planner saw it is not renewed.
      const text = (await (user ? storedSections : storedParagraphs)(where.memory, at.key))?.get(id)
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

/** The saved skills in force, each at the hash of its installed `SKILL.md`; none past `MAX_LISTED`. */
function listSkills(registry: RefinementRegistry, workspaceRoot: string, now: number): WorkspaceReference[] {
  const out: WorkspaceReference[] = []
  for (const skill of skillsInForce(registry, now)) {
    const text = installedText(workspaceRoot, skill.name)
    const lines = text === undefined ? undefined : skillLines(text)
    if (text === undefined || !lines) continue
    const { sessionKey, kind, entryId } = skill.source
    out.push({
      ref: `${SKILL_REF}${skill.name}`,
      ...lines,
      version: normalizedContentHash(text),
      source: { sessionKey, kind, entryId },
    })
    if (out.length >= MAX_LISTED) break
  }
  return out
}

/**
 * A new review period for a saved skill a plan confirmed: only while it is switched on, before its
 * review date (a rollback by the user does not stop it), and its `SKILL.md` still hashes to the version the planner saw; written on
 * the registry snapshot the checks were made on. The skill itself is never touched.
 */
function renewSkill(
  registry: RefinementRegistry,
  workspaceRoot: string,
  ref: string,
  version: string,
  clock: () => number,
): boolean {
  const name = ref.slice(SKILL_REF.length)
  const snap = registry.read()
  const found = snap.skills.find((k) => k.name === name && k.state === 'active' && clock() < k.reviewAfter)
  if (!found) return false
  const text = installedText(workspaceRoot, name)
  if (text === undefined || normalizedContentHash(text) !== version) return false
  try {
    registry.update((draft) => {
      const skill = draft.skills.find((k) => k.name === name && k.state === 'active') as RegistrySkill
      skill.reviewAfter = clock() + REVIEW_AFTER_MS
    }, snap.revision)
    return true
  } catch {
    return false
  }
}
