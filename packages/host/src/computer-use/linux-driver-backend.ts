import type { ResolvedComputerUseProfile } from '../profile/types.js'
import { createComputerUseSessionRuntime } from './fake/session-runtime.js'
import { linuxDesktopAppIdentitySync, linuxLiveAppIdentitySync } from './linux-live-app-identity.js'
import {
  type ComputerUseArtifactSink,
  type ComputerUseBackendDependencies,
  type ComputerUseBackendProvider,
  createComputerUseBackendProvider,
} from './windows-driver-backend.js'

export type VerifiedLinuxComputerUseDriver = Readonly<{
  executablePath: string
  version: string
  archiveSha256: string
  architecture: 'arm64' | 'x86_64'
  provenanceIssuer: string
  provenanceSubject: string
}>

export type LinuxComputerUseBackendDependencies = Readonly<Partial<ComputerUseBackendDependencies>>

export type LinuxComputerUseSession = Readonly<{
  kind: 'x11' | 'wayland-native' | 'wayland-xwayland'
  display: string
  sessionBus: string
}>

/** Refuses headless/mis-attributed Linux sessions before the driver can claim successful input. */
export function inspectLinuxComputerUseSession(
  environment: NodeJS.ProcessEnv = process.env,
): LinuxComputerUseSession {
  const type = environment.XDG_SESSION_TYPE?.trim().toLowerCase()
  const display = environment.DISPLAY?.trim()
  const waylandDisplay = environment.WAYLAND_DISPLAY?.trim()
  const sessionBus = environment.DBUS_SESSION_BUS_ADDRESS?.trim()
  if (!sessionBus) throw new Error('Computer Use Linux requires the desktop D-Bus session')
  if (type === 'x11') {
    if (!display) throw new Error('Computer Use Linux X11 requires DISPLAY')
    return Object.freeze({ kind: 'x11', display, sessionBus })
  }
  if (type === 'wayland') {
    if (waylandDisplay && environment.CUA_DRIVER_RS_ENABLE_WAYLAND === '1')
      return Object.freeze({ kind: 'wayland-native', display: waylandDisplay, sessionBus })
    if (display) return Object.freeze({ kind: 'wayland-xwayland', display, sessionBus })
    throw new Error(
      'Computer Use Linux Wayland requires WAYLAND_DISPLAY with CUA_DRIVER_RS_ENABLE_WAYLAND=1, or an XWayland DISPLAY',
    )
  }
  if (display) return Object.freeze({ kind: 'x11', display, sessionBus })
  throw new Error('Computer Use Linux requires an X11 or Wayland desktop session')
}

export function createLinuxComputerUseSessionRuntime(
  driver: VerifiedLinuxComputerUseDriver,
  environment: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createComputerUseSessionRuntime> {
  inspectLinuxComputerUseSession(environment)
  const inherited = Object.fromEntries(
    [
      'CUA_DRIVER_RS_ENABLE_WAYLAND',
      'DBUS_SESSION_BUS_ADDRESS',
      'DESKTOP_SESSION',
      'DISPLAY',
      'HOME',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'PATH',
      'WAYLAND_DISPLAY',
      'XAUTHORITY',
      'XDG_CONFIG_HOME',
      'XDG_CURRENT_DESKTOP',
      'XDG_DATA_DIRS',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_SESSION_TYPE',
    ].flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name] as string]])),
  )
  return createComputerUseSessionRuntime({
    command: driver.executablePath,
    args: ['mcp'],
    startupTimeoutMs: 15_000,
    closeGraceMs: 1_000,
    env: { ...inherited, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
  })
}

/** Linux production adapter with /proc + effective XDG desktop-entry application identity. */
export function createLinuxComputerUseBackendProvider(
  input: Readonly<{
    driver: VerifiedLinuxComputerUseDriver
    profile: ResolvedComputerUseProfile
    profileHash: string
    artifacts: ComputerUseArtifactSink
    dependencies?: LinuxComputerUseBackendDependencies
    environment?: NodeJS.ProcessEnv
  }>,
): ComputerUseBackendProvider {
  const environment = Object.freeze({ ...(input.environment ?? process.env) })
  inspectLinuxComputerUseSession(environment)
  const runtime =
    input.dependencies?.runtime ?? createLinuxComputerUseSessionRuntime(input.driver, environment)
  return createComputerUseBackendProvider({
    platform: 'linux',
    driver: input.driver,
    profile: input.profile,
    profileHash: input.profileHash,
    artifacts: input.artifacts,
    dependencies: {
      ...input.dependencies,
      runtime,
      processIdentity: input.dependencies?.processIdentity ?? linuxLiveAppIdentitySync,
      linuxDesktopIdentity:
        input.dependencies?.linuxDesktopIdentity ??
        ((desktopId) => linuxDesktopAppIdentitySync(desktopId, environment)),
    },
  })
}
