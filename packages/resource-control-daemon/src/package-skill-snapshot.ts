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
  }> = []
  for (const installed of inventory.packages) {
    if (!installed.enabled || !installed.trusted || !installed.directory) continue
    const root = resolve(installed.directory)
    for (const contribution of installed.contributions) {
      if (contribution.kind !== 'skill') continue
      const file = resolve(root, contribution.path.slice(2))
      const rel = relative(root, file)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('attested package skill path escapes its package directory')
      const metadata = await stat(file)
      if (!metadata.isFile() || metadata.size > 256 * 1024)
        throw new Error('attested package skill is invalid or too large')
      skills.push({
        packageId: installed.id,
        contributionId: contribution.id,
        relativeLocation: contribution.path,
        source: await readFile(file, 'utf8'),
      })
      if (skills.length > 128) throw new Error('too many attested package skill contributions')
    }
  }
  const windows = process.platform === 'win32' // guards-allow-platform: select shared Windows persistence; retain POSIX.
  if (windows) {
    await windowsWritePrivateFile(
      target,
      Buffer.from(JSON.stringify({ version: 1, inventoryRevision: inventory.hash, skills })),
    )
    return
  }
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, inventoryRevision: inventory.hash, skills }), {
      mode: 0o600,
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Deployment configuration only; API requests cannot influence this capability ceiling. */
export function deploymentMcpPolicy(env: NodeJS.ProcessEnv): {
  localStartApprovals: boolean
  allowedExecutables: string[]
  allowLoopbackHttp: boolean
  localDaemon: boolean
} {
  const allowedExecutables = (env.AGNES_MCP_STDIO_ALLOWLIST ?? '')
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
    allowLoopbackHttp: env.AGNES_MCP_ALLOW_LOOPBACK_HTTP === '1',
    localDaemon: true,
  }
}
