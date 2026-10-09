import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatform } from '@agnes/host'
import { decodeRuntimeTargetBytes } from '@agnes/plugin-runtime/host'
import type { RuntimeTargetArtifact } from '@agnes/protocol'
import { validateRuntimeTargetArtifact } from '@agnes/protocol'
import { createPrivateDirectorySync, windowsWritePrivateFile } from '@agnes/system-node'

export const RUNTIME_TARGET_PROBE_TIMEOUT_MS = 15_000
export const RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS = 1_000

const TARGET_FILE_NAME = 'runtime-target.json'

export type RuntimeTargetProbeWorkerInput = Readonly<{
  workerKey: `@probe:${string}`
  workerKind: 'probe'
  dataDir: string
  targetFile: string
  env: Readonly<NodeJS.ProcessEnv>
}>

export type RuntimeTargetProbeWorker = Readonly<{
  /** Resolves only after the isolated worker has validated the complete target. */
  result: Promise<void>
  /** Idempotently stops the isolated process and waits until it cannot execute plugin code. */
  close(reason: string): void | Promise<void>
}>

export type RuntimeTargetProbeWorkerFactory = (
  input: RuntimeTargetProbeWorkerInput,
) => RuntimeTargetProbeWorker

type ProbeFileSystem = Readonly<{
  mkdtemp(prefix: string): Promise<string>
  chmod(path: string, mode: number): Promise<void>
  writeFile(path: string, data: Uint8Array, options: Readonly<{ flag: 'wx'; mode: number }>): Promise<void>
  rm(path: string, options: Readonly<{ recursive: true; force: true }>): Promise<void>
}>

const nodeFileSystem: ProbeFileSystem = { mkdtemp, chmod, writeFile, rm }

type WindowsPrivateFileSystem = Readonly<{
  createPrivateDirectory(path: string): void
  writePrivateFile(path: string, data: Uint8Array): Promise<void>
}>

const nodeWindowsPrivateFileSystem: WindowsPrivateFileSystem = {
  createPrivateDirectory: createPrivateDirectorySync,
  writePrivateFile: windowsWritePrivateFile,
}

export class RuntimeTargetProbeError extends Error {
  constructor(
    readonly code:
      | 'E_RUNTIME_TARGET_SCHEMA'
      | 'E_RUNTIME_TARGET_BASE64'
      | 'E_RUNTIME_TARGET_DIGEST'
      | 'E_RUNTIME_PROBE_TIMEOUT'
      | 'E_RUNTIME_PROBE_PROCESS',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'RuntimeTargetProbeError'
  }
}

function canonicalBytes(artifact: RuntimeTargetArtifact): Uint8Array {
  const checked = validateRuntimeTargetArtifact(artifact)
  if (!checked.ok)
    throw new RuntimeTargetProbeError('E_RUNTIME_TARGET_SCHEMA', 'artifact envelope is invalid')
  return decodeRuntimeTargetBytes(checked.value)
}

function probeEnvironment(input: {
  dataDir: string
  targetFile: string
  workerKey: string
}): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('AGNES_')) env[key] = value
  }
  env.AGNES_RUNTIME_TARGET_FILE = input.targetFile
  env.AGNES_WORKER_KEY = input.workerKey
  env.AGNES_WORKER_KIND = 'probe'
  env.AGNES_WORKER_ROOT = input.dataDir
  return Object.freeze(env)
}

function hardTimeout(): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RuntimeTargetProbeError(
            'E_RUNTIME_PROBE_TIMEOUT',
            `probe did not finish within ${RUNTIME_TARGET_PROBE_TIMEOUT_MS} ms`,
          ),
        ),
      RUNTIME_TARGET_PROBE_TIMEOUT_MS,
    )
    timer.unref?.()
  })
  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

export function createRuntimeTargetProbeLauncher(options: {
  spawnWorker: RuntimeTargetProbeWorkerFactory
  /** Test seam for filesystem failure injection. */
  fileSystem?: ProbeFileSystem
  /** Test seams for Windows DACL protection; production uses @agnes/system-node. */
  windowsPrivateFileSystem?: WindowsPrivateFileSystem
  platform?: NodeJS.Platform
  /** Existing private parent directory; defaults to the platform temporary directory. */
  temporaryRoot?: string
}): (artifact: RuntimeTargetArtifact) => Promise<void> {
  const fs = options.fileSystem ?? nodeFileSystem
  const windowsFs = options.windowsPrivateFileSystem ?? nodeWindowsPrivateFileSystem
  const platform = options.platform ?? createPlatform().os
  const temporaryRoot = options.temporaryRoot ?? tmpdir()
  return async (artifact) => {
    // Decode and copy before awaiting: later caller mutation cannot alter this probe's bytes.
    const bytes = canonicalBytes(artifact)
    const digest = artifact.digest
    let dataDir: string | undefined
    let worker: RuntimeTargetProbeWorker | undefined
    let timeout: ReturnType<typeof hardTimeout> | undefined
    let primary: unknown
    const cleanupFailures: unknown[] = []
    try {
      if (platform === 'win32') {
        const candidate = join(temporaryRoot, `agnes-runtime-probe-${randomUUID()}`)
        // Create with a protected DACL from the outset. Never adopt or clean up an existing path.
        windowsFs.createPrivateDirectory(candidate)
        dataDir = candidate
      } else dataDir = await fs.mkdtemp(join(temporaryRoot, 'agnes-runtime-probe-'))
      const targetFile = join(dataDir, TARGET_FILE_NAME)
      if (platform === 'win32') {
        await windowsFs.writePrivateFile(targetFile, bytes)
      } else {
        await fs.chmod(dataDir, 0o700)
        await fs.writeFile(targetFile, bytes, { flag: 'wx', mode: 0o600 })
        await fs.chmod(targetFile, 0o600)
      }
      const workerKey = `@probe:${digest}` as const
      const input: RuntimeTargetProbeWorkerInput = Object.freeze({
        workerKey,
        workerKind: 'probe',
        dataDir,
        targetFile,
        env: probeEnvironment({ dataDir, targetFile, workerKey }),
      })
      timeout = hardTimeout()
      worker = options.spawnWorker(input)
      await Promise.race([worker.result, timeout.promise])
    } catch (error) {
      primary = error
    } finally {
      timeout?.cancel()
      if (worker)
        try {
          await worker.close(primary ? 'probe-failed' : 'probe-complete')
        } catch (error) {
          cleanupFailures.push(error)
        }
      if (dataDir)
        try {
          await fs.rm(dataDir, { recursive: true, force: true })
        } catch (error) {
          cleanupFailures.push(error)
        }
    }
    if (primary !== undefined && cleanupFailures.length === 0) throw primary
    if (primary !== undefined)
      throw new AggregateError([primary, ...cleanupFailures], 'runtime target probe and cleanup failed')
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, 'runtime target probe cleanup failed')
  }
}

type ProbeChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once' | 'kill'>

/**
 * Production child-process adapter. The caller supplies the composed worker executable/entry;
 * this module deliberately does not guess a source-tree or packaged-runtime path.
 */
export function spawnRuntimeTargetProbeWorker(options: {
  executable: string
  args?: readonly string[]
  spawn?: typeof nodeSpawn
}): RuntimeTargetProbeWorkerFactory {
  return (input) => {
    const child = (options.spawn ?? nodeSpawn)(options.executable, [...(options.args ?? [])], {
      cwd: input.dataDir,
      env: { ...input.env },
      stdio: 'ignore',
      windowsHide: true,
    }) as ProbeChild
    let terminal = false
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let resolveResult!: () => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<void>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    child.once('error', (error) => {
      if (terminal) return
      terminal = true
      resolveExit()
      rejectResult(error)
    })
    child.once('exit', (code, signal) => {
      if (terminal) return
      terminal = true
      resolveExit()
      if (code === 0) resolveResult()
      else
        rejectResult(
          new RuntimeTargetProbeError(
            'E_RUNTIME_PROBE_PROCESS',
            `probe worker exited ${code === null ? 'without a code' : `with code ${code}`}${signal ? ` (${signal})` : ''}`,
          ),
        )
    })
    return {
      result,
      async close() {
        if (terminal || child.exitCode !== null || child.signalCode !== null) return
        const killed = child.kill('SIGKILL')
        if (!killed && (terminal || child.exitCode !== null || child.signalCode !== null)) return
        if (!killed)
          throw new RuntimeTargetProbeError('E_RUNTIME_PROBE_PROCESS', 'probe worker could not be terminated')
        let reapTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            exited,
            new Promise<never>((_resolve, reject) => {
              reapTimer = setTimeout(
                () =>
                  reject(
                    new RuntimeTargetProbeError(
                      'E_RUNTIME_PROBE_PROCESS',
                      `probe worker did not exit within ${RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS} ms after SIGKILL`,
                    ),
                  ),
                RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS,
              )
              reapTimer.unref?.()
            }),
          ])
        } finally {
          if (reapTimer !== undefined) clearTimeout(reapTimer)
        }
      },
    }
  }
}
