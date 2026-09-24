import { isAbsolute, join, resolve } from 'node:path'
import { createPlatform } from '../adapters/platform.js'
import { inspectFixedComputerUseDriverLock } from './driver-lock.js'
import {
  installOrUpdateLockedLinuxComputerUseDriver,
  readLinuxComputerUseDriverState,
} from './linux-driver-install.js'
import {
  installOrUpdateLockedMacOSComputerUseDriver,
  readMacOSComputerUseDriverState,
} from './macos-driver-install.js'
import {
  installOrUpdateLockedWindowsComputerUseDriver,
  readWindowsComputerUseDriverState,
} from './windows-driver-install.js'

export type ComputerUseRescueAction = 'status' | 'install' | 'repair'
export type ComputerUseRescueReport = Readonly<{
  schemaVersion: 1
  action: ComputerUseRescueAction
  platform: 'win32' | 'darwin' | 'linux'
  status: 'empty' | 'ready' | 'completed'
  generation: number
  activeVersion?: string
  lastKnownGoodVersion?: string
  outcome?: 'installed' | 'already-current' | 'repaired' | 'lkg-restored'
}>

function rootPath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value)
    throw new Error('Computer Use rescue data directory must be canonical')
  return join(value, 'computer-use', 'driver')
}

/** Standalone maintenance path. It does not assemble Host, import packages, or launch a runtime. */
export async function runComputerUseRescue(
  input: Readonly<{
    action: ComputerUseRescueAction
    dataDir: string
    signal?: AbortSignal
  }>,
): Promise<ComputerUseRescueReport> {
  const inspected = inspectFixedComputerUseDriverLock()
  if (!inspected.ok) throw new Error('Computer Use rescue lock is invalid')
  const platform = createPlatform().os
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Computer Use rescue is unavailable on this platform')
  const root = rootPath(input.dataDir)
  const before =
    platform === 'win32'
      ? readWindowsComputerUseDriverState(root)
      : platform === 'darwin'
        ? readMacOSComputerUseDriverState(root)
        : readLinuxComputerUseDriverState(root)
  if (input.action === 'status')
    return Object.freeze({
      schemaVersion: 1,
      action: input.action,
      platform,
      status: before.active ? 'ready' : 'empty',
      generation: before.generation,
      ...(before.active ? { activeVersion: before.active.version } : {}),
      ...(before.lastKnownGood ? { lastKnownGoodVersion: before.lastKnownGood.version } : {}),
    })

  const result =
    platform === 'win32'
      ? await installOrUpdateLockedWindowsComputerUseDriver({
          root,
          lock: inspected.lock,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : platform === 'darwin'
        ? await installOrUpdateLockedMacOSComputerUseDriver({
            root,
            lock: inspected.lock,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : await installOrUpdateLockedLinuxComputerUseDriver({
            root,
            lock: inspected.lock,
            ...(input.signal ? { signal: input.signal } : {}),
          })
  const outcome = result.usedLastKnownGood
    ? 'lkg-restored'
    : result.installed
      ? input.action === 'repair' && before.active !== null
        ? 'repaired'
        : 'installed'
      : 'already-current'
  return Object.freeze({
    schemaVersion: 1,
    action: input.action,
    platform,
    status: 'completed',
    generation: result.state.generation,
    activeVersion: result.state.active?.version ?? result.verified.version,
    ...(result.state.lastKnownGood ? { lastKnownGoodVersion: result.state.lastKnownGood.version } : {}),
    outcome,
  })
}
