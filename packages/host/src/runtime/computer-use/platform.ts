import { dirname } from 'node:path'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { ComputerUseDriverLock } from '@agnes/host-computer-use/computer-use/driver-lock'
import { createLinuxComputerUseBackendProvider } from '@agnes/host-computer-use/computer-use/linux-driver-backend'
import {
  doctorLockedLinuxComputerUseDriver,
  installOrUpdateLockedLinuxComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/linux-driver-install'
import {
  createMacOSComputerUseBackendProvider,
  grantMacOSComputerUsePermissions,
  probeMacOSComputerUsePermissions,
} from '@agnes/host-computer-use/computer-use/macos-driver-backend'
import {
  doctorLockedMacOSComputerUseDriver,
  installOrUpdateLockedMacOSComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/macos-driver-install'
import type { HostComputerUseStatusSource } from '@agnes/host-computer-use/computer-use/status'
import {
  type ComputerUseBackendProvider,
  createWindowsComputerUseBackendProvider,
} from '@agnes/host-computer-use/computer-use/windows-driver-backend'
import {
  doctorLockedWindowsComputerUseDriver,
  installOrUpdateLockedWindowsComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/windows-driver-install'
import type { ComputerUseDoctorParams } from '@agnes/protocol'

export type ComputerUsePlatform = 'win32' | 'darwin' | 'linux'

export type ComputerUseArtifactSink = Parameters<typeof createMacOSComputerUseBackendProvider>[0]['artifacts']

/** How one operating system installs, verifies and backs its Computer Use driver. */
type DriverKit<D extends { executablePath: string; version: string }> = Readonly<{
  install(
    input: Readonly<{ root: string; lock: ComputerUseDriverLock; signal: AbortSignal }>,
  ): Promise<Readonly<{ verified: D; installed: boolean; usedLastKnownGood: boolean }>>
  provider(
    input: Readonly<{
      driver: D
      profile: ResolvedProfile['computerUse']
      profileHash: string
      artifacts: ComputerUseArtifactSink
    }>,
  ): ComputerUseBackendProvider
  publisher(driver: D): string
  doctor(
    input: Readonly<{
      directory: string
      lock: ComputerUseDriverLock
      signal: AbortSignal
      selectors: ComputerUseDoctorParams
    }>,
  ): Promise<unknown>
  /** Present only where the OS gates the driver behind user permissions. */
  permissions?(
    driver: D,
    signal: AbortSignal,
  ): Readonly<{
    status: HostComputerUseStatusSource['permissionsStatus']
    grant: HostComputerUseStatusSource['permissionsGrant']
  }>
}>

export type DriverCandidate = Readonly<{
  provider: ComputerUseBackendProvider
  /** Makes the candidate's driver the one status, doctor and recovery describe. */
  commit(): void
  outcome: 'installed' | 'already-current' | 'repaired' | 'lkg-restored'
}>

/** An installed, verified driver and the platform-neutral operations the runtime needs from it. */
export type PreparedDriver = Readonly<{
  platform: ComputerUsePlatform
  outcome: 'installed' | 'already-current' | 'lkg-restored'
  provider: ComputerUseBackendProvider
  /** A fresh provider on the driver already verified, for recovering from a failed restart. */
  recreateProvider(): ComputerUseBackendProvider
  installCandidate(signal: AbortSignal): Promise<DriverCandidate>
  version(): string
  publisher(): string
  doctor(params: ComputerUseDoctorParams): Promise<void>
  permissionsStatus: HostComputerUseStatusSource['permissionsStatus']
  permissionsGrant: HostComputerUseStatusSource['permissionsGrant']
}>

export type PrepareDriverInput = Readonly<{
  platform: ComputerUsePlatform
  root: string
  lock: ComputerUseDriverLock
  signal: AbortSignal
  profile: ResolvedProfile['computerUse']
  profileHash: string
  artifacts: ComputerUseArtifactSink
}>

const windowsKit: DriverKit<
  Awaited<ReturnType<typeof installOrUpdateLockedWindowsComputerUseDriver>>['verified']
> = {
  install: (input) => installOrUpdateLockedWindowsComputerUseDriver(input),
  provider: (input) => createWindowsComputerUseBackendProvider(input),
  publisher: (driver) => driver.publisher,
  doctor: (input) => doctorLockedWindowsComputerUseDriver(input),
}

const macosKit: DriverKit<
  Awaited<ReturnType<typeof installOrUpdateLockedMacOSComputerUseDriver>>['verified']
> = {
  install: (input) => installOrUpdateLockedMacOSComputerUseDriver(input),
  provider: (input) => createMacOSComputerUseBackendProvider(input),
  publisher: (driver) => driver.authority,
  doctor: (input) => doctorLockedMacOSComputerUseDriver(input),
  permissions: (driver, signal) => {
    type Status = Readonly<{ accessibility: boolean; screenRecording: boolean }>
    let pendingProbe: Promise<Status> | undefined
    const status = (): Promise<Status> => {
      pendingProbe ??= probeMacOSComputerUsePermissions({ driver, signal }).finally(() => {
        pendingProbe = undefined
      })
      return pendingProbe
    }
    let pendingGrant: Promise<Status> | undefined
    const grant = (): Promise<Status> => {
      pendingGrant ??= grantMacOSComputerUsePermissions({ driver, signal })
        .then(() => status())
        .then((current) => {
          if (!current) throw new Error('Computer Use macOS permission status is unavailable')
          return current
        })
        .finally(() => {
          pendingGrant = undefined
        })
      return pendingGrant
    }
    return { status, grant }
  },
}

const linuxKit: DriverKit<
  Awaited<ReturnType<typeof installOrUpdateLockedLinuxComputerUseDriver>>['verified']
> = {
  install: (input) => installOrUpdateLockedLinuxComputerUseDriver(input),
  provider: (input) => createLinuxComputerUseBackendProvider(input),
  publisher: (driver) => `${driver.provenanceIssuer}#${driver.provenanceSubject}`,
  doctor: (input) => doctorLockedLinuxComputerUseDriver(input),
}

async function prepare<D extends { executablePath: string; version: string }>(
  kit: DriverKit<D>,
  input: PrepareDriverInput,
): Promise<PreparedDriver> {
  const { root, lock, signal, profile, profileHash, artifacts } = input
  const installed = await kit.install({ root, lock, signal })
  const outcome = installed.usedLastKnownGood
    ? 'lkg-restored'
    : installed.installed
      ? 'installed'
      : 'already-current'
  let current = installed.verified
  let version = ''
  let publisher = ''
  let permissions: ReturnType<NonNullable<typeof kit.permissions>> | undefined
  let probeHealth: (params: ComputerUseDoctorParams) => Promise<void> = async () => undefined
  const build = (driver: D) => kit.provider({ driver, profile, profileHash, artifacts })
  const configure = (driver: D): void => {
    current = driver
    version = driver.version
    publisher = kit.publisher(driver)
    probeHealth = async (params) => {
      await kit.doctor({ directory: dirname(driver.executablePath), lock, signal, selectors: params })
    }
    permissions = kit.permissions?.(driver, signal)
  }
  configure(current)
  return Object.freeze({
    platform: input.platform,
    outcome,
    provider: build(current),
    recreateProvider: () => build(current),
    installCandidate: async (candidateSignal) => {
      const priorPath = current.executablePath
      const result = await kit.install({ root, lock, signal: candidateSignal })
      const driver = result.verified
      return Object.freeze({
        provider: build(driver),
        commit: () => configure(driver),
        outcome: result.usedLastKnownGood
          ? ('lkg-restored' as const)
          : result.installed
            ? driver.executablePath === priorPath
              ? ('repaired' as const)
              : ('installed' as const)
            : ('already-current' as const),
      })
    },
    version: () => version,
    publisher: () => publisher,
    doctor: (params) => probeHealth(params),
    permissionsStatus: () => (permissions ? permissions.status() : Promise.resolve(null)),
    permissionsGrant: () => (permissions ? permissions.grant() : Promise.resolve(null)),
  })
}

/** The single place that picks the OS backend: installs and verifies its driver, hands back the neutral view. */
export function prepareComputerUseDriver(input: PrepareDriverInput): Promise<PreparedDriver> {
  switch (input.platform) {
    case 'win32':
      return prepare(windowsKit, input)
    case 'darwin':
      return prepare(macosKit, input)
    case 'linux':
      return prepare(linuxKit, input)
  }
}
