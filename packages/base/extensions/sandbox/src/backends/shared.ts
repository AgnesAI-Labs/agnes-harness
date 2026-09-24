import { posix } from 'node:path'

export type ClosedNetworkConfineOptions = Readonly<{
  cwd: string
  allowPaths: readonly string[]
  denyPaths: readonly string[]
  /** A non-empty list is deliberately unsupported until a real host-filtering proxy exists. */
  networkAllow?: readonly string[]
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
export function validateAbsolutePaths(paths: readonly string[], kind: 'allow' | 'deny'): string[] {
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
    if (kind === 'allow' && (path === '/' || path === '/proc' || path.startsWith('/proc/')))
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

export function validateClosedNetworkOptions(options: ClosedNetworkConfineOptions): {
  cwd: string
  allowPaths: string[]
  denyPaths: string[]
} {
  requireClosedNetwork(options.networkAllow)
  const cwd = validateAbsolutePaths([options.cwd], 'deny')[0]
  if (!cwd) throw backendCompileFault('E_SANDBOX_BACKEND_POLICY', 'missing cwd')
  return {
    cwd,
    allowPaths: validateAbsolutePaths(options.allowPaths, 'allow'),
    denyPaths: validateAbsolutePaths(options.denyPaths, 'deny'),
  }
}
