import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  skillRoots as baseSkillRoots,
  type DiscoveredSkillCandidate,
  discoverPackageSkill,
  discoverSkillRoot,
  type SkillRootFailure,
  workspaceSkillKey,
} from '@agnes/base'
import { AGH_DIR, validateResourceControlData } from '@agnes/protocol'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '@agnes/resource-control-runtime'
import { readSkillCache, writeSkillCache } from './skill-lkg-storage.js'

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
  // A shared worker has no workspace of its own. Supplying no cwd deliberately omits the
  // workspace root instead of scanning whichever directory launched the worker process.
  const roots = baseSkillRoots({ workspaceRoot: cwd ?? agnesHomeDir, osHomeDir, agnesHomeDir }).filter(
    (root) => cwd !== undefined || root.rootKey !== 'workspace-agnes',
  )
  const scans = await Promise.all(roots.map((root) => discoverSkillRoot(fs, root)))
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
      if (lkgDirectory) await writeSkillLkg(lkgDirectory, scan.root, candidates, key)
      filesystem.push({ rootKey: scan.root, candidates })
      for (const entry of scan.skipped ?? []) {
        skippedResourceIds.push(entry.resourceId)
        console.warn(`agnes: Skill ${scan.root}:${entry.location} skipped (${entry.code})`)
      }
      rootStatuses.push({
        rootKey: scan.root,
        scope,
        state: candidates.length ? 'ready' : 'empty',
        ...(scan.skipped?.length ? { diagnostic: { code: 'entries-skipped' as const } } : {}),
        ...(key ? { workspaceId: key } : {}),
      })
    } else {
      const candidates = lkgDirectory ? await readSkillLkg(lkgDirectory, scan.root, key) : undefined
      if (candidates) filesystem.push({ rootKey: scan.root, candidates })
      rootStatuses.push({
        rootKey: scan.root,
        scope,
        state: candidates ? 'stale' : 'unavailable',
        // 失败时带上原因码（只含原因，不含路径/目录名）：页面因此能说清"为什么这个来源没有结果"，
        // 而不只是"刷新失败"。用户在 2026-09-15 遇到过 38 个技能集体消失却毫无线索。
        diagnostic: { code: scan.diagnostic.code },
        ...(key ? { workspaceId: key } : {}),
      })
    }
  }
  const failedRoots = scans.filter((scan) => !scan.ok).map((scan) => scan.root)
  if (!packageSnapshot || !existsSync(packageSnapshot))
    return {
      roots: filesystem,
      failedRoots,
      skippedResourceIds,
      rootStatuses: [
        ...rootStatuses,
        { rootKey: 'package' as const, scope: 'package' as const, state: 'empty' as const },
      ],
    }
  const raw = JSON.parse(await readFile(packageSnapshot, 'utf8')) as { version?: unknown; skills?: unknown }
  if (raw.version !== 1 || !Array.isArray(raw.skills) || raw.skills.length > 128)
    throw new Error('invalid package skill inventory snapshot')
  const packageCandidates = raw.skills.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid package skill inventory snapshot')
    const row = entry as Record<string, unknown>
    if (
      typeof row.packageId !== 'string' ||
      typeof row.contributionId !== 'string' ||
      typeof row.relativeLocation !== 'string' ||
      typeof row.source !== 'string'
    )
      throw new Error('invalid package skill inventory snapshot')
    const candidate = discoverPackageSkill({
      packageId: row.packageId,
      contributionId: row.contributionId,
      relativeLocation: row.relativeLocation,
      source: row.source,
    })
    if (!candidate) throw new Error('invalid attested package skill contribution')
    const { normalizedName: _normalizedName, ...hostCandidate } = candidate
    return hostCandidate
  })
  return {
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
