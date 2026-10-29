import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type DaemonScope, prepareDaemonSocketPaths, resolveDaemonScope } from '@agnes/daemon'
import { agnesHome, dataDir, readConfigurationProfileInputs } from '@agnes/host'
import { BootError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import type { EnsureLocalBackendOptions } from './backend.js'

/** All automatic RPC commands can attach; local maintenance keeps full preparation. */
export function localPreparation(p: ParsedArgs): 'connect-first' | 'full' {
  return p.command === 'doctor' || p.standalone || p.ephemeral ? 'full' : 'connect-first'
}

/** Resolve only connection identity. An explicit dataDir makes scope resolution identity-only. */
export async function connectionScope(options: EnsureLocalBackendOptions): Promise<DaemonScope> {
  const home = options.home ?? agnesHome(options.env ?? process.env)
  const identity = await resolveDaemonScope({ ...options, dataDir: options.dataDir ?? dataDir(home) })
  if (options.dataDir !== undefined) return identity
  // The configuration service overlays providers/secrets, never dataDir. Read the shared YAML
  // inputs with an empty lock to avoid installed bundles, integrity checks and runtime snapshots.
  // This object is used only for addressing, never passed to Host admission or execution.
  const inputs = await readConfigurationProfileInputs({
    home: identity.home,
    profile: identity.profile,
    workspaceRoot: identity.workspace,
    agnesVersion: options.agnesVersion ?? '0.0.0',
    lock: { packages: {} },
  })
  return inputs.user?.dataDir === undefined
    ? identity
    : resolveDaemonScope({ ...options, home: identity.home, dataDir: inputs.user.dataDir })
}

/** Match the daemon's private Unix socket rules; Windows binds the pipe to the owner process. */
export async function validateConnectionSocket(path: string): Promise<void> {
  if (path.startsWith('\\\\.\\pipe\\')) return
  prepareDaemonSocketPaths({ socketPath: path, workersSocketPath: path })
  const uid = process.geteuid?.()
  const directory = await lstat(dirname(path))
  const socket = await lstat(path)
  if (
    uid === undefined ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o7777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o7777) !== 0o600
  )
    throw new BootError('local daemon socket must be owned by this user with directory 0700 and socket 0600')
}
