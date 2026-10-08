import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, lstat, mkdir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { McpServerConfig } from '@agnes/base'
import { type BackendProbeExec, detectBackend } from '@agnes/base/sandbox'
import { isOfficialMcpDefinition, readPackageSourceConfiguration } from '@agnes/package-manager'
import type { McpServerDefinitionInput } from '@agnes/protocol'

export type McpSandboxContext = Readonly<{
  workspace?: string
  profileDir?: string
  dataDir: string
  /** Actual installation home supplied by Host; required for confined stdio. */
  home?: string
  secretsDir?: string
  path?: string
  probeExec?: BackendProbeExec
}>
const exec = promisify(execFile)
const unavailable = () =>
  Object.assign(
    new Error(
      'E_MCP_SANDBOX_UNAVAILABLE: stdio MCP sandbox unavailable; select off-with-warning explicitly to approve unconfined execution',
    ),
    { code: 'E_MCP_SANDBOX_UNAVAILABLE' },
  )

// Unlike realpath alone, retain the target of a dangling protected symlink. Future creation at
// that target must remain protected too. The context is Host-authored, never a child environment.
async function protectedRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw unavailable()
  const seen = new Set<string>()
  const walk = async (path: string): Promise<string> => {
    const normalized = resolve(path)
    if (seen.has(normalized) || seen.size >= 40) throw unavailable()
    seen.add(normalized)
    const parts = normalized.split(sep).filter(Boolean)
    let current: string = sep
    for (let index = 0; index < parts.length; index++) {
      const next = join(current, parts[index] as string)
      const meta = await lstat(next).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw unavailable()
      })
      if (!meta) return resolve(current, ...parts.slice(index))
      if (meta.isSymbolicLink()) {
        const target = await readlink(next).catch(() => {
          throw unavailable()
        })
        return walk(resolve(dirname(next), target, ...parts.slice(index + 1)))
      }
      current = next
    }
    return current
  }
  return walk(path)
}

const below = (root: string, path: string): boolean => {
  const remainder = relative(root, path)
  return (
    remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
  )
}

async function hardDenyRoots(workspace: string, readPaths: string[], context: McpSandboxContext) {
  const roots = [
    join(workspace, '.agh', 'secrets'),
    join(workspace, '.agnes', 'secrets'),
    join(context.dataDir, 'secrets'),
    join(context.dataDir, 'daemon'),
    ...['secrets', 'auth', 'profiles', 'daemon'].map((leaf) => join(context.home as string, leaf)),
    ...(context.profileDir ? [context.profileDir] : []),
    ...(context.secretsDir ? [context.secretsDir] : []),
  ]
  const grants = await Promise.all(readPaths.map(async (raw) => ({ raw, real: await realpath(raw) })))
  const denied: string[] = []
  for (const path of roots) {
    let canonical = await protectedRoot(path)
    // A missing mountpoint below a read-only bind cannot be prepared inside bubblewrap. Reserve
    // empty protected directories before confinement; inability to reserve them fails closed.
    if (grants.some(({ real }) => below(real, dirname(canonical)))) {
      await mkdir(canonical, { recursive: true, mode: 0o700 }).catch(() => {
        throw unavailable()
      })
      canonical = await protectedRoot(path)
    }
    denied.push(canonical)
    // Separate bind aliases expose the same inode at different namespace names. Mask every
    // declared grant spelling, rather than masking only the canonical name.
    for (const { raw, real } of grants)
      if (below(real, canonical)) denied.push(join(raw, relative(real, canonical)))
  }
  const unique = [...new Set(denied)]
  // An empty read-only mask hides descendants too. A second mask beneath it would need to create
  // a mountpoint inside that read-only empty filesystem and would make a valid profile unusable.
  return unique.filter((path) => !unique.some((parent) => parent !== path && below(parent, path)))
}

/** Probe a harmless command through the same OS boundary that will own the MCP child. */
const probeExec: BackendProbeExec = async (argv, options) => {
  const command = argv[0]
  if (!command) throw unavailable()
  try {
    const result = await exec(command, argv.slice(1), {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      signal: options.signal,
      encoding: 'utf8',
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false, truncated: false }
  } catch {
    return { code: 1, stdout: '', stderr: '', timedOut: false, truncated: false }
  }
}

async function executablePath(executable: string, path: string): Promise<string> {
  if (isAbsolute(executable)) return realpath(executable)
  if (executable.includes('/') || executable.includes('\\')) throw unavailable()
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const file = join(directory, executable)
    try {
      await access(file, constants.X_OK)
      return await realpath(file)
    } catch {
      /* try next Host PATH entry */
    }
  }
  throw unavailable()
}

export function mcpSandboxProfile(
  definition: McpServerDefinitionInput,
  context?: McpSandboxContext,
): McpServerConfig['sandboxProfile'] {
  if (definition.transport.kind !== 'stdio') return undefined
  if ('sandboxProfile' in definition && definition.sandboxProfile) return definition.sandboxProfile
  return context?.profileDir &&
    isOfficialMcpDefinition(readPackageSourceConfiguration(context.profileDir), definition)
    ? 'off-with-warning'
    : 'strict'
}

/** No ambient HOME is inherited. Runtime files are read-only; only the server's data is writable. */
export async function sandboxMcpConfig(
  config: McpServerConfig,
  context: McpSandboxContext | undefined,
  signal: AbortSignal,
): Promise<McpServerConfig> {
  signal.throwIfAborted()
  if (config.transport !== 'stdio') return config
  if (config.sandboxProfile === 'off-with-warning') return config
  if (
    !context?.home ||
    !isAbsolute(context.home) ||
    !config.cmd?.[0] ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.id)
  )
    throw unavailable()
  const data = join(context.dataDir, 'mcp', config.id)
  await mkdir(data, { recursive: true, mode: 0o700 })
  const dataDir = await realpath(data)
  const declaredWorkspace = config.workspacePath ?? context.workspace
  if (declaredWorkspace && !isAbsolute(declaredWorkspace)) throw unavailable()
  const workspace = declaredWorkspace ? await realpath(declaredWorkspace) : dataDir
  const executable = await executablePath(config.cmd[0], context.path ?? '/usr/bin:/bin')
  const runtimePaths = [
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/System',
    '/Library/Apple/System/Library',
    '/private/var/select/sh',
    '/dev/null',
    '/dev/urandom',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/etc/nsswitch.conf',
    '/etc/gai.conf',
  ].filter(existsSync)
  const readPaths = [
    workspace,
    ...(declaredWorkspace ? [declaredWorkspace] : []),
    data,
    dataDir,
    executable,
    ...runtimePaths,
    ...(await Promise.all(runtimePaths.map((path) => realpath(path)))),
  ]
  // Node/Python entry files can be outside the workspace; data arguments never grant reads.
  const args = config.cmd.slice(1)
  const entry = args[0]
  if (
    ['node', 'python', 'python3'].includes(basename(executable)) &&
    entry &&
    isAbsolute(entry) &&
    /\.(?:[cm]?js|py)$/.test(entry)
  ) {
    const file = await realpath(entry)
    if (!(await stat(file)).isFile()) throw unavailable()
    readPaths.push(file)
    args[0] = file
  }
  const home = await realpath(homedir())
  if (workspace === '/' || home === workspace || home.startsWith(workspace + '/')) throw unavailable()
  const options = {
    cwd: workspace,
    readPaths,
    allowPaths: config.sandboxProfile === 'workspace-write' ? [dataDir, workspace] : [dataDir],
    denyPaths: await hardDenyRoots(workspace, readPaths, context),
    network: config.sandboxProfile === 'network' ? ('allow' as const) : ('deny' as const),
  }
  const backend = await detectBackend({
    level: 'L1',
    shell: 'posix',
    options,
    probeExec: context.probeExec ?? probeExec,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    signal,
  })
  signal.throwIfAborted()
  if (backend.name === 'none') throw unavailable()
  return {
    ...config,
    cwd: workspace,
    cmd: backend.confine([executable, ...args], options),
    baseEnv: { PATH: context.path ?? '/usr/bin:/bin', HOME: dataDir, TMPDIR: dataDir },
  }
}
