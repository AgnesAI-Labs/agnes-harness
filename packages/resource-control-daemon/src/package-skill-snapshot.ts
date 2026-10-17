import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createPackageManager } from '@agnes/package-manager'
import { validateResourceControlData } from '@agnes/protocol'
import { windowsWritePrivateFile } from '@agnes/system-node'

export async function writePackageSkillInventory(
  profile: Readonly<{ dataDir: string; name: string }>,
  profileDir: string,
  target: string,
  collectFiles?: (
    directory: string,
    source: string,
  ) => Promise<
    readonly Readonly<{
      relativePath: string
      sha256: string
      kind: 'text' | 'binary'
      mime: string
      content: string
    }>[]
  >,
): Promise<void> {
  const manager = createPackageManager({
    dataDir: profile.dataDir,
    agnesVersion: '0.0.0',
    // Inventory is profile-scoped. Package sources were already resolved and attested when written
    // to the lock, so an ambient daemon cwd is neither authority nor a valid fallback.
    cwd: profileDir,
  })
  const inventory = await manager.inventory(profileDir)
  const skills: Array<{
    packageId: string
    contributionId: string
    relativeLocation: string
    source: string
    directory?: string
    files?: Awaited<ReturnType<NonNullable<typeof collectFiles>>>
  }> = []
  // Separate from `skills`: older workers ignore failures instead of loading incomplete bodies.
  const failures: Array<{
    packageId: string
    contributionId: string
    relativeLocation: string
    source: string
    code: string
  }> = []
  let snapshotBytes = 1024
  for (const installed of inventory.packages) {
    if (!installed.enabled || !installed.trusted || !installed.directory) continue
    const root = resolve(installed.directory)
    for (const contribution of installed.contributions) {
      if (contribution.kind !== 'skill') continue
      const file = resolve(root, contribution.path.slice(2))
      const rel = relative(root, file)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('attested package skill path escapes its package directory')
      const identity = {
        packageId: installed.id,
        contributionId: contribution.id,
        relativeLocation: contribution.path,
      }
      let source = ''
      try {
        const metadata = await stat(file)
        if (!metadata.isFile() || metadata.size > 256 * 1024)
          throw new Error('attested package skill is invalid or too large')
        source = await readFile(file, 'utf8')
        if (Buffer.byteLength(source) > 256 * 1024) throw new Error('Skill document exceeds size limit')
        const skill = {
          ...identity,
          source,
          ...(collectFiles
            ? { directory: dirname(file), files: await collectFiles(dirname(file), source) }
            : {}),
        }
        snapshotBytes += Buffer.byteLength(JSON.stringify(skill)) + 1
        skills.push(skill)
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        const failure = {
          ...identity,
          source: Buffer.byteLength(source) <= 256 * 1024 ? source : '',
          code:
            typeof code === 'string' &&
            ['SKILL_ATTACHMENTS_LIMIT', 'SKILL_ATTACHMENTS_UNREADABLE', 'SKILL_DOCUMENT_INVALID'].includes(
              code,
            )
              ? code
              : 'SKILL_LOAD_FAILED',
        }
        snapshotBytes += Buffer.byteLength(JSON.stringify(failure)) + 1
        failures.push(failure)
      }
      if (snapshotBytes > 32 * 1024 * 1024) throw new Error('package Skill inventory exceeds snapshot budget')
      if (skills.length + failures.length > 128)
        throw new Error('too many attested package skill contributions')
    }
  }
  // Collection crosses async file reads. Re-attest before publishing so changed package bytes or
  // trust/enabled state cannot acquire the authority of the earlier inventory.
  if ((await manager.inventory(profileDir, { fresh: true })).hash !== inventory.hash)
    throw new Error('package Skill inventory changed during collection')
  const serialized = JSON.stringify({ version: 1, inventoryRevision: inventory.hash, skills, failures })
  // Includes JSON escaping and base64 expansion, not just decoded attachment sizes.
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
    throw new Error('package Skill inventory exceeds snapshot budget')
  const windows = process.platform === 'win32' // guards-allow-platform: select shared Windows persistence; retain POSIX.
  if (windows) {
    await windowsWritePrivateFile(target, Buffer.from(serialized))
    return
  }
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, serialized, {
      mode: 0o600,
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Deployment configuration only; API requests cannot influence this capability ceiling. */
export function deploymentMcpPolicy(
  env: NodeJS.ProcessEnv,
  profile = env.AGNES_PROFILE ?? 'local-dev',
): {
  localStartApprovals: boolean
  allowedExecutables: string[]
  allowLoopbackHttp: boolean
  localDaemon: boolean
} {
  const localDev = profile === 'local-dev' && env.AGNES_MCP_LOCAL_DEV_DEFAULTS !== '0'
  const allowedExecutables = (env.AGNES_MCP_STDIO_ALLOWLIST ?? (localDev ? 'node,npx,python,python3' : ''))
    .split(',')
    .filter(
      (value) =>
        validateResourceControlData('McpStdioTransport', { kind: 'stdio', executable: value, args: [] }).ok,
    )
  if (allowedExecutables.length !== new Set(allowedExecutables).size)
    throw new Error('deployment MCP allowlist contains duplicates')
  return {
    localStartApprovals: env.AGNES_MCP_STDIO_ALLOWLIST === undefined,
    allowedExecutables: allowedExecutables.sort(),
    allowLoopbackHttp:
      env.AGNES_MCP_ALLOW_LOOPBACK_HTTP === '1' ||
      (localDev && env.AGNES_MCP_ALLOW_LOOPBACK_HTTP === undefined),
    localDaemon: true,
  }
}
