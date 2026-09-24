import { join, sep } from 'node:path'
import type { FsEntry, FsStat } from '@agnes/extension-api'
import {
  AGH_DIR,
  type SkillRootKey as ProtocolSkillRootKey,
  type SkillSourceIdentity as ProtocolSkillSourceIdentity,
  type SkillResolution,
} from '@agnes/protocol'
import { collectSkillFiles, type SkillFile, type SkillFileKind, skillRevision } from './assets.js'
import { normalizeSkillName, parseSkillDocument, skillSha256 } from './frontmatter.js'

export type { SkillFile, SkillFileKind }

export type SkillScope = ProtocolSkillSourceIdentity['scope']
export type SkillRootKey = ProtocolSkillRootKey
export type SkillRootDefinition = Readonly<{ scope: SkillScope; rootKey: SkillRootKey; priority: number }>
/** One directory of a root. `prefix` joins the entry name into its path-free canonical location. */
export type SkillRootDir = Readonly<{ path: string; prefix: string }>
export type SkillRoot = SkillRootDefinition &
  Readonly<{ path: string; workspaceKey?: string; dirs?: readonly SkillRootDir[] }>
export type SkillFs = Readonly<{
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  read(path: string): Promise<Uint8Array>
  realpath?(path: string): Promise<string>
}>

export const MAX_SKILL_ENTRIES_PER_ROOT = 128
export const MAX_SKILL_FILE_BYTES = 256 * 1024
export const MAX_SKILL_BODY_BYTES = 192 * 1024
export const MAX_SKILL_ROOT_BYTES = 2 * 1024 * 1024

/** The fixed source order is policy, not profile configuration or package-manager state. */
export const FIVE_SKILL_ROOTS: readonly [
  SkillRootDefinition,
  SkillRootDefinition,
  SkillRootDefinition,
  SkillRootDefinition,
  SkillRootDefinition,
] = Object.freeze([
  { scope: 'workspace', rootKey: 'workspace-agnes', priority: 500 },
  { scope: 'user', rootKey: 'user-agnes', priority: 400 },
  { scope: 'user', rootKey: 'user-agents', priority: 300 },
  { scope: 'user', rootKey: 'user-claude', priority: 200 },
  { scope: 'user', rootKey: 'user-codex', priority: 100 },
])

/** Digest of the catalog-canonical workspace path. Resource-control RPCs expose it as workspaceId, never the path. */
export function workspaceSkillKey(workspaceRoot: string): string {
  return skillSha256(workspaceRoot)
}

/**
 * Five roots, two different notions of "home". The `.agents`/`.claude`/`.codex` roots are other
 * tools' own conventions: they have no idea this package exists, so they must stay relative to the
 * real OS home no matter what this deployment has done with its own home directory. The one
 * Agnes-owned root among the five is the opposite: it has to track wherever the rest of the system's
 * state actually lives, which is not always the OS home. This package cannot import the resolver
 * that answers that question -- the package that owns it depends on this one, not the other way
 * around -- so the caller resolves it and hands the two homes in already split apart, rather than
 * this function guessing which of its four appended subdirectories the one parameter was for.
 */
export function skillRoots(paths: {
  workspaceRoot: string
  osHomeDir: string
  agnesHomeDir: string
}): readonly SkillRoot[] {
  const listed = [
    { ...FIVE_SKILL_ROOTS[0], path: join(paths.workspaceRoot, AGH_DIR, 'skills') },
    { ...FIVE_SKILL_ROOTS[1], path: join(paths.agnesHomeDir, 'skills') },
    { ...FIVE_SKILL_ROOTS[2], path: join(paths.osHomeDir, '.agents', 'skills') },
    { ...FIVE_SKILL_ROOTS[3], path: join(paths.osHomeDir, '.claude', 'skills') },
    { ...FIVE_SKILL_ROOTS[4], path: join(paths.osHomeDir, '.codex', 'skills') },
  ]
  const workspaceRoot = listed[0] as SkillRoot
  // Earlier directories win a same-name Skill. `.agh` keeps an empty prefix so existing ids hold.
  const dirs = Object.freeze([
    { path: workspaceRoot.path, prefix: '' },
    { path: join(paths.workspaceRoot, '.agents', 'skills'), prefix: '.agents/skills/' },
    { path: join(paths.workspaceRoot, '.claude', 'skills'), prefix: '.claude/skills/' },
  ])
  return Object.freeze([
    { ...workspaceRoot, workspaceKey: workspaceSkillKey(paths.workspaceRoot), dirs },
    listed[1] as SkillRoot,
    listed[2] as SkillRoot,
    listed[3] as SkillRoot,
    listed[4] as SkillRoot,
  ])
}

function boundToRoot(rootReal: string, targetReal: string): boolean {
  if (targetReal === rootReal) return true
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  return targetReal.startsWith(prefix)
}

export type SkillSourceIdentity = ProtocolSkillSourceIdentity
/** Host-private candidate data. It never crosses a protocol, actual-state, or resource-list boundary. */
export type SkillCandidate = Readonly<{
  resourceId: string
  name: string
  normalizedName: string
  description: string
  revision: string
  capabilityHash: string
  sourceIdentity: SkillSourceIdentity
  priority: number
  body: string
  workspaceId?: string
  files?: readonly SkillFile[]
  /** Host-private absolute base directory, told to the model so it can read files and run scripts. */
  directory?: string
}>
/**
 * Why a whole root scan was rejected. The code names a reason only — never a path, a directory name or
 * any candidate content — so it can cross the management DTO boundary. Kept in sync with
 * `SkillRootDiagnostic` in packages/protocol/schema/resource-control.json.
 */
export type SkillRootFailure =
  | 'root-unreadable'
  | 'root-unresolvable'
  | 'entry-limit'
  | 'root-bytes-limit'
  | 'workspace-key-missing'
  | 'entry-outside-root'
  | 'skill-file-unreadable'
  | 'skill-body-too-large'
  | 'invalid-frontmatter'

/** An entry that looked like a Skill but was not admitted. `location` is path-free and host-private. */
export type SkippedSkillEntry = Readonly<{ resourceId: string; code: SkillRootFailure; location: string }>
export type SkillRootScan =
  | Readonly<{
      ok: true
      root: SkillRootKey
      candidates: readonly SkillCandidate[]
      skipped?: readonly SkippedSkillEntry[]
    }>
  | Readonly<{ ok: false; root: SkillRootKey; diagnostic: { code: SkillRootFailure } }>
export type PackageSkillContribution = Readonly<{
  packageId: string
  contributionId: string
  relativeLocation: string
  source: string
}>

const decoder = new TextDecoder()
const failed = (root: SkillRootKey, code: SkillRootFailure): SkillRootScan =>
  Object.freeze({ ok: false, root, diagnostic: Object.freeze({ code }) })

function skillSourceId(input: {
  scope: SkillScope
  rootKey: SkillRootKey
  canonicalLocation: string
  workspaceKey?: string
}): string {
  const location =
    input.scope === 'workspace'
      ? `${input.workspaceKey}\u0000${input.canonicalLocation}`
      : input.canonicalLocation
  return skillSha256(`${input.scope}\u0000${input.rootKey}\u0000${location}`)
}

/** The resource id a root entry has, whether or not it is currently admitted. */
export function skillResourceIdAt(root: SkillRoot, canonicalLocation: string): string {
  const sourceId = skillSourceId({
    scope: root.scope,
    rootKey: root.rootKey,
    canonicalLocation,
    ...(root.workspaceKey ? { workspaceKey: root.workspaceKey } : {}),
  })
  return `skill/${root.scope}/${root.rootKey}/${sourceId}`
}

/** A rejected candidate carries the reason, so the root scan can report why it failed. */
type CandidateOutcome =
  | Readonly<{ ok: true; candidate: SkillCandidate }>
  | Readonly<{ ok: false; code: SkillRootFailure }>

function candidateFromDocument(input: {
  source: string
  scope: SkillScope
  rootKey: SkillRootKey
  canonicalLocation: string
  priority: number
  workspaceKey?: string
}): CandidateOutcome {
  if (Buffer.byteLength(input.source, 'utf8') > MAX_SKILL_FILE_BYTES)
    return { ok: false, code: 'skill-file-unreadable' }
  const parsed = parseSkillDocument(input.source)
  if (!parsed) return { ok: false, code: 'invalid-frontmatter' }
  if (Buffer.byteLength(parsed.body, 'utf8') > MAX_SKILL_BODY_BYTES)
    return { ok: false, code: 'skill-body-too-large' }
  if (input.scope === 'workspace') {
    if (!input.workspaceKey || !/^[a-f0-9]{64}$/.test(input.workspaceKey))
      return { ok: false, code: 'workspace-key-missing' }
  } else if (input.workspaceKey) return { ok: false, code: 'workspace-key-missing' }
  const sourceId = skillSourceId(input)
  const sourceIdentity: SkillSourceIdentity = Object.freeze({
    scope: input.scope,
    rootKey: input.rootKey,
    sourceId,
  })
  return {
    ok: true,
    candidate: Object.freeze({
      resourceId: `skill/${input.scope}/${input.rootKey}/${sourceId}`,
      name: parsed.frontmatter.name,
      normalizedName: normalizeSkillName(parsed.frontmatter.name),
      description: parsed.frontmatter.description,
      revision: skillSha256(input.source),
      capabilityHash: parsed.frontmatter.capabilityHash,
      sourceIdentity,
      priority: input.priority,
      body: parsed.body,
      ...(input.scope === 'workspace' && input.workspaceKey ? { workspaceId: input.workspaceKey } : {}),
    }),
  }
}

type EntryRead =
  | Readonly<{ kind: 'ignore' }>
  | Readonly<{ kind: 'skip'; code: SkillRootFailure }>
  | Readonly<{ kind: 'read'; source: string; size: number; skillDir?: string; skillReal?: string }>

const validEntryName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !name.startsWith('.') &&
  name !== 'node_modules'

async function readRootEntry(
  fs: SkillFs,
  root: SkillRoot,
  dirPath: string,
  dirReal: string | undefined,
  entry: FsEntry,
): Promise<EntryRead> {
  const path = join(dirPath, entry.name)
  let kind = entry.kind
  // A user root follows links wherever they point; a project root must not reach outside itself.
  const followsLinks = root.scope === 'user'
  if (kind === 'other') {
    let resolved: FsStat
    try {
      resolved = await fs.stat(path)
    } catch {
      return { kind: 'ignore' }
    }
    if (resolved.kind === 'dir') kind = 'dir'
    else if (resolved.kind === 'file' && entry.name.endsWith('.md')) kind = 'file'
    else return { kind: 'ignore' }
    if (!followsLinks) return { kind: 'skip', code: 'entry-outside-root' }
  }
  const skillDir = kind === 'dir' ? path : undefined
  if (kind === 'file' && !entry.name.endsWith('.md')) return { kind: 'ignore' }
  if (kind !== 'dir' && kind !== 'file') return { kind: 'ignore' }
  const documentPath = skillDir ? join(skillDir, 'SKILL.md') : path
  let stat: FsStat
  try {
    stat = await fs.stat(documentPath)
  } catch {
    // A directory without SKILL.md, or a file that cannot be read, is not a known Skill.
    return { kind: 'ignore' }
  }
  if (stat.kind !== 'file') return { kind: 'ignore' }
  // A single-file Skill is only recognised by its front matter, which an oversized file cannot show.
  if (!skillDir && stat.size > MAX_SKILL_FILE_BYTES) return { kind: 'ignore' }
  let skillReal: string | undefined
  if (fs.realpath && dirReal) {
    try {
      const fileReal = await fs.realpath(documentPath)
      if (skillDir) {
        skillReal = await fs.realpath(skillDir)
        if (!followsLinks && skillReal !== join(dirReal, entry.name))
          return { kind: 'skip', code: 'entry-outside-root' }
        if (!boundToRoot(skillReal, fileReal)) return { kind: 'skip', code: 'entry-outside-root' }
      } else if (!followsLinks && fileReal !== join(dirReal, entry.name))
        return { kind: 'skip', code: 'entry-outside-root' }
    } catch {
      return { kind: 'skip', code: 'entry-outside-root' }
    }
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SKILL_FILE_BYTES)
    return { kind: 'skip', code: 'skill-file-unreadable' }
  let source: string
  try {
    source = decoder.decode(await fs.read(documentPath))
  } catch {
    return { kind: 'skip', code: 'skill-file-unreadable' }
  }
  if (Buffer.byteLength(source, 'utf8') !== stat.size) return { kind: 'skip', code: 'skill-file-unreadable' }
  if (!skillDir && !source.startsWith('---')) return { kind: 'ignore' }
  return {
    kind: 'read',
    source,
    size: stat.size,
    ...(skillDir ? { skillDir } : {}),
    ...(skillReal ? { skillReal } : {}),
  }
}

/**
 * Scans every directory of a root. A problem with one entry skips that entry and is reported in
 * `skipped`; only a directory that cannot be listed or resolved fails the whole root, so callers
 * keep its last-known-good generation.
 */
export async function discoverSkillRoot(fs: SkillFs, root: SkillRoot): Promise<SkillRootScan> {
  if (root.scope === 'workspace' && !root.workspaceKey) return failed(root.rootKey, 'workspace-key-missing')
  const candidates: SkillCandidate[] = []
  const skipped: SkippedSkillEntry[] = []
  const admitted = new Map<string, { dir: number; single: boolean }>()
  let totalBytes = 0
  let seen = 0
  const dirs = root.dirs ?? [{ path: root.path, prefix: '' }]
  for (const [dirIndex, dir] of dirs.entries()) {
    let entries: FsEntry[]
    try {
      entries = await fs.list(dir.path)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') continue
      return failed(root.rootKey, 'root-unreadable')
    }
    let dirReal: string | undefined
    if (fs.realpath) {
      try {
        dirReal = await fs.realpath(dir.path)
      } catch {
        return failed(root.rootKey, 'root-unresolvable')
      }
    }
    // Directories come first so a Skill directory wins over a same-name single file.
    const ordered = [...entries]
      .filter((entry) => validEntryName(entry.name))
      .sort((a, b) => Number(a.kind !== 'dir') - Number(b.kind !== 'dir') || a.name.localeCompare(b.name))
    for (const entry of ordered) {
      const location = `${dir.prefix}${entry.name}`
      const skip = (code: SkillRootFailure) =>
        skipped.push(Object.freeze({ resourceId: skillResourceIdAt(root, location), code, location }))
      const read = await readRootEntry(fs, root, dir.path, dirReal, entry)
      if (read.kind === 'ignore') continue
      if (read.kind === 'skip') {
        skip(read.code)
        continue
      }
      seen += 1
      if (seen > MAX_SKILL_ENTRIES_PER_ROOT) {
        skip('entry-limit')
        continue
      }
      totalBytes += read.size
      if (totalBytes > MAX_SKILL_ROOT_BYTES) {
        skip('root-bytes-limit')
        continue
      }
      const outcome = candidateFromDocument({
        source: read.source,
        scope: root.scope,
        rootKey: root.rootKey,
        canonicalLocation: location,
        priority: root.priority,
        ...(root.workspaceKey ? { workspaceKey: root.workspaceKey } : {}),
      })
      if (!outcome.ok) {
        skip(outcome.code)
        continue
      }
      const single = read.skillDir === undefined
      const earlier = admitted.get(outcome.candidate.normalizedName)
      // An earlier directory, or a directory over a single file, shadows a same-name Skill.
      if (earlier && (earlier.dir !== dirIndex || single)) continue
      if (!earlier) admitted.set(outcome.candidate.normalizedName, { dir: dirIndex, single })
      const files = read.skillDir ? await collectSkillFiles(fs, read.skillDir, read.skillReal) : []
      candidates.push(
        Object.freeze({
          ...outcome.candidate,
          revision: skillRevision(read.source, files),
          ...(files.length ? { files } : {}),
          // A single-file Skill has no directory of its own: its parent is the whole root, and
          // naming that would open every sibling Skill to whoever reads this one.
          ...(read.skillDir ? { directory: read.skillReal ?? read.skillDir } : {}),
        }),
      )
    }
  }
  return Object.freeze({
    ok: true,
    root: root.rootKey,
    candidates: Object.freeze(candidates),
    ...(skipped.length ? { skipped: Object.freeze(skipped) } : {}),
  })
}

/** Finds the directory entry behind a resource id, using the same locations the scan assigns. */
export async function locateSkillEntry(
  fs: Pick<SkillFs, 'list'>,
  root: SkillRoot,
  resourceId: string,
): Promise<Readonly<{ dirPath: string; name: string; kind: FsEntry['kind'] }> | undefined> {
  for (const dir of root.dirs ?? [{ path: root.path, prefix: '' }]) {
    let entries: FsEntry[]
    try {
      entries = await fs.list(dir.path)
    } catch {
      continue
    }
    const entry = entries.find(
      (item) =>
        validEntryName(item.name) && skillResourceIdAt(root, `${dir.prefix}${item.name}`) === resourceId,
    )
    if (entry) return Object.freeze({ dirPath: dir.path, name: entry.name, kind: entry.kind })
  }
  return undefined
}

export type SkillSummary = Readonly<{
  resourceId: string
  name: string
  description: string
  revision: string
  sourceIdentity: SkillSourceIdentity
}>
export type ShadowedSkill = SkillResolution['shadowed'][number]
const summary = (candidate: SkillCandidate): SkillSummary =>
  Object.freeze({
    resourceId: candidate.resourceId,
    name: candidate.name,
    description: candidate.description,
    revision: candidate.revision,
    sourceIdentity: candidate.sourceIdentity,
  })

/** Creates a priority-50 package candidate from a PackageManager-attested static contribution. */
export function discoverPackageSkill(input: PackageSkillContribution): SkillCandidate | undefined {
  if (
    !input.packageId ||
    !input.contributionId ||
    !/^\.\/(?!\.{1,2}(?:\/|$))[^/\\\0:]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\\0:]+)*$/.test(input.relativeLocation)
  )
    return undefined
  const outcome = candidateFromDocument({
    source: input.source,
    scope: 'package',
    rootKey: 'package',
    canonicalLocation: `${input.packageId}\u0000${input.contributionId}\u0000${input.relativeLocation}`,
    priority: 50,
  })
  // Package contributions keep their existing contract: a rejected candidate drops instead of failing
  // a root, because the root here is the package snapshot rather than a filesystem directory.
  return outcome.ok ? outcome.candidate : undefined
}

/** Only this safe resolution shape is suitable for lists, actual reports, or the protocol. */
export function resolveSkillCandidates(candidates: readonly SkillCandidate[]): Readonly<{
  winners: readonly SkillSummary[]
  shadowed: readonly ShadowedSkill[]
}> {
  const groups = new Map<string, SkillCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.normalizedName) ?? []
    group.push(candidate)
    groups.set(candidate.normalizedName, group)
  }
  const winners: SkillSummary[] = []
  const shadowed: ShadowedSkill[] = []
  for (const group of [...groups.values()]) {
    group.sort(
      (a, b) => b.priority - a.priority || a.sourceIdentity.sourceId.localeCompare(b.sourceIdentity.sourceId),
    )
    const winner = group[0]
    if (!winner) continue
    winners.push(summary(winner))
    for (const candidate of group.slice(1))
      shadowed.push(
        Object.freeze({
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          sourceIdentity: candidate.sourceIdentity,
          reason: 'lower-priority',
        }),
      )
  }
  winners.sort((a, b) => a.name.localeCompare(b.name) || a.resourceId.localeCompare(b.resourceId))
  shadowed.sort((a, b) => a.resourceId.localeCompare(b.resourceId))
  return Object.freeze({ winners: Object.freeze(winners), shadowed: Object.freeze(shadowed) })
}
