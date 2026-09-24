import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionAPI } from '@agnes/extension-api'
import type { ExtensionIsolationPolicy } from '@agnes/protocol'
import type { IsolatedEcosystemPreparation } from '../assemble/packages.js'
import { HostError } from '../errors.js'
import { hashDirectory } from '../packages/sources.js'
import {
  type ExtensionRunnerRuntime,
  loadBundledExtensionRuntime,
  resolveExtensionRunnerRuntime,
} from './extension-runner-runtime.js'
import { seatbeltExtensionRunnerArgv } from './extension-seatbelt.js'
import {
  connectIsolatedHooksRunner,
  type HooksRunnerBootstrap,
  type IsolatedHooksRunner,
} from './hooks-isolation-client.js'

export type ExtensionIsolationMode = 'off' | 'preferred' | 'required'
export type ExtensionIsolationOptions = ExtensionIsolationPolicy

export type PreparedHooksIsolationRuntime = {
  backend: 'seatbelt'
  runtime: ExtensionRunnerRuntime
}

export const SYSTEM_READ_PATHS = [
  '/System',
  '/usr',
  '/dev',
  '/private/var/db/timezone',
  '/Library/Preferences',
] as const

function unavailable(message: string): HostError {
  return new HostError('E_EXT_ISOLATION_UNAVAILABLE', message)
}

/** Resolve and probe the release-owned runtime before any extension preparation or source import. */
export function prepareHooksIsolationRuntime(
  runtimeDirectory: string,
  target: string,
  backend: 'auto' | 'seatbelt' = 'auto',
): PreparedHooksIsolationRuntime {
  if (!target.startsWith('darwin-') || (backend !== 'auto' && backend !== 'seatbelt'))
    throw unavailable('no enforcing backend for this platform')
  if (!existsSync('/usr/bin/sandbox-exec')) throw unavailable('Seatbelt launcher is unavailable')
  const packaged = loadBundledExtensionRuntime(runtimeDirectory, target)
  const runtime = resolveExtensionRunnerRuntime({ ...packaged, hostNode: false })
  const probe = seatbeltExtensionRunnerArgv(
    [runtime.executable, '--input-type=module', '-e', 'process.stdout.write("agnes-seatbelt-ok")'],
    [...runtime.readPaths, ...SYSTEM_READ_PATHS],
  )
  const result = spawnSync(probe[0] as string, probe.slice(1), {
    encoding: 'utf8',
    env: {},
    cwd: dirname(runtime.executable),
    timeout: 5_000,
    maxBuffer: 4_096,
  })
  if (result.status !== 0 || result.signal || result.error || result.stdout !== 'agnes-seatbelt-ok')
    throw unavailable('Seatbelt runtime probe failed')
  return Object.freeze({ backend: 'seatbelt', runtime })
}

function digest(file: string): string {
  return `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}

/** Launch the fixed runner. Package preparation remains in Host; only JSON data crosses the pipe. */
export async function startHooksIsolationRunner(input: {
  preparedRuntime: PreparedHooksIsolationRuntime
  packageDirectory: string
  extensionDirectory: string
  preparation: IsolatedEcosystemPreparation
  api: ExtensionAPI
}): Promise<IsolatedHooksRunner> {
  const nonce = randomUUID()
  const packageDigest = hashDirectory(input.packageDirectory)
  const manifestDigest = digest(join(input.extensionDirectory, 'agnes.extension.json'))
  const runtime = input.preparedRuntime.runtime
  const argv = seatbeltExtensionRunnerArgv(
    [runtime.executable, runtime.runner],
    [...runtime.readPaths, ...SYSTEM_READ_PATHS],
  )
  const child = spawn(argv[0] as string, argv.slice(1), {
    env: {
      AGNES_ISOLATION_NONCE: nonce,
      AGNES_PACKAGE_DIGEST: packageDigest,
      AGNES_MANIFEST_DIGEST: manifestDigest,
    },
    cwd: dirname(runtime.executable),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Child stderr is deliberately not an operator diagnostic and must not be allowed to back up.
  child.stderr.resume()
  const bootstrap: HooksRunnerBootstrap = {
    nonce,
    packageDigest,
    manifestDigest,
    extensionId: 'agnes/hooks-runner',
    data: { ...input.preparation.data, lease: input.api.ctx.lease, platform: input.api.ctx.platform },
  }
  return connectIsolatedHooksRunner(child, bootstrap, (method, value, signal, invocation) =>
    input.preparation.capability(input.api, method, value, signal, invocation),
  )
}
