import { join } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import fixedComputerUseDriverLock from '@agnes/host-computer-use/computer-use/computer-use-driver-lock.json' with {
  type: 'json',
}
import {
  evaluateFixedComputerUsePlatformAdmission,
  inspectComputerUseDriverLock,
} from '@agnes/host-computer-use/computer-use/driver-lock'
import { createComputerUseDriverOperationRuntime } from '@agnes/host-computer-use/computer-use/driver-operation-runtime'
import type { HostComputerUseStatusSource } from '@agnes/host-computer-use/computer-use/status'
import type { ComputerUseBackendProvider } from '@agnes/host-computer-use/computer-use/windows-driver-backend'
import type { ComputerUseDoctorParams } from '@agnes/protocol'
import {
  type ComputerUseArtifactSink,
  type ComputerUsePlatform,
  type PreparedDriver,
  prepareComputerUseDriver,
} from './platform.js'

export type ComputerUseRuntimeInput = Readonly<{
  profile: Pick<ResolvedProfile, 'computerUse' | 'hash'>
  dataDir: string
  platform: Readonly<{ os: string; snapshot(): { arch: string } }>
  artifacts: ComputerUseArtifactSink
  /** Starts the screenshot collector; a fresh Computer Use runtime needs it from the first capture. */
  startArtifactGc(): void
}>

/** What `createLazyComputerUseRuntime` gets once the driver is installed and verified. */
export type InitializedComputerUse = Readonly<{
  backend: ComputerUseBackendProvider
  controls: HostComputerUseStatusSource
  preparationOutcome: PreparedDriver['outcome']
  dispose(): Promise<void>
}>

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'x86_64', 'arm64'])

/** Whether the fixed driver lock admits this platform and architecture at all. */
export function computerUsePlatformAdmitted(platform: ComputerUseRuntimeInput['platform']): boolean {
  const architecture = platform.snapshot().arch
  return (
    SUPPORTED_ARCHITECTURES.has(architecture) &&
    evaluateFixedComputerUsePlatformAdmission(
      platform.os as never,
      architecture as 'x64' | 'x86_64' | 'arm64',
    ).allowed
  )
}

const isComputerUsePlatform = (os: string): os is ComputerUsePlatform =>
  os === 'win32' || os === 'darwin' || os === 'linux'

/**
 * Installs and verifies the platform driver, then wraps it in the provider swap, doctor and
 * driver-operation controls the Host exposes. Runs at most once, on first use.
 */
export async function initializeComputerUse(
  input: ComputerUseRuntimeInput,
  initializationSignal: AbortSignal,
): Promise<InitializedComputerUse> {
  const { profile, dataDir, platform } = input
  if (!isComputerUsePlatform(platform.os))
    throw new HostError('E_SEAM_INIT', 'Computer Use production driver is not admitted on this platform')
  if (profile.computerUse.appAccess === 'allowlist' && profile.computerUse.appAllowlist.length === 0)
    throw new HostError('E_SEAM_INIT', 'Computer Use requires at least one stable application identity')
  const runtimeArchitecture = platform.snapshot().arch
  if (!SUPPORTED_ARCHITECTURES.has(runtimeArchitecture))
    throw new HostError('E_SEAM_INIT', 'Computer Use production driver is not admitted on this architecture')
  const admission = evaluateFixedComputerUsePlatformAdmission(
    platform.os,
    runtimeArchitecture as 'x64' | 'x86_64' | 'arm64',
  )
  if (!admission.allowed)
    throw new HostError('E_SEAM_INIT', 'Computer Use production driver admission is blocked', {
      detail: { blockers: admission.blockers },
    })
  const inspectedDriverLock = inspectComputerUseDriverLock(fixedComputerUseDriverLock)
  if (!inspectedDriverLock.ok) throw new HostError('E_SEAM_INIT', 'Computer Use driver lock is invalid')
  const driver = await prepareComputerUseDriver({
    platform: platform.os,
    root: join(dataDir, 'computer-use', 'driver'),
    lock: inspectedDriverLock.lock,
    signal: initializationSignal,
    profile: profile.computerUse,
    profileHash: profile.hash,
    artifacts: input.artifacts,
  })
  let active: ComputerUseBackendProvider | undefined = driver.provider
  const requireProvider = (): ComputerUseBackendProvider => {
    if (!active) throw new Error('Computer Use backend is restarting')
    return active
  }
  const backend: ComputerUseBackendProvider = Object.freeze({
    acquire: (session, signal) => requireProvider().acquire(session, signal),
    release: (session) => requireProvider().release(session),
    setPermissionMode: (session, mode) => requireProvider().setPermissionMode(session, mode),
    status: () => requireProvider().status(),
    async dispose() {
      const provider = active
      active = undefined
      await provider?.dispose()
    },
  })
  const replaceProvider = async (candidate: ComputerUseBackendProvider) => {
    const previous = requireProvider()
    if (previous.status().activeSessions !== 0) {
      await candidate.dispose()
      throw new Error('Computer Use driver operation requires all sessions to be closed')
    }
    active = undefined
    try {
      await previous.dispose()
    } catch (error) {
      await candidate.dispose().catch(() => undefined)
      // A provider close can fail after partially tearing down its runtime. Recreate the same
      // already-verified driver so one failed maintenance attempt cannot strand this Host with
      // no usable provider. If recovery itself fails, remaining unavailable is fail-closed.
      try {
        active = driver.recreateProvider()
      } catch {
        active = undefined
      }
      throw error
    }
    active = candidate
  }
  const operations = createComputerUseDriverOperationRuntime({
    async install(_kind, operation) {
      operation.phase('installing')
      const candidate = await driver.installCandidate(operation.signal)
      try {
        operation.signal.throwIfAborted()
        operation.phase('restarting')
        await replaceProvider(candidate.provider)
        candidate.commit()
        return candidate.outcome
      } catch (error) {
        if (active !== candidate.provider) await candidate.provider.dispose().catch(() => undefined)
        throw error
      }
    },
    async restart(operation) {
      operation.signal.throwIfAborted()
      operation.phase('restarting')
      await replaceProvider(driver.recreateProvider())
      return 'restarted'
    },
  })
  const pendingDoctors = new Map<string, Promise<void>>()
  const doctor = (params: ComputerUseDoctorParams = {}) => {
    const key = JSON.stringify(params)
    const pending = pendingDoctors.get(key)
    if (pending) return pending
    const running = driver.doctor(params).finally(() => {
      pendingDoctors.delete(key)
    })
    pendingDoctors.set(key, running)
    return running
  }
  const controls: HostComputerUseStatusSource = Object.freeze({
    status: () => {
      const runtime = active?.status() ?? { activeSessions: 0, startAttempted: true }
      return Object.freeze({
        platform: driver.platform,
        version: driver.version(),
        publisher: driver.publisher(),
        ...runtime,
      })
    },
    doctor,
    permissionsStatus: () => driver.permissionsStatus(),
    permissionsGrant: () => driver.permissionsGrant(),
    setSessionYolo: (session: Readonly<{ key: string; lane: string }>, enabled: boolean) =>
      backend.setPermissionMode(session, enabled ? 'unrestricted' : 'standard'),
    operationStart: (kind) => {
      if (active?.status().activeSessions !== 0)
        throw new Error('Computer Use driver operation requires all sessions to be closed')
      return operations.start(kind)
    },
    operationStatus: (operationId) => operations.status(operationId),
    operationCancel: (operationId) => operations.cancel(operationId),
  })
  input.startArtifactGc()
  return {
    backend,
    controls,
    preparationOutcome: driver.outcome,
    async dispose() {
      await operations.close()
      await backend.dispose()
    },
  }
}
