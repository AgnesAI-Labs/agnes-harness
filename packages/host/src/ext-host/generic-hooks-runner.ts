import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionAPI, ExtensionManifest } from '@agnes/extension-api'
import { hashDirectory, type InstalledPackage } from '@agnes/package-manager'
import { inspectJsonData } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { seatbeltExtensionRunnerArgv } from './extension-seatbelt.js'
import { type PreparedHooksIsolationRuntime, SYSTEM_READ_PATHS } from './hooks-isolation-assembly.js'
import { connectIsolatedHooksRunner, type IsolatedHooksRunner } from './hooks-isolation-client.js'
import { resolveEntry } from './manifest.js'

const digest = (file: string): string =>
  `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
export async function startGenericHooksRunner(input: {
  runtime: PreparedHooksIsolationRuntime
  row: InstalledPackage
  extensionDirectory: string
  manifest: ExtensionManifest
  api: ExtensionAPI
}): Promise<IsolatedHooksRunner> {
  const directory = input.row.directory
  const tree = input.row.entry.treeIntegrity
  if (!directory || !tree || hashDirectory(directory, { exclude: [] }) !== tree)
    throw new HostError('E_EXT_ISOLATION_UNAVAILABLE', 'isolated package snapshot changed')
  const entry = resolveEntry(input.extensionDirectory, input.manifest.entry)
  const manifestFile = join(input.extensionDirectory, 'agnes.extension.json')
  const manifestDigest = digest(manifestFile)
  const entryDigest = digest(entry)
  const nonce = randomUUID()
  const runtime = input.runtime.runtime
  const argv = seatbeltExtensionRunnerArgv(
    [runtime.executable, runtime.runner],
    [...new Set([...runtime.readPaths, ...SYSTEM_READ_PATHS, realpathSync(directory)])],
  )
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: dirname(runtime.executable),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { AGNES_ISOLATION_NONCE: nonce, AGNES_PACKAGE_DIGEST: tree, AGNES_MANIFEST_DIGEST: manifestDigest },
  })
  child.stderr.resume()
  const runner = await connectIsolatedHooksRunner(
    child,
    {
      nonce,
      packageDigest: tree,
      manifestDigest,
      extensionId: input.manifest.id,
      data: {
        kind: 'extension',
        packageDirectory: directory,
        entry,
        entryDigest,
        manifestFile,
        context: {
          extId: input.manifest.id,
          version: input.manifest.version,
          trust: input.api.ctx.trust,
          lease: input.api.ctx.lease,
          info: input.api.ctx.info,
          platform: input.api.ctx.platform,
        },
      },
    },
    async (method, value, signal) => {
      if (signal.aborted) throw new HostError('E_EXT_LOAD', 'isolated invocation ended')
      const checked = inspectJsonData(value, 1048576)
      if (
        method !== 'events.append' ||
        !checked.ok ||
        !checked.value ||
        typeof checked.value !== 'object' ||
        Array.isArray(checked.value)
      )
        throw new HostError('E_CAPABILITY_UNDECLARED', 'isolated capability unavailable')
      const request = checked.value
      if (Object.keys(request).sort().join() !== 'data,name' || typeof request.name !== 'string')
        throw new HostError('E_CAPABILITY_UNDECLARED', 'invalid event capability')
      return input.api.events.append(request.name, request.data as never)
    },
  )
  try {
    if (hashDirectory(directory, { exclude: [] }) !== tree || digest(manifestFile) !== manifestDigest)
      throw new HostError('E_EXT_ISOLATION_UNAVAILABLE', 'isolated package snapshot changed')
    return runner
  } catch (error) {
    await runner.close()
    throw error
  }
}
