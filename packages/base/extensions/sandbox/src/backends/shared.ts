import { posix } from 'node:path'

export type ClosedNetworkConfineOptions = Readonly<{
  cwd: string
  allowPaths: readonly string[]
  denyPaths: readonly string[]
  /** Existing regular files, masked as files rather than empty directories. */
  fileDenyPaths?: readonly string[]
  /** Empty closes the network; ['*'] opens it; host-filtered network enforcement is not implemented. */
  networkAllow?: readonly string[]
  readPaths?: readonly string[]
  network?: 'deny' | 'allow'
  loopbackServe?: boolean
  /** Host-selected full access retains an explicit private-store deny floor. */
  fullAccess?: boolean
}>

export type SandboxBackendCompileCode =
  | 'E_SANDBOX_BACKEND_POLICY'
  | 'E_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED'
  | 'E_SANDBOX_HOST_ENFORCEMENT_REQUIRED'

export function backendCompileFault(
  code: SandboxBackendCompileCode,
  reason: string,
): Error & { code: SandboxBackendCompileCode } {
  return Object.assign(new Error(`${code}: ${reason}`), { code })
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

/** Validate an exec-file argv without treating any element as shell source. */
export function validateArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0].length === 0)
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'missing executable')
  if (argv.some((argument) => typeof argument !== 'string' || argument.includes('\0')))
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'invalid argv')
  return [...argv]
}

/**
 * These compiler leaves consume host-canonical POSIX paths. They cannot resolve symlinks, so a
 * caller must do that before invoking them. Reject lexical aliases here instead of silently
 * compiling a policy for a different path identity.
 */
export function validateAbsolutePaths(
  paths: readonly string[],
  kind: 'allow' | 'deny',
  fullAccess = false,
): string[] {
  if (!Array.isArray(paths)) throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'invalid path list')
  const unique = new Set<string>()
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      (path.length > 1 && path.endsWith('/')) ||
      hasControl(path)
    )
      throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'invalid canonical path')
    if (kind === 'allow' && ((path === '/' && !fullAccess) || path === '/proc' || path.startsWith('/proc/')))
      throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'unsafe writable path')
    if (kind === 'allow' && (path === '/dev' || path.startsWith('/dev/')))
      throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'unsafe writable path')
    if (kind === 'allow' && (path === '/sys' || path.startsWith('/sys/')))
      throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'unsafe writable path')
    unique.add(path)
  }
  return [...unique]
}

export function requireClosedNetwork(networkAllow: readonly string[] | undefined): void {
  if (networkAllow === undefined) return
  if (!Array.isArray(networkAllow) || networkAllow.some((host) => typeof host !== 'string'))
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'invalid network allowlist')
  if (networkAllow.length > 0)
    throw backendCompileFault(
      'E_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED',
      'host-filtered network enforcement is not implemented',
    )
}

/** The existing wildcard grants unrestricted outbound access; named-host filtering stays refused. */
export function requireSupportedNetwork(networkAllow: readonly string[] | undefined): void {
  if (Array.isArray(networkAllow) && networkAllow.length === 1 && networkAllow[0] === '*') return
  requireClosedNetwork(networkAllow)
}

export function validateClosedNetworkOptions(options: ClosedNetworkConfineOptions): {
  cwd: string
  allowPaths: string[]
  denyPaths: string[]
  fileDenyPaths?: string[]
  readPaths?: string[]
  network?: 'deny' | 'allow'
  loopbackServe?: boolean
} {
  requireSupportedNetwork(options.networkAllow)
  if (options.loopbackServe !== undefined && typeof options.loopbackServe !== 'boolean')
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'invalid loopback service grant')
  const network = options.network ?? (options.networkAllow?.includes('*') ? 'allow' : undefined)
  if (options.loopbackServe && network === 'allow')
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'loopback service cannot grant outbound network')
  if (options.fullAccess && options.denyPaths.length === 0)
    throw backendCompileFault(
      'E_SANDBOX_BACKEND_POLICY',
      'full access requires an explicit private deny floor',
    )
  const cwd = validateAbsolutePaths([options.cwd], 'deny')[0]
  if (!cwd) throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'missing cwd')
  const denyPaths = validateAbsolutePaths(options.denyPaths, 'deny')
  const fileDenyPaths = validateAbsolutePaths(options.fileDenyPaths ?? [], 'deny')
  if (fileDenyPaths.some((path) => !denyPaths.includes(path)))
    throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'file mask must name a denied path')
  return {
    cwd,
    ...(options.loopbackServe ? { loopbackServe: true } : {}),
    ...(options.readPaths ? { readPaths: validateAbsolutePaths(options.readPaths, 'deny') } : {}),
    ...(network ? { network } : {}),
    allowPaths: validateAbsolutePaths(options.allowPaths, 'allow', options.fullAccess),
    denyPaths,
    ...(fileDenyPaths.length ? { fileDenyPaths } : {}),
  }
}
