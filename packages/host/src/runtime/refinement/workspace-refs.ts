import type { RefinementWorkspaceRefs, SavedEntry, WorkspaceReference } from '@agnes/core'
import type { MemorySession } from '@agnes/extension-api'
import {
  dependencyDeadline,
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
  type RegistrySkill,
} from '@agnes/host-infrastructure/refinement-registry'
import { sha256Hex } from '@agnes/protocol'
import { paragraphVisibility } from './paragraph-visibility.js'
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
 * The managed paragraphs of one layer by id, for the snapshot: `null` when that layer is not read for
 * the agent (no memory, no paragraph access, memory off, user memory not enabled). A failed read throws:
 * it must never pass for "nothing saved", which would withdraw what the model was given.
 */
async function layerParagraphs(
  memory: MemorySession | undefined,
  sessionKey: string,
  layer: 'workspace' | 'user',
  registry: RefinementRegistry,
  clock: () => number,
  futureExpiry?: (at: number) => void,
) {
  const open = layer === 'user' ? memory?.userParagraphs : memory?.paragraphs
  if (!memory || typeof open !== 'function') return null
  const settings = (await memory.inspect()).settings
  if (settings.mode === 'off' || (layer === 'user' && !settings.userEnabled)) return null
  const port = open.call(memory, { sessionKey, turn: 0 }, new AbortController().signal)
  const listed = await port.list()
  const paragraphs = listed.paragraphs.filter((p) => p.validity === 'valid' || p.validity === 'delivered')
  const visible = await paragraphVisibility(memory, layer, { ...listed, paragraphs }, registry, clock)
  const snapshot = futureExpiry && registry.read()
  const now = clock()
  const stored = new Map<
    string,
    { raw: string; text: string; refs: readonly string[]; nextExpiry?: number }
  >()
  for (const p of paragraphs) {
    const projection = visible(p)
    if (!projection) continue
    if (snapshot && futureExpiry)
      for (const id of projection.refs) {
        const deadline = dependencyDeadline(snapshot, [id])
        if (now < deadline) futureExpiry(deadline)
      }
    if (projection.nextExpiry !== undefined) futureExpiry?.(projection.nextExpiry)
    if (projection.visibleText)
      stored.set(p.id, {
        refs: projection.refs,
        raw: p.text,
        text: projection.visibleText,
        ...(projection.nextExpiry === undefined ? {} : { nextExpiry: projection.nextExpiry }),
      })
  }
  return { hash: listed.hash, paragraphs: stored }
}

/** A read failure lists nothing for confirmation, but propagates when building the delivery snapshot. */
async function storedParagraphs(...args: Parameters<typeof layerParagraphs>) {
  try {
    return await layerParagraphs(...args)
  } catch {
    return undefined
  }
}

/** Saved prompt and memory paragraphs in force, in full, as the snapshot gives them. */
function savedEntries(
  prefix: 'ws.' | 'user.',
  live: readonly RegistryParagraph[],
  stored: Awaited<ReturnType<typeof layerParagraphs>>,
): SavedEntry[] {
  if (!stored) return []
  const out: SavedEntry[] = []
  for (const p of live) {
    const kind = p.source.kind
    if (kind !== 'prompt' && kind !== 'memory') continue
    const paragraph = stored.paragraphs.get(p.id)
    if (!paragraph || SECRET_LIKE.test(paragraph.raw)) continue
    const { raw, text } = paragraph
    const version = sha256Hex(text)
    const { title, summary } = titled(text)
    const { sessionKey, entryId } = p.source
    out.push({
      ref: `${prefix}${p.id}`,
      kind,
      title,
      content: summary,
      version,
      savedAt: p.reviewAfter - REVIEW_AFTER_MS,
      untouched:
        text === raw &&
        (p.exactHash !== undefined
          ? version === p.exactHash
          : !!p.fileHash && stored.hash === p.fileHash && normalizedContentHash(raw) === p.contentHash),
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
 * each at its content version: the SHA-256 digest of its exact visible text, so an edit in
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
  // Core caches deliveries by revision. Crossing a file annotation's deadline invalidates that cache.
  const expiries = new WeakMap<MemorySession, { last: number; next: number }>()
  const expiryRevision = (memory: MemorySession | undefined) => {
    const range = memory && expiries.get(memory)
    if (!range) return 0
    return deps.clock() >= range.next ? range.next : range.last
  }
  const paragraphRefs = async (
    at: { key: string },
    memory: MemorySession | undefined,
    layer: 'workspace' | 'user',
    registry: RefinementRegistry | undefined,
  ) => {
    if (!registry) return []
    const live = inForce(registry, deps.clock())
    if (!live.length) return []
    const stored = await storedParagraphs(memory, at.key, layer, registry, deps.clock)
    const out: WorkspaceReference[] = []
    for (const p of live) {
      const paragraph = stored?.paragraphs.get(p.id)
      if (!paragraph) continue
      const { sessionKey, kind, entryId } = p.source
      out.push({
        ref: `${layer === 'user' ? USER_REF : MEMORY_REF}${p.id}`,
        ...titled(paragraph.text),
        version: sha256Hex(paragraph.text),
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
      const workspace = await paragraphRefs(at, where.memory, 'workspace', registry)
      const user = await paragraphRefs(at, where.memory, 'user', deps.userRegistry?.())
      return [...workspace, ...user, ...listSkills(registry, where.workspaceRoot, deps.clock())]
    },
    async entries(at) {
      const where = deps.session(at)
      if (!where) return []
      const now = deps.clock()
      const registry = registryOf(where.workspaceRoot)
      const live = inForce(registry, now)
      let next = Infinity
      const futureExpiry = (at: number) => {
        next = Math.min(next, at)
      }
      const workspace = live.length
        ? savedEntries(
            'ws.',
            live,
            await layerParagraphs(where.memory, at.key, 'workspace', registry, deps.clock, futureExpiry),
          )
        : []
      const userRegistry = deps.userRegistry?.()
      const userLive = userRegistry ? inForce(userRegistry, now) : []
      const user =
        userRegistry && userLive.length
          ? savedEntries(
              'user.',
              userLive,
              await layerParagraphs(where.memory, at.key, 'user', userRegistry, deps.clock, futureExpiry),
            )
          : []

      if (where.memory) expiries.set(where.memory, { last: expiryRevision(where.memory), next })
      return [...workspace, ...user]
    },
    revision(at) {
      const where = deps.session(at)
      if (!where) return ''
      const userRegistry = deps.userRegistry?.()
      const base = [
        registryView(registryOf(where.workspaceRoot), deps.clock).revision(),
        userRegistry ? registryView(userRegistry, deps.clock).revision() : '',
        expiryRevision(where.memory),
      ].join(':')
      if (where.memory && typeof where.memory.stateRevision !== 'function') return `uncached:${base}`
      return `${base}:${where.memory?.stateRevision?.() ?? ''}`
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
      const validity = registryView(registry, deps.clock)
      const beforeValidity = validity.revision()
      const reviewAfter = dependencyDeadline(snap, [id])
      if (deps.clock() >= reviewAfter) return false
      // Recheck the exact visible version the planner confirmed.
      const stored = await storedParagraphs(
        where.memory,
        at.key,
        user ? 'user' : 'workspace',
        registry,
        deps.clock,
      )
      const entry = stored?.paragraphs.get(id)
      if (!entry || sha256Hex(entry.text) !== version || validity.revision() !== beforeValidity) return false
      try {
        registry.renew(
          { paragraphId: id },
          {
            expectedRevision: snap.revision,
            before: Math.min(reviewAfter, entry.nextExpiry ?? Infinity),
            requireUnrevoked: true,
            dependencyIds: entry.refs,
          },
        )
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
      const skill = draft.skills.find((k) => k.name === name && k.state === 'active')
      const now = clock()
      if (!skill || now >= skill.reviewAfter) throw new Error('not-renewable')
      skill.reviewAfter = now + REVIEW_AFTER_MS
    }, snap.revision)
    return true
  } catch {
    return false
  }
}
