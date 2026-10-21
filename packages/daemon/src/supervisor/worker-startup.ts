import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import type { ByteFailure, PackageBootAdmission } from '@agnes/package-manager'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import type { DaemonConfig } from './config.js'
import { workerStderrEvidence } from './runtime-log.js'

export function spawnPackageWorker(
  options: {
    config: DaemonConfig
    workerEntry: string
    spawn?: typeof nodeSpawn
    execPath?: string
    execArgv?: string[]
  },
  input: {
    token: string
    generation: number
    workerKey: string
    kind: 'session' | 'service'
    cwd: string | undefined
    profileFile: string
    admission: PackageBootAdmission | undefined
    bootSource: string | undefined
    resourceEnv: NodeJS.ProcessEnv
  },
): ChildProcess {
  const startId = options.config.workersSocketPath.startsWith('\\\\.\\pipe\\')
    ? windowsProcessStartTimeSync(process.pid)
    : undefined
  if (startId === null) throw new Error('Supervisor process identity unavailable')
  return (options.spawn ?? nodeSpawn)(
    options.execPath ?? process.execPath,
    [...(options.execArgv ?? []), options.workerEntry],
    {
      env: {
        ...process.env,
        ...(options.config.home !== undefined ? { AGH_HOME: options.config.home } : {}),
        AGNES_WORKER_TOKEN: input.token,
        AGNES_PACKAGE_BYTE_ADMISSION: input.admission ? '1' : undefined,
        AGNES_SUPERVISOR_SOCKET: options.config.workersSocketPath,
        AGNES_SUPERVISOR_PID: startId ? String(process.pid) : undefined,
        AGNES_SUPERVISOR_START_ID: startId,
        AGNES_WORKER_KEY: input.workerKey,
        AGNES_WORKER_KIND: input.kind,
        ...(input.bootSource ? { AGNES_RUNTIME_BOOT_SOURCE: input.bootSource } : {}),
        ...input.resourceEnv,
        AGNES_WORKER_GENERATION: String(input.generation),
        AGNES_GATE_FD: '3',
        AGNES_PROFILE_FILE: input.profileFile,
        AGNES_WORKER_ROOT: input.kind === 'service' ? input.cwd : undefined,
      },
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'pipe', 'pipe', 'ipc'],
    },
  )
}

export function observeWorkerStartup(
  child: ChildProcess,
  input: {
    token: string
    generation: number
    profileHash: string
    admission: PackageBootAdmission | undefined
    starting(): boolean
    current(): boolean
    bootFailure(code: unknown): void
    failure: ((failure: ByteFailure) => void) | undefined
  },
) {
  const stderr = workerStderrEvidence()
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const frame = message as { kind?: unknown; code?: unknown; token?: unknown; failure?: ByteFailure }
    if (
      frame.token === input.token &&
      frame.kind === 'package-admission-ready' &&
      input.admission &&
      input.starting()
    ) {
      child.send?.({
        kind: 'package-byte-admission',
        token: input.token,
        generation: input.generation,
        profileHash: input.profileHash,
        admission: input.admission,
      })
      return
    }
    if (
      frame.token === input.token &&
      frame.kind === 'package-byte-failure' &&
      input.current() &&
      frame.failure &&
      typeof frame.failure.directory === 'string' &&
      typeof frame.failure.binding === 'string' &&
      frame.failure.identity &&
      typeof frame.failure.identity.integrity === 'string'
    ) {
      input.failure?.(frame.failure)
      return
    }
    if (input.starting() && frame.kind === 'worker-boot-failure') input.bootFailure(frame.code)
  })
  return stderr
}
