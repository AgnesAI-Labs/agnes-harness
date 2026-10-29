import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  skillRoots as baseSkillRoots,
  type DiscoveredSkillCandidate,
  decodePackageSkillFiles,
  discoverPackageSkill,
  discoverSkillRoot,
  packageSkillLoadError,
  readContextConfig,
  type SkillRootFailure,
  skillResourceIdAt,
  workspaceSkillKey,
} from '@agnes/base'
import { AGH_DIR, type SkillScanObservation, validateResourceControlData } from '@agnes/protocol'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '@agnes/resource-control-runtime'
import { readSkillCache, writeSkillCache } from './skill-lkg-storage.js'
import { createSkillScanObservation } from './skill-scan-observation.js'

export { discoverSkillRoot, skillRoots } from '@agnes/base'

type SkillFileRecord = NonNullable<DiscoveredSkillCandidate['files']>[number]
type StoredSkillFile = Readonly<{
  relativePath: string
  sha256: string
  kind: 'text' | 'binary'
  mime: string
  content: string
}>

export function deploymentMcpPolicy(env: NodeJS.ProcessEnv): {
  localStartApprovals?: boolean
  allowedExecutables: string[]
  allowLoopbackHttp: boolean
  localDaemon: boolean
} {
  try {
    const raw = JSON.parse(env.AGNES_RESOURCE_MCP_POLICY ?? '{}') as Record<string, unknown>
    const allowed = Array.isArray(raw.allowedExecutables) ? raw.allowedExecutables : []
    if (
      !allowed.every(
        (value) =>
          validateResourceControlData('McpStdioTransport', { kind: 'stdio', executable: value, args: [] }).ok,
      )
    )
      throw new Error('invalid executable allowlist')
    if (
      (typeof raw.allowLoopbackHttp !== 'boolean' && raw.allowLoopbackHttp !== undefined) ||
      (typeof raw.localDaemon !== 'boolean' && raw.localDaemon !== undefined)
    )
      throw new Error('invalid HTTP policy')
    return {
      ...(raw.localStartApprovals === true ? { localStartApprovals: true } : {}),
      allowedExecutables: [...new Set(allowed)].sort(),
      allowLoopbackHttp: raw.allowLoopbackHttp === true,
      localDaemon: raw.localDaemon === true,
    }
  } catch {
    throw new Error('invalid deployment MCP policy')
  }
}
/** Strict Base discovery: bounds, frontmatter parsing and root failure semantics live in one place. */
const skillRootKeys = ['workspace-agnes', 'user-agnes', 'user-agents', 'user-claude', 'user-codex'] as const
type FilesystemSkillRoot = (typeof skillRootKeys)[number]
type SkillCandidate = Omit<DiscoveredSkillCandidate, 'normalizedName'>
const isFilesystemSkillRoot = (root: string): root is FilesystemSkillRoot =>
  skillRootKeys.includes(root as FilesystemSkillRoot)
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max
function validLkgCandidate(value: unknown, rootKey: FilesystemSkillRoot): value is SkillCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const identity = candidate.sourceIdentity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false
  const source = identity as Record<string, unknown>
  return (
    typeof candidate.resourceId === 'string' &&
    isBoundedText(candidate.name, MAX_NAME_LENGTH) &&
    isBoundedText(candidate.description, MAX_DESCRIPTION_LENGTH) &&
    typeof candidate.body === 'string' &&
    typeof candidate.priority === 'number' &&
    isDigest(candidate.revision) &&
    isDigest(candidate.capabilityHash) &&
    isDigest(source.sourceId) &&
    source.rootKey === rootKey &&
    (source.scope === 'workspace' || source.scope === 'user') &&
    (candidate.workspaceId === undefined || isDigest(candidate.workspaceId)) &&
    (candidate.files === undefined ||
      (Array.isArray(candidate.files) &&
        candidate.files.length <= 32 &&
        candidate.files.every((file) => validStoredFile(file))))
  )
}
function validStoredFile(value: unknown): value is StoredSkillFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Record<string, unknown>
  return (
    typeof file.relativePath === 'string' &&
    isDigest(file.sha256) &&
    (file.kind === 'text' || file.kind === 'binary') &&
    typeof file.mime === 'string' &&
    typeof file.content === 'string'
  )
}
function encodeFiles(files: readonly SkillFileRecord[] | undefined): StoredSkillFile[] | undefined {
  if (!files?.length) return undefined
  return files.map((file) => ({
    relativePath: file.relativePath,
    sha256: file.sha256,
    kind: file.kind,
    mime: file.mime,
    content: Buffer.from(file.bytes).toString('base64'),
  }))
}
function decodeFiles(files: unknown): SkillFileRecord[] | undefined {
  if (!Array.isArray(files) || !files.every((file) => validStoredFile(file))) return undefined
  return files.map((file) =>
    Object.freeze({
      relativePath: file.relativePath,
      sha256: file.sha256,
      kind: file.kind,
      mime: file.mime,
      bytes: new Uint8Array(Buffer.from(file.content, 'base64')),
    }),
  )
}
function lkgPath(directory: string, rootKey: FilesystemSkillRoot, workspaceKey?: string): string {
  if (rootKey === 'workspace-agnes') {
    if (!workspaceKey) throw new Error('workspace Skill LKG requires a workspace key')
    return join(directory, `workspace-agnes.${workspaceKey}.json`)
  }
  return join(directory, `${rootKey}.json`)
}
async function readSkillLkg(
  directory: string,
  rootKey: FilesystemSkillRoot,
  workspaceKey?: string,
): Promise<SkillCandidate[] | undefined> {
  try {
    const raw = JSON.parse(await readSkillCache(lkgPath(directory, rootKey, workspaceKey))) as {
      version?: unknown
      rootKey?: unknown
      workspaceKey?: unknown
      candidates?: unknown
    }
    if (
      raw.version !== 1 ||
      raw.rootKey !== rootKey ||
      (rootKey === 'workspace-agnes' && raw.workspaceKey !== workspaceKey) ||
      (rootKey !== 'workspace-agnes' && raw.workspaceKey !== undefined) ||
      !Array.isArray(raw.candidates) ||
      raw.candidates.length > 1_000 ||
      !raw.candidates.every((candidate) => validLkgCandidate(candidate, rootKey))
    )
      return undefined
    return (raw.candidates as SkillCandidate[]).map((candidate) => {
      const files = decodeFiles((candidate as { files?: unknown }).files)
      const { files: _stored, ...rest } = candidate as SkillCandidate & { files?: unknown }
      return files?.length ? { ...rest, files } : rest
    })
  } catch {
    return undefined
  }
}
async function writeSkillLkg(
  directory: string,
  rootKey: FilesystemSkillRoot,
  candidates: readonly SkillCandidate[],
  workspaceKey?: string,
): Promise<void> {
  await writeSkillCache(
    lkgPath(directory, rootKey, workspaceKey),
    JSON.stringify({
      version: 1,
      rootKey,
      ...(rootKey === 'workspace-agnes' ? { workspaceKey } : {}),
      candidates: candidates.map((candidate) => {
        const encoded = encodeFiles(candidate.files)
        // The LKG stays path-free; a restored Skill simply has no base directory note.
        const { files: _files, directory: _directory, ...rest } = candidate
        return encoded ? { ...rest, files: encoded } : rest
      }),
    }),
  )
}
export async function scanSkills(
  cwd?: string,
  packageSnapshot?: string,
  lkgDirectory?: string,
  osHomeDir = process.env.HOME ?? homedir(),
  // This package sits at the same architectural layer as @agnes/host and must not depend on it, so
  // it has no way to resolve a customised AGH_HOME on its own. The one production caller that can
  // see @agnes/host (worker-runtime's bootstrap path) resolves the real value and passes it through
  // WorkerResourceBootstrapInput; every other caller, including every test below, gets this same
  // OS-home-relative default the parameter always had. That default is only correct when AGH_HOME
  // is unset, which is the case it existed to cover before this parameter split in two.
  agnesHomeDir = join(osHomeDir, AGH_DIR),
  importUserSkills = process.env.AGNES_SKILLS_IMPORT_USER === '1',
  resourceIds?: readonly string[],
) {
  const fs = {
    async list(path: string) {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? ('dir' as const)
          : entry.isFile()
            ? ('file' as const)
            : ('other' as const),
      }))
    },
    async stat(path: string) {
      const entry = await stat(path)
      return {
        kind: entry.isFile()
          ? ('file' as const)
          : entry.isDirectory()
            ? ('dir' as const)
            : ('other' as const),
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      }
    },
    read: async (path: string) => new Uint8Array(await readFile(path)),
    realpath,
  }
  const workspaceKey = cwd ? workspaceSkillKey(cwd) : undefined
  const customRoots = readContextConfig(agnesHomeDir).customSkillRoots
  // A shared worker has no workspace of its own. Supplying no cwd deliberately omits the
  // workspace root instead of scanning whichever directory launched the worker process.
  const roots = baseSkillRoots({
    workspaceRoot: cwd ?? agnesHomeDir,
    osHomeDir,
    agnesHomeDir,
    importUserSkills,
    customRoots,
  }).filter((root) => cwd !== undefined || root.rootKey !== 'workspace-agnes')
  const selected = resourceIds && new Set(resourceIds)
  const scans = await Promise.all(
    roots
      .filter((root) => !selected || resourceIds?.some((id) => id.split('/')[2] === root.rootKey))
      .map((root) => discoverSkillRoot(fs, root, selected)),
  )
  const observation: { skillScanObservation?: SkillScanObservation } = selected
    ? {}
    : {
        skillScanObservation: createSkillScanObservation(
          customRoots,
          scans.flatMap((scan) => scan.directoryScans ?? []),
        ),
      }
  const filesystem: Array<{ rootKey: FilesystemSkillRoot; candidates: SkillCandidate[] }> = []
  const rootStatuses: Array<{
    rootKey: FilesystemSkillRoot | 'package'
    scope: 'workspace' | 'user' | 'package'
    state: 'ready' | 'empty' | 'stale' | 'unavailable'
    workspaceId?: string
    diagnostic?: { code: SkillRootFailure | 'entries-skipped' }
  }> = []
  const skippedResourceIds: string[] = []
  for (const scan of scans) {
    if (!isFilesystemSkillRoot(scan.root)) throw new Error('invalid filesystem Skill root')
    const key = scan.root === 'workspace-agnes' ? workspaceKey : undefined
    const scope = scan.root === 'workspace-agnes' ? ('workspace' as const) : ('user' as const)
    if (scan.ok) {
      const candidates = scan.candidates.map(({ normalizedName: _normalizedName, ...candidate }) => candidate)
      // Targeted observations cannot replace a complete root cache.
      if (lkgDirectory && !selected) await writeSkillLkg(lkgDirectory, scan.root, candidates, key)
      filesystem.push({ rootKey: scan.root, candidates })
      for (const entry of scan.skipped ?? []) {
        skippedResourceIds.push(entry.resourceId)
        console.warn(`agnes: Skill ${entry.resourceId} skipped (${entry.code})`)
      }
      rootStatuses.push({
        rootKey: scan.root,
        scope,
        state: candidates.length ? 'ready' : 'empty',
        ...(scan.skipped?.length ? { diagnostic: { code: 'entries-skipped' as const } } : {}),
        ...(key ? { workspaceId: key } : {}),
      })
    } else {
      const cached = lkgDirectory ? await readSkillLkg(lkgDirectory, scan.root, key) : undefined
      const candidates = selected ? cached?.filter((item) => selected.has(item.resourceId)) : cached
      if (candidates) filesystem.push({ rootKey: scan.root, candidates })
      rootStatuses.push({
        rootKey: scan.root,
        scope,
        state: candidates ? 'stale' : 'unavailable',
        // Include a reason code on failure (no paths/directory names), so the page explains why a source has no results
        // instead of only Refresh failed. On 2026-09-15, a user lost all 38 skills without any clue to the cause.
        diagnostic: { code: scan.diagnostic.code },
        ...(key ? { workspaceId: key } : {}),
      })
    }
  }
  const failedRoots = scans.filter((scan) => !scan.ok).map((scan) => scan.root)
  if (
    (selected && !resourceIds?.some((id) => id.startsWith('skill/package/'))) ||
    !packageSnapshot ||
    !existsSync(packageSnapshot)
  )
    return {
      ...observation,
      roots: filesystem,
      failedRoots,
      skippedResourceIds,
      rootStatuses: [
        ...rootStatuses,
        { rootKey: 'package' as const, scope: 'package' as const, state: 'empty' as const },
      ],
    }
  if ((await stat(packageSnapshot)).size > 32 * 1024 * 1024)
    throw new Error('package Skill inventory exceeds snapshot budget')
  const snapshotBytes = await readFile(packageSnapshot)
  if (snapshotBytes.byteLength > 32 * 1024 * 1024)
    throw new Error('package Skill inventory exceeds snapshot budget')
  const raw = JSON.parse(snapshotBytes.toString('utf8')) as {
    version?: unknown
    skills?: unknown
    failures?: unknown
  }
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.skills) ||
    (raw.failures !== undefined && !Array.isArray(raw.failures)) ||
    raw.skills.length + (Array.isArray(raw.failures) ? raw.failures.length : 0) > 128
  )
    throw new Error('invalid package skill inventory snapshot')
  const entries = [
    ...raw.skills.map((entry) => ({ entry, failed: false })),
    ...(Array.isArray(raw.failures) ? raw.failures.map((entry) => ({ entry, failed: true })) : []),
  ]
  const selectedEntries = entries.filter(({ entry }) => {
    if (!selected) return true
    if (!entry || typeof entry !== 'object') throw new Error('invalid package skill inventory snapshot')
    const row = entry as Record<string, unknown>
    if (
      typeof row.packageId !== 'string' ||
      typeof row.contributionId !== 'string' ||
      typeof row.relativeLocation !== 'string'
    )
      throw new Error('invalid package skill inventory identity')
    return selected.has(
      skillResourceIdAt(
        { scope: 'package', rootKey: 'package', priority: 50, path: '' },
        `${row.packageId}\u0000${row.contributionId}\u0000${row.relativeLocation}`,
      ),
    )
  })
  const packageCandidates = selectedEntries.map(({ entry, failed }) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid package skill inventory snapshot')
    const row = entry as Record<string, unknown>
    if (
      typeof row.packageId !== 'string' ||
      typeof row.contributionId !== 'string' ||
      typeof row.relativeLocation !== 'string'
    )
      throw new Error('invalid package skill inventory snapshot')
    const identity = {
      packageId: row.packageId,
      contributionId: row.contributionId,
      relativeLocation: row.relativeLocation,
    }
    // Validate identity independently. A corrupt envelope must not acquire package authority.
    const fallback = discoverPackageSkill({
      ...identity,
      source: `---\nname: ${JSON.stringify(row.contributionId.slice(0, MAX_NAME_LENGTH))}\ndescription: Skill failed to load.\n---\nUnavailable.`,
    })
    if (!fallback) throw new Error('invalid package skill inventory identity')
    let document: ReturnType<typeof discoverPackageSkill>
    try {
      document =
        typeof row.source === 'string' && Buffer.byteLength(row.source) <= 256 * 1024
          ? discoverPackageSkill({ ...identity, source: row.source })
          : undefined
      if (failed) throw Object.assign(new Error('Skill load failed'), { code: row.code })
      if (!document)
        throw Object.assign(new Error('invalid Skill document'), { code: 'SKILL_DOCUMENT_INVALID' })
      if (
        row.directory !== undefined &&
        (typeof row.directory !== 'string' || !isAbsolute(row.directory) || row.directory.includes('\0'))
      )
        throw Object.assign(new Error('invalid Skill directory'), { code: 'SKILL_LOAD_FAILED' })
      let files: ReturnType<typeof decodePackageSkillFiles>
      try {
        files = decodePackageSkillFiles(row.files)
      } catch {
        throw Object.assign(new Error('invalid Skill attachments'), {
          code: 'SKILL_ATTACHMENTS_UNREADABLE',
        })
      }
      document = discoverPackageSkill({
        ...identity,
        source: row.source as string,
        ...(files ? { files } : {}),
        ...(typeof row.directory === 'string' ? { directory: row.directory } : {}),
      })
      if (!document)
        throw Object.assign(new Error('invalid Skill document'), { code: 'SKILL_DOCUMENT_INVALID' })
      const { normalizedName: _normalizedName, ...candidate } = document
      return candidate
    } catch (error) {
      const loadError = packageSkillLoadError((error as { code?: unknown })?.code)
      const { normalizedName: _normalizedName, ...candidate } = document ?? fallback
      console.warn(`agnes: Skill ${candidate.resourceId} unavailable (${loadError.code})`)
      return { ...candidate, body: '', loadError }
    }
  })
  return {
    ...observation,
    roots: packageCandidates.length
      ? [...filesystem, { rootKey: 'package' as const, candidates: packageCandidates }]
      : filesystem,
    failedRoots,
    skippedResourceIds,
    rootStatuses: [
      ...rootStatuses,
      {
        rootKey: 'package' as const,
        scope: 'package' as const,
        state: packageCandidates.length ? ('ready' as const) : ('empty' as const),
      },
    ],
  }
}
