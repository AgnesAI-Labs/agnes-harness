import {
  ensureLocalBackend as ensureSharedLocalBackend,
  type LocalBackend as SharedLocalBackend,
} from '../src/boot/backend.js'
import type { LaunchResources } from './resources.js'

export type LocalBackend = SharedLocalBackend

export type EnsureLocalBackendOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  home?: string
  profile?: string
  dataDir?: string
  workspace: string
  webOrigin: string
  webPort: number
  resources: LaunchResources
}

/**
 * Pass the Web launch context into the CLI-owned bootstrap. The adapter is intentionally tiny: the
 * shared bootstrap owns scope resolution, discovery, startup coordination, and SDK handshaking.
 * This module only gives Web the authenticated endpoint and a client-only close operation.
 */
export function ensureLocalBackend(options: EnsureLocalBackendOptions): Promise<LocalBackend> {
  return ensureSharedLocalBackend({
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.home ? { home: options.home } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    workspace: options.workspace,
    // This launcher must keep the built-in recovery page reachable when the package lock is damaged.
    allowPackageRecovery: true,
    // Local Web startup may need more than the CLI's 30-second daemon readiness default.
    readinessTimeoutMs: 120_000,
    webOrigin: options.webOrigin,
    localWeb: { addr: '127.0.0.1:0', origin: options.webOrigin },
    resources: options.resources,
  })
}
