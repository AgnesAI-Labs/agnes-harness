import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createPrivateFileSync } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ResolvedComputerUseProfile } from '../profile/types.js'
import { connectComputerUseDriver } from './fake/connection.js'
import { type ComputerUseDriverConnection, createComputerUseSessionRuntime } from './fake/session-runtime.js'
import { macosLiveAppIdentitySync } from './macos-live-app-identity.js'
import {
  type ComputerUseArtifactSink,
  type ComputerUseBackendDependencies,
  type ComputerUseBackendProvider,
  createComputerUseBackendProvider,
} from './windows-driver-backend.js'

export type VerifiedMacOSComputerUseDriver = Readonly<{
  executablePath: string
  version: string
  bundleId: string
  teamId: string
  authority: string
  appPath: string
}>

export type MacOSComputerUseBackendDependencies = Readonly<
  Partial<ComputerUseBackendDependencies> & {
    processIdentity?: ComputerUseBackendDependencies['processIdentity']
  }
>

export type MacOSComputerUsePermissionStatus = Readonly<{
  accessibility: boolean
  screenRecording: boolean
}>

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Computer Use ${label} is invalid`)
  return value as Record<string, unknown>
}

/** macOS production adapter. App admission uses Security.framework live-code identity. */
export function createMacOSComputerUseBackendProvider(
  input: Readonly<{
    driver: VerifiedMacOSComputerUseDriver
    profile: ResolvedComputerUseProfile
    profileHash: string
    artifacts: ComputerUseArtifactSink
    dependencies?: MacOSComputerUseBackendDependencies
  }>,
): ComputerUseBackendProvider {
  const runtime =
    input.dependencies?.runtime ??
    createMacOSComputerUseSessionRuntime(input.driver, {
      ...(input.dependencies?.boundedManifest ? { boundedManifest: input.dependencies.boundedManifest } : {}),
      requirePermissions: true,
    })
  return createComputerUseBackendProvider({
    platform: 'darwin',
    driver: input.driver,
    profile: input.profile,
    profileHash: input.profileHash,
    artifacts: input.artifacts,
    dependencies: {
      ...input.dependencies,
      runtime,
      processIdentity: input.dependencies?.processIdentity ?? macosLiveAppIdentitySync,
    },
  })
}

const execute = promisify(execFile)

function modeArguments(
  mode: 'standard' | 'bounded' | 'unrestricted',
  boundedManifest?: Readonly<{ path: string; sha256: string }>,
): string[] {
  if (mode === 'bounded') {
    if (!boundedManifest) throw new Error('Computer Use bounded mode requires a reviewed capability manifest')
    return [
      '--permission-mode',
      'bounded',
      '--capability-manifest',
      boundedManifest.path,
      '--approve-capability-manifest',
    ]
  }
  if (mode === 'unrestricted') return ['--permission-mode', 'unrestricted', '--dangerously-bypass-approvals']
  return ['--permission-mode', 'standard']
}

async function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  await execute(command, [...args], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    signal,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
  })
}

async function waitForDaemon(executable: string, socket: string, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + 10_000
  let lastError: unknown
  do {
    signal?.throwIfAborted()
    try {
      await run(executable, ['status', '--socket', socket], signal)
      return
    } catch (error) {
      lastError = error
    }
    await delay(50, undefined, { signal })
  } while (performance.now() < deadline)
  throw new AggregateError(
    lastError === undefined ? [] : [lastError],
    'macOS driver daemon did not become ready',
  )
}

/** LaunchServices owns the macOS daemon so TCC is attributed to the signed CuaDriver.app. */
export function createMacOSComputerUseSessionRuntime(
  driver: VerifiedMacOSComputerUseDriver,
  options: Readonly<{
    boundedManifest?: Readonly<{ path: string; sha256: string }>
    launch?: (command: string, args: readonly string[], signal?: AbortSignal) => Promise<void>
    ready?: (executable: string, socket: string, signal?: AbortSignal) => Promise<void>
    connect?: typeof connectComputerUseDriver
    /** Work sessions refuse to start without both TCC grants; probe/health daemons must not. */
    requirePermissions?: boolean
  }> = {},
): ReturnType<typeof createComputerUseSessionRuntime> {
  if (
    options.boundedManifest &&
    (!isAbsolute(options.boundedManifest.path) ||
      resolve(options.boundedManifest.path) !== options.boundedManifest.path ||
      !/^[a-f0-9]{64}$/u.test(options.boundedManifest.sha256))
  )
    throw new Error('Computer Use bounded manifest identity is invalid')
  const launch = options.launch ?? run
  return createComputerUseSessionRuntime(
    {
      command: driver.executablePath,
      args: ['mcp'],
      startupTimeoutMs: 15_000,
      closeGraceMs: 1_000,
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
    },
    {
      async connect(command, generation, sessionToken, signal) {
        const runtimeDirectory = mkdtempSync(join(tmpdir(), `agnes-cua-${sessionToken.slice(0, 16)}-`))
        chmodSync(runtimeDirectory, 0o700)
        const socket = join(runtimeDirectory, 'driver.sock')
        const cleanupDirectory = (): void => {
          const stat = lstatSync(runtimeDirectory, { throwIfNoEntry: false })
          if (!stat) return
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Computer Use macOS runtime directory identity changed')
          rmSync(runtimeDirectory, { recursive: true, force: false })
        }
        const mode = command.env?.CUA_DRIVER_PERMISSION_MODE
        if (mode !== 'standard' && mode !== 'bounded' && mode !== 'unrestricted') {
          cleanupDirectory()
          throw new Error('Computer Use macOS permission mode is invalid')
        }
        const serve = ['-n', '-g', '-a', driver.appPath, '--args', 'serve', '--socket', socket]
        try {
          // The driver's first-launch gate raises both TCC dialogs, opens System Settings and parks every
          // tool for ten minutes on each fresh daemon. Only the explicit grant route may prompt.
          serve.push('--no-permissions-gate', ...modeArguments(mode, options.boundedManifest))
        } catch (error) {
          cleanupDirectory()
          throw error
        }
        try {
          await launch('/usr/bin/open', serve, signal)
        } catch (error) {
          cleanupDirectory()
          throw error
        }
        let stopping: Promise<void> | undefined
        const stop = (): Promise<void> => {
          stopping ??= launch(driver.executablePath, ['stop', '--socket', socket]).finally(cleanupDirectory)
          return stopping
        }
        try {
          // Without this gate `cua-driver mcp --socket` can observe the launch race and auto-start a
          // second default-mode daemon. That would silently discard bounded/unrestricted startup.
          await (options.ready ?? waitForDaemon)(driver.executablePath, socket, signal)
          const connection = await (options.connect ?? connectComputerUseDriver)(
            { ...command, args: ['mcp', '--socket', socket] },
            generation,
            sessionToken,
            signal,
          )
          if (options.requirePermissions)
            await assertMacOSPermissionsGranted(connection, driver, signal).catch(async (error: unknown) => {
              await connection.close('computer_use_permissions_missing').catch(() => undefined)
              throw error
            })
          const closeForReset = connection.closeForReset.bind(connection)
          connection.onClose(() => {
            void stop().catch(() => undefined)
          })
          return Object.assign(connection, {
            async closeForReset(reason: Parameters<typeof closeForReset>[0]) {
              let closeError: unknown
              try {
                await closeForReset(reason)
              } catch (error) {
                closeError = error
              }
              try {
                await stop()
              } catch (error) {
                if (closeError) throw new AggregateError([closeError, error], 'macOS driver cleanup failed')
                throw error
              }
              if (closeError) throw closeError
            },
          })
        } catch (error) {
          try {
            await stop()
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'macOS driver startup cleanup failed')
          }
          throw error
        }
      },
    },
    {
      commandForMode(mode, base) {
        return Object.freeze({
          ...base,
          env: Object.freeze({ ...base.env, CUA_DRIVER_PERMISSION_MODE: mode }),
        })
      },
    },
  )
}

async function readDaemonPermissions(
  connection: ComputerUseDriverConnection,
  driver: VerifiedMacOSComputerUseDriver,
  signal: AbortSignal,
): Promise<MacOSComputerUsePermissionStatus> {
  if (!connection.catalog.has('check_permissions'))
    throw new Error('Computer Use macOS driver lacks check_permissions')
  const result = await connection.call('check_permissions', { prompt: false }, { timeoutMs: 10_000, signal })
  if (result.isError) throw new Error('Computer Use macOS permission probe failed')
  const structured = object(result.structuredContent, 'macOS permission result')
  const source = object(structured.source, 'macOS permission source')
  if (
    typeof structured.accessibility !== 'boolean' ||
    typeof structured.screen_recording !== 'boolean' ||
    structured.screen_recording_capturable !== null ||
    structured.direct_capture_status !== 'not_checked' ||
    source.attribution !== 'driver-daemon' ||
    source.bundle_id !== driver.bundleId
  )
    throw new Error('Computer Use macOS permission result has untrusted attribution')
  return Object.freeze({
    accessibility: structured.accessibility,
    screenRecording: structured.screen_recording,
  })
}

async function assertMacOSPermissionsGranted(
  connection: ComputerUseDriverConnection,
  driver: VerifiedMacOSComputerUseDriver,
  signal: AbortSignal,
): Promise<void> {
  const status = await readDaemonPermissions(connection, driver, signal)
  const missing = [
    status.accessibility ? undefined : 'Accessibility',
    status.screenRecording ? undefined : 'Screen Recording',
  ].filter((name): name is string => name !== undefined)
  if (missing.length > 0)
    throw new Error(
      `Computer Use is not authorized on this Mac: CuaDriver lacks ${missing.join(' and ')} permission. ` +
        'No desktop action was started. Do not retry computer_use in this task; continue without it and ' +
        'tell the user to grant access under Settings > Computer Use.',
    )
}

/** Reads TCC state from the signed app daemon without raising either system permission prompt. */
export async function probeMacOSComputerUsePermissions(
  input: Readonly<{
    driver: VerifiedMacOSComputerUseDriver
    signal?: AbortSignal
    runtime?: ReturnType<typeof createComputerUseSessionRuntime>
  }>,
): Promise<MacOSComputerUsePermissionStatus> {
  const signal = input.signal ?? new AbortController().signal
  const runtime = input.runtime ?? createMacOSComputerUseSessionRuntime(input.driver)
  const session = Object.freeze({ key: `permissions-${randomUUID()}`, lane: 'permissions' })
  let opened = false
  try {
    const connection = await runtime.open(session, signal)
    opened = true
    return await readDaemonPermissions(connection, input.driver, signal)
  } finally {
    try {
      if (opened) await runtime.close(session, 'session_end')
    } finally {
      await runtime.dispose()
    }
  }
}

async function runPermissionHost(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  await execute(command, [...args], {
    timeout: 185_000,
    maxBuffer: 64 * 1024,
    signal,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
  })
}

/** Explicit trusted setup route. LaunchServices owns the prompts and the signed app writes the result. */
export async function grantMacOSComputerUsePermissions(
  input: Readonly<{
    driver: VerifiedMacOSComputerUseDriver
    signal?: AbortSignal
    run?: (command: string, args: readonly string[], signal?: AbortSignal) => Promise<void>
  }>,
): Promise<void> {
  if (createPlatform().os !== 'darwin' && !input.run)
    throw new Error('macOS Computer Use permission grant is unavailable on this platform')
  const resultPath = join(tmpdir(), `cua-driver-permissions-${process.pid}-${randomUUID()}.json`)
  const fd = createPrivateFileSync(resultPath)
  const resultIdentity = fstatSync(fd)
  closeSync(fd)
  try {
    await (input.run ?? runPermissionHost)(
      '/usr/bin/open',
      [
        '-n',
        '-W',
        '-g',
        input.driver.appPath,
        '--args',
        '__permissions-host-request',
        '--result-file',
        resultPath,
        '--probe-direct-capture',
      ],
      input.signal,
    )
    const resultFd = openSync(resultPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let text: string
    try {
      const stat = fstatSync(resultFd)
      if (
        !stat.isFile() ||
        stat.dev !== resultIdentity.dev ||
        stat.ino !== resultIdentity.ino ||
        stat.nlink !== 1 ||
        stat.size < 2 ||
        stat.size > 64 * 1024 ||
        (process.getuid !== undefined && stat.uid !== process.getuid()) ||
        (createPlatform().os !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new Error('Computer Use macOS permission result file is unsafe')
      text = readFileSync(resultFd, 'utf8')
    } finally {
      closeSync(resultFd)
    }
    const envelope = object(JSON.parse(text) as unknown, 'permission grant result')
    const structured = object(envelope.structuredContent, 'permission grant status')
    const source = object(structured.source, 'permission grant source')
    if (
      ('isError' in envelope && envelope.isError !== false) ||
      structured.accessibility !== true ||
      structured.screen_recording !== true ||
      structured.screen_recording_capturable !== true ||
      structured.direct_capture_status !== 'ready' ||
      source.attribution !== 'driver-daemon' ||
      source.bundle_id !== input.driver.bundleId
    )
      throw new Error('Computer Use macOS permissions were not fully granted')
  } finally {
    unlinkSync(resultPath)
  }
}
