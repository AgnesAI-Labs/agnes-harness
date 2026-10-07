import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type SandboxCapabilities,
  type SandboxPlatform,
  type SandboxProvider,
  sandboxUnavailable,
} from '@agnes/extension-api'
import type { ExecAdapter } from './exec.js'

function platformOf(os: string): readonly SandboxPlatform[] {
  if (os === 'darwin' || os === 'linux' || os === 'win32') return Object.freeze([os])
  return Object.freeze([])
}

/**
 * The current host spawn path as a sandbox provider.
 * File and network confinement stay on the host sandbox seam. This provider does
 * not claim them: `network` is false and `fsWrite` is empty. A call that asks
 * for either is refused instead of run unconfined.
 */
export function createLocalSandboxProvider(
  exec: ExecAdapter,
  os: string,
  options: { ownProcesses?: boolean } = {},
): SandboxProvider {
  const platform = platformOf(os)
  const capabilities: SandboxCapabilities = Object.freeze({
    network: false,
    fsWrite: Object.freeze([]),
    platform,
    available: platform.length > 0,
    ...(platform.length > 0 ? {} : { unavailableReason: `unsupported platform ${os}` }),
  })
  return {
    id: LOCAL_SANDBOX_PROVIDER_ID,
    version: '0.0.0',
    capabilities,
    create() {
      return {
        id: LOCAL_SANDBOX_PROVIDER_ID,
        capabilities,
        async exec(request) {
          if (!capabilities.available)
            throw sandboxUnavailable(capabilities.unavailableReason ?? 'local sandbox is unavailable')
          if (request.network)
            throw sandboxUnavailable('the local sandbox provider does not grant network access')
          if (request.fsWrite !== undefined && request.fsWrite.length > 0)
            throw sandboxUnavailable(
              'the local sandbox provider does not enforce write scopes; the host seam does',
            )
          const result = await exec.run([...request.argv], {
            cwd: request.cwd,
            ...(request.env === undefined ? {} : { env: { ...request.env } }),
            ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.limits?.timeoutMs === undefined ? {} : { timeoutMs: request.limits.timeoutMs }),
            ...(request.limits?.maxOutputBytes === undefined
              ? {}
              : { maxOutputBytes: request.limits.maxOutputBytes }),
          })
          return {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timedOut: result.timedOut,
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          }
        },
        dispose() {
          return options.ownProcesses ? exec.killAll() : undefined
        },
      }
    },
  }
}
