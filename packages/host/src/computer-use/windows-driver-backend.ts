import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ArtifactRef, JsonValue } from '@agnes/protocol'
import { decodeSafeImages } from '@agnes/protocol-validation'
import { windowsEnvironmentNamesEqual, windowsProcessExecutableIdentitySync } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ResolvedComputerUseProfile } from '../profile/types.js'
import type { ComputerUseResolvedAppIdentity } from './app-admission.js'
import { evaluateComputerUseAppAdmission } from './app-admission.js'
import {
  type ComputerUseDriverCommand,
  type ComputerUseDriverConnection,
  type ComputerUseDriverPermissionMode,
  type ComputerUseSessionRef,
  createComputerUseSessionRuntime,
} from './fake/session-runtime.js'
import type { VerifiedWindowsComputerUseDriver } from './windows-driver-verifier.js'

type Data = Record<string, unknown>
type BackendCallOptions = Readonly<{ session: ComputerUseSessionRef; signal: AbortSignal }>
type Backend = Readonly<{
  profileHash: string
  generation: number
  runtimePolicy:
    | Readonly<{
        mode: 'standard'
        authorization: 'driver-standard'
        sessionKey: string
        lane: string
      }>
    | Readonly<{
        mode: 'bounded'
        authorization: 'reviewed-manifest'
        sessionKey: string
        lane: string
        capabilityManifestDigest: string
      }>
    | Readonly<{
        mode: 'unrestricted'
        authorization: 'session-yolo'
        sessionKey: string
        lane: string
      }>
  modifierActions: readonly ('click' | 'double_click' | 'right_click' | 'middle_click' | 'drag' | 'scroll')[]
  call(args: Data, options: BackendCallOptions): Promise<unknown>
}>

export type ComputerUseArtifactSink = Readonly<{
  put(bytes: Uint8Array, meta: { mime: 'image/png' | 'image/jpeg'; name: string }): Promise<ArtifactRef>
}>
export type WindowsComputerUseArtifactSink = ComputerUseArtifactSink

export type ComputerUseBackendProvider = Readonly<{
  acquire(session: ComputerUseSessionRef, signal: AbortSignal): Promise<Backend>
  release(session: ComputerUseSessionRef): Promise<void>
  setPermissionMode(session: ComputerUseSessionRef, mode: ComputerUseDriverPermissionMode): Promise<void>
  status(): Readonly<{ activeSessions: number; startAttempted: boolean }>
  dispose(): Promise<void>
}>
export type WindowsComputerUseBackendProvider = ComputerUseBackendProvider

export type ComputerUseLiveProcessIdentity =
  | Extract<ComputerUseResolvedAppIdentity, { platform: 'win32' }>
  | Extract<ComputerUseResolvedAppIdentity, { platform: 'darwin' }>
  | Extract<ComputerUseResolvedAppIdentity, { platform: 'linux' }>

export type WindowsComputerUseBackendDependencies = Readonly<{
  processIdentity?: typeof windowsProcessExecutableIdentitySync
  runtime?: ReturnType<typeof createComputerUseSessionRuntime>
  boundedManifest?: Readonly<{ path: string; sha256: string }>
}>

export type ComputerUseBackendDependencies = Readonly<{
  processIdentity: (pid: number) => ComputerUseLiveProcessIdentity
  linuxDesktopIdentity?: (desktopId: string) =>
    | Readonly<{
        desktopId: string
        executablePath: string
        installSource: string
        launchPath: string
      }>
    | undefined
  runtime?: ReturnType<typeof createComputerUseSessionRuntime>
  boundedManifest?: Readonly<{ path: string; sha256: string }>
}>

function isCanonicalPlatformPath(value: string, platform: 'win32' | 'darwin' | 'linux'): boolean {
  const paths = platform === 'win32' ? win32 : posix
  return paths.isAbsolute(value) && paths.resolve(value) === value
}

export function computerUseDriverCommandForMode(
  base: ComputerUseDriverCommand,
  mode: ComputerUseDriverPermissionMode,
  boundedManifest?: Readonly<{ path: string; sha256: string }>,
): ComputerUseDriverCommand {
  const env: Record<string, string> = { ...base.env, CUA_DRIVER_PERMISSION_MODE: mode }
  if (mode === 'bounded') {
    if (
      !boundedManifest ||
      !isCanonicalPlatformPath(boundedManifest.path, 'win32') ||
      !/^[a-f0-9]{64}$/u.test(boundedManifest.sha256)
    )
      throw new Error('Computer Use bounded mode requires a reviewed capability manifest')
    env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE = boundedManifest.path
    env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = '1'
  } else if (mode === 'unrestricted') {
    env.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS = '1'
  }
  return Object.freeze({ ...base, env: Object.freeze(env) })
}

export const windowsComputerUseDriverCommandForMode = computerUseDriverCommandForMode

const TERMINALS = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wt.exe',
  'windowsterminal.exe',
  'openconsole.exe',
  'conhost.exe',
  'bash.exe',
  'wsl.exe',
])
const PASSWORD_MANAGERS = new Set([
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'dashlane.exe',
])
const SYSTEM_SECURITY = new Set([
  'systemsettings.exe',
  'systemsettingsadminflows.exe',
  'sechealthui.exe',
  'securityhealthhost.exe',
  'securityhealthsystray.exe',
  'smartscreen.exe',
  'credentialuibroker.exe',
])
const MAC_TERMINALS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.github.wez.wezterm',
])
const MAC_PASSWORD_MANAGERS = new Set([
  'com.1password.1password',
  'com.bitwarden.desktop',
  'org.keepassxc.keepassxc',
  'com.dashlane.dashlanephonefinal',
])
const MAC_SYSTEM_SECURITY = new Set([
  'com.apple.systempreferences',
  'com.apple.SecurityAgent',
  'com.apple.loginwindow',
])
const LINUX_TERMINALS = new Set([
  'alacritty',
  'bash',
  'foot',
  'gnome-terminal',
  'kitty',
  'konsole',
  'sh',
  'wezterm',
  'xterm',
  'zsh',
])
const LINUX_PASSWORD_MANAGERS = new Set(['1password', 'bitwarden', 'keepassxc'])
const LINUX_SYSTEM_SECURITY = new Set([
  'gnome-control-center',
  'kcmshell6',
  'polkit-gnome-authentication-agent-1',
  'systemsettings',
])
const LINUX_HARD_DENY_DESKTOP_IDS = new Set(
  [
    'Alacritty',
    'com.bitwarden.desktop',
    'com.mitchellh.ghostty',
    'com.system76.CosmicTerm',
    'gnome-control-center',
    'gnome-terminal',
    'kitty',
    'konsole',
    'org.gnome.Terminal',
    'org.keepassxc.KeePassXC',
    'org.wezfurlong.wezterm',
    'systemsettings',
    'xterm',
  ].map((value) => value.toLowerCase()),
)
const WINDOWS_HARD_DENY_PACKAGE_FAMILIES = new Set(
  [
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'Microsoft.PowerShell_8wekyb3d8bbwe',
    'windows.immersivecontrolpanel_cw5n1h2txyewy',
    'Microsoft.SecHealthUI_8wekyb3d8bbwe',
    'Microsoft.CredDialogHost_cw5n1h2txyewy',
    'Microsoft.BioEnrollment_cw5n1h2txyewy',
    'Microsoft.LockApp_cw5n1h2txyewy',
    'Microsoft.AccountsControl_cw5n1h2txyewy',
    'Microsoft.AAD.BrokerPlugin_cw5n1h2txyewy',
    'Microsoft.Windows.CloudExperienceHost_cw5n1h2txyewy',
  ].map((value) => value.toLowerCase()),
)

function data(value: unknown, message: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Data
}

function array(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

function positive(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(message)
  return value as number
}

function sessionKey(session: ComputerUseSessionRef): string {
  return `${session.key.length}:${session.key}${session.lane.length}:${session.lane}`
}

const AGENT_CURSOR_TOOLS = Object.freeze([
  'start_session',
  'set_agent_cursor_enabled',
  'end_session',
] as const)

async function startAgentCursorSession(
  connection: ComputerUseDriverConnection,
  signal: AbortSignal,
): Promise<string> {
  for (const tool of AGENT_CURSOR_TOOLS)
    if (!connection.catalog.has(tool))
      throw new Error(`Computer Use driver catalog lacks required agent cursor tool ${tool}`)
  const session = `agnes-${randomUUID()}`
  let started = false
  try {
    const opened = await connection.call(
      'start_session',
      {
        session,
        capture_scope: 'window',
        cursor_theme: { theme_id: 'cua.default', reduced_motion: 'auto' },
      },
      { timeoutMs: 10_000, signal },
    )
    if (opened.isError) throw new Error('Computer Use driver rejected the agent cursor session')
    started = true
    const enabled = await connection.call(
      'set_agent_cursor_enabled',
      { session, enabled: true },
      { timeoutMs: 10_000, signal },
    )
    if (enabled.isError) throw new Error('Computer Use driver rejected the agent cursor overlay')
    return session
  } catch (error) {
    if (started) {
      const cleanupSignal = new AbortController().signal
      await connection
        .call('end_session', { session }, { timeoutMs: 5_000, signal: cleanupSignal })
        .catch(() => undefined)
    }
    throw error
  }
}

async function endAgentCursorSession(
  connection: ComputerUseDriverConnection,
  session: string,
): Promise<void> {
  const signal = new AbortController().signal
  const ended = await connection.call('end_session', { session }, { timeoutMs: 5_000, signal })
  if (ended.isError) throw new Error('Computer Use driver rejected agent cursor cleanup')
}

function windowsCategory(path: string): string | undefined {
  const name = win32.basename(path).toLowerCase()
  if (TERMINALS.has(name)) return 'terminal'
  if (PASSWORD_MANAGERS.has(name)) return 'password-manager'
  if (SYSTEM_SECURITY.has(name)) return 'system-security'
  return undefined
}

function hardDenyCategory(identity: ComputerUseLiveProcessIdentity): string | undefined {
  if (identity.platform === 'win32') return windowsCategory(identity.executablePath)
  if (identity.platform === 'linux') {
    const executable = posix.basename(identity.executablePath).toLowerCase()
    if (LINUX_HARD_DENY_DESKTOP_IDS.has(identity.desktopId.toLowerCase())) return 'system-security'
    if (LINUX_TERMINALS.has(executable)) return 'terminal'
    if (LINUX_PASSWORD_MANAGERS.has(executable)) return 'password-manager'
    if (LINUX_SYSTEM_SECURITY.has(executable)) return 'system-security'
    return undefined
  }
  if (MAC_TERMINALS.has(identity.bundleId)) return 'terminal'
  if (MAC_PASSWORD_MANAGERS.has(identity.bundleId)) return 'password-manager'
  if (MAC_SYSTEM_SECURITY.has(identity.bundleId)) return 'system-security'
  return undefined
}

function targetFields(args: Data): Data {
  const raw = args.target === undefined ? {} : data(args.target, 'Computer Use target is invalid')
  const pid = raw.pid ?? args.pid
  const windowId = raw.windowId ?? raw.window_id ?? args.window_id
  const snapshotId = raw.snapshotId ?? raw.snapshot_id
  return {
    ...(pid === undefined ? {} : { pid: positive(pid, 'Computer Use target pid is invalid') }),
    ...(windowId === undefined
      ? {}
      : { window_id: positive(windowId, 'Computer Use target window id is invalid') }),
    ...(typeof snapshotId === 'string' && snapshotId ? { snapshot_id: snapshotId } : {}),
  }
}

function coordinate(value: unknown, message: string): readonly [number, number] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((part) => typeof part !== 'number' || !Number.isFinite(part))
  )
    throw new Error(message)
  return value as unknown as readonly [number, number]
}

function elementFields(args: Data): Data {
  const target = targetFields(args)
  const hasElement = args.element !== undefined || args.element_token !== undefined
  return {
    ...(target.pid === undefined ? {} : { pid: target.pid }),
    ...(target.window_id === undefined ? {} : { window_id: target.window_id }),
    ...(hasElement && target.snapshot_id !== undefined ? { snapshot_id: target.snapshot_id } : {}),
    ...(args.element === undefined ? {} : { element_index: args.element }),
    ...(args.element_token === undefined ? {} : { element_token: args.element_token }),
  }
}

function resultEnvelope(result: Awaited<ReturnType<ComputerUseDriverConnection['call']>>): Data {
  return {
    content: result.content.map((block) => ({ ...block })),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: structuredClone(result.structuredContent) }),
    isError: result.isError,
  }
}

function listing(
  result: Awaited<ReturnType<ComputerUseDriverConnection['call']>>,
  key: string,
): readonly unknown[] {
  if (result.isError) throw new Error(`Computer Use ${key} discovery failed`)
  return array(
    data(result.structuredContent, `Computer Use ${key} result is invalid`)[key],
    `Computer Use ${key} list is invalid`,
  )
}

type WindowRow = Readonly<{
  app: string
  pid: number
  windowId: number
  title: string
  bounds: readonly [number, number, number, number]
  active: boolean
  zIndex: number | null
}>

function windowRow(value: unknown): WindowRow {
  const row = data(value, 'Computer Use window row is invalid')
  const bounds = data(row.bounds, 'Computer Use window bounds are invalid')
  const app = row.app_name ?? row.app
  if (typeof app !== 'string' || typeof row.title !== 'string')
    throw new Error('Computer Use window identity is invalid')
  const normalizedBounds = [
    Number(bounds.x),
    Number(bounds.y),
    Number(bounds.width),
    Number(bounds.height),
  ] as [number, number, number, number]
  if (
    normalizedBounds.some((part) => !Number.isFinite(part)) ||
    normalizedBounds[2] <= 0 ||
    normalizedBounds[3] <= 0
  )
    throw new Error('Computer Use window bounds are invalid')
  const zIndex = row.z_index === null || row.z_index === undefined ? null : Number(row.z_index)
  if (zIndex !== null && !Number.isSafeInteger(zIndex))
    throw new Error('Computer Use window z-index is invalid')
  return Object.freeze({
    app,
    pid: positive(row.pid, 'Computer Use window pid is invalid'),
    windowId: positive(row.window_id, 'Computer Use window id is invalid'),
    title: row.title,
    bounds: Object.freeze(normalizedBounds),
    active: row.active === true,
    zIndex,
  })
}

function appRows(result: Awaited<ReturnType<ComputerUseDriverConnection['call']>>): readonly Data[] {
  return listing(result, 'apps').map((value) => data(value, 'Computer Use app row is invalid'))
}

type AppRow = Readonly<{
  name: string
  pid: number
  active: boolean
  bundleId?: string
  aumid?: string
  launchPath?: string
  path?: string
}>

type LaunchCandidate = Readonly<{
  name: string
  stableId: string
  invocation: Readonly<{ aumid: string } | { path: string } | { bundle_id: string } | { launch_path: string }>
  packageFamilyName?: string
  executablePath?: string
  bundleId?: string
  desktopId?: string
  installSource?: string
}>

const WINDOWS_BROWSER_EXECUTABLES: ReadonlyMap<string, readonly string[]> = new Map([
  ['chrome.exe', ['--new-window']],
  ['msedge.exe', ['--new-window']],
  ['firefox.exe', ['-new-window']],
] as const)

const WINDOWS_BROWSER_PACKAGE_FAMILIES: ReadonlyMap<string, readonly string[]> = new Map([
  ['microsoft.microsoftedge.stable_8wekyb3d8bbwe', ['--new-window']],
] as const)

const MAC_BROWSER_BUNDLES: ReadonlyMap<string, readonly string[]> = new Map([
  ['com.google.Chrome', ['--new-window']],
  ['com.microsoft.edgemac', ['--new-window']],
  ['org.mozilla.firefox', ['-new-window']],
  ['com.apple.Safari', []],
] as const)
const LINUX_BROWSER_EXECUTABLES: ReadonlyMap<string, readonly string[]> = new Map([
  ['brave-browser', ['--new-window']],
  ['chromium', ['--new-window']],
  ['chromium-browser', ['--new-window']],
  ['firefox', ['--new-window']],
  ['google-chrome', ['--new-window']],
  ['microsoft-edge', ['--new-window']],
] as const)
const FULL_DESKTOP_CAPTURE_APPS = new Set(['screen', 'desktop'])

function browserLaunchArguments(
  candidate: LaunchCandidate,
  platform: 'win32' | 'darwin' | 'linux',
): readonly string[] | undefined {
  if (candidate.executablePath) {
    const executable = (platform === 'win32' ? win32 : posix).basename(candidate.executablePath).toLowerCase()
    return WINDOWS_BROWSER_EXECUTABLES.get(executable) ?? LINUX_BROWSER_EXECUTABLES.get(executable)
  }
  if (candidate.packageFamilyName)
    return WINDOWS_BROWSER_PACKAGE_FAMILIES.get(candidate.packageFamilyName.toLowerCase())
  if (candidate.bundleId) return MAC_BROWSER_BUNDLES.get(candidate.bundleId)
  return undefined
}

function isProtectedAgnesWindow(window: WindowRow): boolean {
  const app = window.app.trim().toLowerCase()
  const browser =
    WINDOWS_BROWSER_EXECUTABLES.has(app) ||
    LINUX_BROWSER_EXECUTABLES.has(app) ||
    ['google chrome', 'microsoft edge', 'firefox', 'safari'].includes(app) ||
    [...MAC_BROWSER_BUNDLES.keys()].some((bundleId) => bundleId.toLowerCase() === app)
  // Browsers commonly prefix the page title before the product name, so the protected window can
  // be "<task> - Agnes Harness - Chrome" rather than starting with Agnes Harness. Match one title
  // segment, not an arbitrary substring, to avoid steering the model back into its own control UI.
  return (
    browser && /(?:^|\s[-\u2013\u2014]\s)agnes harness(?:\s[-\u2013\u2014]\s|$)/iu.test(window.title.trim())
  )
}

type LaunchResolution =
  | Readonly<{ ok: true; candidate: LaunchCandidate }>
  | Readonly<{ ok: false; code: string; message: string }>

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0'))
    throw new Error(`Computer Use app ${field} is invalid`)
  return value
}

function normalizedAppRow(value: Data): AppRow {
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 1024)
    throw new Error('Computer Use app name is invalid')
  const pid = value.pid === undefined ? 0 : Number(value.pid)
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Computer Use app pid is invalid')
  return Object.freeze({
    name: value.name,
    pid,
    active: value.active === true,
    ...(optionalText(value.bundle_id, 'bundle id') ? { bundleId: String(value.bundle_id) } : {}),
    ...(optionalText(value.aumid, 'aumid') ? { aumid: String(value.aumid) } : {}),
    ...(optionalText(value.launch_path, 'launch path') ? { launchPath: String(value.launch_path) } : {}),
    ...(optionalText(value.path, 'path') ? { path: String(value.path) } : {}),
  })
}

function packageLaunchIdentity(row: AppRow): { packageFamilyName: string; aumid: string } | undefined {
  const aumid = row.aumid ?? /^shell:appsFolder\\([^\\]+)$/iu.exec(row.launchPath ?? '')?.[1]
  if (!aumid) return undefined
  const separator = aumid.indexOf('!')
  if (separator <= 0 || separator === aumid.length - 1) return undefined
  const packageFamilyName = aumid.slice(0, separator)
  if (row.bundleId && ![packageFamilyName, aumid].some((value) => value === row.bundleId)) return undefined
  return { packageFamilyName, aumid }
}

function windowsPathEqual(left: string, right: string): boolean {
  try {
    return windowsEnvironmentNamesEqual(left, right)
  } catch {
    // Production Windows app launch must use the native ordinal comparison. The narrow fallback
    // exists only so another platform can exercise the shared adapter with synthetic Windows rows.
    return (
      createPlatform().os !== 'win32' &&
      /^[\x20-\x7e]+$/u.test(left + right) &&
      left.toLowerCase() === right.toLowerCase()
    )
  }
}

function launchCandidate(
  row: AppRow,
  platform: 'win32' | 'darwin' | 'linux',
  linuxDesktopIdentity?: ComputerUseBackendDependencies['linuxDesktopIdentity'],
): LaunchCandidate | undefined {
  if (row.pid > 0) return undefined
  if (platform === 'darwin') {
    if (!row.bundleId) return undefined
    return Object.freeze({
      name: row.name,
      stableId: row.bundleId,
      bundleId: row.bundleId,
      invocation: Object.freeze({ bundle_id: row.bundleId }),
    })
  }
  if (platform === 'linux') {
    if (!row.bundleId || !linuxDesktopIdentity) return undefined
    const identity = linuxDesktopIdentity(row.bundleId)
    if (!identity || identity.desktopId !== row.bundleId) return undefined
    return Object.freeze({
      name: row.name,
      stableId: identity.desktopId,
      desktopId: identity.desktopId,
      executablePath: identity.executablePath,
      installSource: identity.installSource,
      invocation: Object.freeze({ launch_path: identity.launchPath }),
    })
  }
  const packaged = packageLaunchIdentity(row)
  if (packaged)
    return Object.freeze({
      name: row.name,
      stableId: packaged.packageFamilyName,
      packageFamilyName: packaged.packageFamilyName,
      invocation: Object.freeze({ aumid: packaged.aumid }),
    })
  if (!row.path || !isCanonicalPlatformPath(row.path, platform)) return undefined
  return Object.freeze({
    name: row.name,
    stableId: row.path,
    executablePath: row.path,
    invocation: Object.freeze({ path: row.path }),
  })
}

function candidateHardDenied(candidate: LaunchCandidate, platform: 'win32' | 'darwin' | 'linux'): boolean {
  if (platform === 'darwin')
    return Boolean(
      candidate.bundleId &&
        (MAC_TERMINALS.has(candidate.bundleId) ||
          MAC_PASSWORD_MANAGERS.has(candidate.bundleId) ||
          MAC_SYSTEM_SECURITY.has(candidate.bundleId)),
    )
  if (platform === 'linux') {
    if (!candidate.executablePath) return true
    if (candidate.desktopId && LINUX_HARD_DENY_DESKTOP_IDS.has(candidate.desktopId.toLowerCase())) return true
    const executable = posix.basename(candidate.executablePath).toLowerCase()
    return (
      LINUX_TERMINALS.has(executable) ||
      LINUX_PASSWORD_MANAGERS.has(executable) ||
      LINUX_SYSTEM_SECURITY.has(executable)
    )
  }
  if (
    candidate.packageFamilyName &&
    WINDOWS_HARD_DENY_PACKAGE_FAMILIES.has(candidate.packageFamilyName.toLowerCase())
  )
    return true
  return Boolean(candidate.executablePath && windowsCategory(candidate.executablePath))
}

function candidatePreflightAllowed(
  candidate: LaunchCandidate,
  platform: 'win32' | 'darwin' | 'linux',
  profile: ResolvedComputerUseProfile,
): boolean {
  if (candidateHardDenied(candidate, platform)) return false
  if (profile.appAccess === 'all') return true
  return profile.appAllowlist.some((allowed) => {
    if (platform === 'darwin') return allowed.platform === 'darwin' && allowed.bundleId === candidate.bundleId
    if (platform === 'linux')
      return (
        allowed.platform === 'linux' &&
        allowed.desktopId === candidate.desktopId &&
        allowed.executablePath === candidate.executablePath &&
        allowed.installSource === candidate.installSource
      )
    if (allowed.platform !== 'win32') return false
    if ('packageFamilyName' in allowed) return allowed.packageFamilyName === candidate.packageFamilyName
    return Boolean(
      candidate.executablePath && windowsPathEqual(allowed.executablePath, candidate.executablePath),
    )
  })
}

function candidateMatchesIdentity(
  candidate: LaunchCandidate,
  identity: ComputerUseLiveProcessIdentity,
): boolean {
  if (identity.platform === 'darwin') return candidate.bundleId === identity.bundleId
  if (identity.platform === 'linux')
    return (
      candidate.desktopId === identity.desktopId &&
      candidate.executablePath === identity.executablePath &&
      candidate.installSource === identity.installSource
    )
  if (candidate.packageFamilyName)
    return 'packageFamilyName' in identity && identity.packageFamilyName === candidate.packageFamilyName
  return Boolean(
    candidate.executablePath && windowsPathEqual(candidate.executablePath, identity.executablePath),
  )
}

function captureSafety(raw: Data): Data | undefined {
  if (raw.safety === undefined) return undefined
  const source = data(raw.safety, 'Computer Use capture safety is invalid')
  if (typeof source.reliable !== 'boolean')
    throw new Error('Computer Use capture safety reliability is invalid')
  const result: Data = { reliable: source.reliable }
  for (const [field, alias] of [
    ['secureInput', 'secure_input'],
    ['payment', 'payment'],
    ['twoFactor', 'two_factor'],
    ['systemPermission', 'system_permission'],
  ] as const) {
    const canonical = source[field]
    const compatible = source[alias]
    if (
      (canonical !== undefined && typeof canonical !== 'boolean') ||
      (compatible !== undefined && typeof compatible !== 'boolean') ||
      (canonical !== undefined && compatible !== undefined && canonical !== compatible)
    )
      throw new Error(`Computer Use capture safety ${field} is invalid`)
    const value = canonical ?? compatible
    if (typeof value === 'boolean') result[field] = value
  }
  return Object.freeze(result)
}

function captureElements(value: unknown): readonly unknown[] {
  if (value === undefined) return []
  const source = array(value, 'Computer Use capture elements are invalid')
  const indexes = new Set<number>()
  for (const value of source) {
    const element = data(value, 'Computer Use capture element is invalid')
    const index = element.index ?? element.element_index
    if (!Number.isSafeInteger(index) || (index as number) < 0 || indexes.has(index as number))
      throw new Error('Computer Use capture element index is invalid')
    if (typeof element.role !== 'string') throw new Error('Computer Use capture element role is invalid')
    if (
      element.bounds !== undefined &&
      (!Array.isArray(element.bounds) ||
        element.bounds.length !== 4 ||
        element.bounds.some((part) => typeof part !== 'number' || !Number.isFinite(part)))
    )
      throw new Error('Computer Use capture element bounds are invalid')
    indexes.add(index as number)
  }
  return source
}

async function delay(seconds: number, signal: AbortSignal): Promise<Data> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)
    throw new Error('Computer Use wait is invalid')
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, seconds * 1_000)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new DOMException('Computer Use wait cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  return { ok: true, action: 'wait', effect: 'confirmed' }
}

/** Creates the production Windows adapter; every target PID is re-attested before every call. */
export function createWindowsComputerUseBackendProvider(
  input: Readonly<{
    driver: VerifiedWindowsComputerUseDriver
    profile: ResolvedComputerUseProfile
    profileHash: string
    artifacts: WindowsComputerUseArtifactSink
    dependencies?: WindowsComputerUseBackendDependencies
  }>,
): WindowsComputerUseBackendProvider {
  const identify = input.dependencies?.processIdentity ?? windowsProcessExecutableIdentitySync
  return createComputerUseBackendProvider({
    ...input,
    platform: 'win32',
    dependencies: {
      ...input.dependencies,
      processIdentity: (pid) => Object.freeze({ platform: 'win32' as const, ...identify(pid) }),
    },
  })
}

/** Shared platform adapter; callers must supply an OS-attested live process identity. */
export function createComputerUseBackendProvider(
  input: Readonly<{
    platform: 'win32' | 'darwin' | 'linux'
    driver: Readonly<{ executablePath: string; version: string }>
    profile: ResolvedComputerUseProfile
    profileHash: string
    artifacts: ComputerUseArtifactSink
    dependencies: ComputerUseBackendDependencies
  }>,
): ComputerUseBackendProvider {
  if (!input.profile.enabled) throw new Error('Computer Use is disabled in the resolved profile')
  if (input.profile.appAccess === 'allowlist' && input.profile.appAllowlist.length === 0)
    throw new Error('Computer Use requires at least one stable application identity')
  const boundedManifest = input.dependencies?.boundedManifest
  if (
    boundedManifest &&
    (!isCanonicalPlatformPath(boundedManifest.path, input.platform) ||
      !/^[a-f0-9]{64}$/u.test(boundedManifest.sha256))
  )
    throw new Error('Computer Use bounded manifest identity is invalid')
  const runtime =
    input.dependencies?.runtime ??
    createComputerUseSessionRuntime(
      {
        command: input.driver.executablePath,
        args: ['mcp'],
        startupTimeoutMs: 10_000,
        closeGraceMs: 1_000,
        env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
      },
      undefined,
      {
        commandForMode(mode, base) {
          return computerUseDriverCommandForMode(base, mode, boundedManifest)
        },
      },
    )
  const identify = input.dependencies.processIdentity
  const backends = new Map<string, Backend>()
  const openingBackends = new Map<string, Promise<Backend>>()
  const connections = new Map<string, ComputerUseDriverConnection>()
  const cursorSessions = new Map<string, string>()
  const processStarts = new Map<string, Map<number, string>>()
  // A ToolContext signal belongs to one tool dispatch and Core aborts it after that dispatch
  // settles. The driver transport spans many capture/input dispatches, so binding runtime.open()
  // to the caller signal would tear down the transport immediately after every successful call.
  // Keep a Host-owned lifetime signal per session and close it only with the provider lifecycle.
  const lifetimeControllers = new Map<string, AbortController>()
  const lifecycleGenerations = new Map<string, number>()
  const lifecycleTasks = new Map<string, Promise<void>>()
  let startAttempted = false
  let disposed = false
  let disposeTask: Promise<void> | undefined

  const runLifecycle = (key: string, operation: () => Promise<void>): Promise<void> => {
    const previous = lifecycleTasks.get(key)
    let task: Promise<void>
    task = (async () => {
      await previous?.catch(() => undefined)
      await operation()
    })().finally(() => {
      if (lifecycleTasks.get(key) === task) lifecycleTasks.delete(key)
    })
    lifecycleTasks.set(key, task)
    return task
  }

  const inspectAllowed = (pid: number, starts: Map<number, string>) => {
    const identity = identify(pid)
    const prior = starts.get(pid)
    if (prior !== undefined && prior !== identity.processStartTime)
      throw new Error('Computer Use target process identity changed')
    if (identity.platform !== input.platform) throw new Error('Computer Use target identity platform changed')
    const category = hardDenyCategory(identity)
    const decision = evaluateComputerUseAppAdmission(
      { ...identity, ...(category ? { category } : {}) },
      input.profile.appAllowlist,
      input.profile.appAccess === 'all',
    )
    if (!decision.allowed) throw new Error(`Computer Use target denied: ${decision.code}`)
    starts.set(pid, identity.processStartTime)
    return identity
  }

  const listWindows = async (
    connection: ComputerUseDriverConnection,
    options: BackendCallOptions,
  ): Promise<readonly WindowRow[]> => {
    const result = await connection.call('list_windows', {}, { timeoutMs: 10_000, signal: options.signal })
    const rows = listing(result, 'windows')
      // macOS always lists offscreen 0x0 helpers (the driver's own among them); one must not sink the rest.
      .filter((value) => !['width', 'height'].some((side) => ((value as Data)?.bounds as Data)?.[side] === 0))
      .map(windowRow)
      .filter((window) => !isProtectedAgnesWindow(window))
    if (rows.some((window) => window.active)) return rows
    const ranked = rows.filter((window) => window.zIndex !== null)
    if (ranked.length === 0) return rows
    const activeZ =
      input.platform === 'linux' ? Math.max(...ranked.map((window) => window.zIndex as number)) : 0
    return rows.map((window) =>
      window.zIndex === activeZ ? Object.freeze({ ...window, active: true }) : window,
    )
  }

  const listAppRows = async (
    connection: ComputerUseDriverConnection,
    options: BackendCallOptions,
  ): Promise<readonly AppRow[]> => {
    const result = await connection.call('list_apps', {}, { timeoutMs: 10_000, signal: options.signal })
    return appRows(result).map(normalizedAppRow)
  }

  const candidateForRow = (row: AppRow): LaunchCandidate | undefined => {
    const discovered = launchCandidate(row, input.platform, input.dependencies.linuxDesktopIdentity)
    if (discovered) return discovered
    if (row.pid <= 0) return undefined
    let identity: ComputerUseLiveProcessIdentity
    try {
      identity = identify(row.pid)
    } catch {
      return undefined
    }
    if (identity.platform !== input.platform) return undefined
    if (identity.platform === 'darwin') {
      if (!identity.bundleId) return undefined
      return Object.freeze({
        name: row.name,
        stableId: identity.bundleId,
        bundleId: identity.bundleId,
        invocation: Object.freeze({ bundle_id: identity.bundleId }),
      })
    }
    if (identity.platform === 'linux') {
      const desktop = input.dependencies.linuxDesktopIdentity?.(identity.desktopId)
      if (!desktop || desktop.executablePath !== identity.executablePath) return undefined
      return Object.freeze({
        name: row.name,
        stableId: identity.desktopId,
        desktopId: identity.desktopId,
        executablePath: identity.executablePath,
        installSource: identity.installSource,
        invocation: Object.freeze({ launch_path: desktop.launchPath }),
      })
    }
    return Object.freeze({
      name: row.name,
      stableId: identity.executablePath,
      executablePath: identity.executablePath,
      invocation: Object.freeze({ path: identity.executablePath }),
    })
  }

  const launchableCandidateForRow = (row: AppRow): LaunchCandidate | undefined => {
    const candidate = candidateForRow(row)
    if (!candidate) return undefined
    return candidate
  }

  const launchableCandidates = (rows: readonly AppRow[]): readonly LaunchCandidate[] =>
    rows.flatMap((row) => {
      const candidate = launchableCandidateForRow(row)
      return candidate && candidatePreflightAllowed(candidate, input.platform, input.profile)
        ? [candidate]
        : []
    })

  const resolveLaunchCandidate = async (
    connection: ComputerUseDriverConnection,
    args: Data,
    options: BackendCallOptions,
  ): Promise<LaunchResolution> => {
    const requested = typeof args.app === 'string' ? args.app.trim().toLowerCase() : ''
    if (!requested)
      return Object.freeze({
        ok: false,
        code: 'missing_app',
        message: 'Computer Use launch requires one exact application from list_apps.',
      })
    const rows = await listAppRows(connection, options)
    const exactRows = rows.filter((row) => {
      const candidate = launchableCandidateForRow(row)
      return [row.name, row.bundleId, row.aumid, candidate?.stableId].some(
        (value) => value?.trim().toLowerCase() === requested,
      )
    })
    if (exactRows.length === 0)
      return Object.freeze({
        ok: false,
        code: 'app_not_installed',
        message:
          'The application was not found under that exact installed-app name. Ask the user to download and install it, or provide its exact name from list_apps, then try again.',
      })
    const launchable = exactRows.flatMap((row) => {
      const candidate = launchableCandidateForRow(row)
      return candidate ? [candidate] : []
    })
    if (launchable.length === 0)
      return Object.freeze({
        ok: false,
        code: 'app_not_launchable',
        message:
          'The application is installed but has no safely verified launch identity. Ask the user to open it manually or repair its installation.',
      })
    const matches = launchable.filter((candidate) =>
      candidatePreflightAllowed(candidate, input.platform, input.profile),
    )
    if (matches.length === 0)
      return Object.freeze({
        ok: false,
        code: 'app_launch_blocked',
        message:
          'The application is installed, but the Computer Use profile or hard safety policy blocks it.',
      })
    const unique = new Map(matches.map((candidate) => [candidate.stableId.toLowerCase(), candidate]))
    if (unique.size !== 1)
      return Object.freeze({
        ok: false,
        code: 'ambiguous_app',
        message:
          'The application name matches multiple launch identities. Use the exact app_id from list_apps.',
      })
    return Object.freeze({ ok: true, candidate: [...unique.values()][0] as LaunchCandidate })
  }

  const findLaunchedWindow = async (
    connection: ComputerUseDriverConnection,
    candidate: LaunchCandidate,
    options: BackendCallOptions,
    starts: Map<number, string>,
    priorWindows: ReadonlySet<string>,
  ): Promise<WindowRow | undefined> => {
    const deadline = Date.now() + 5_000
    let now = Date.now()
    while (now <= deadline) {
      options.signal.throwIfAborted()
      const matches: WindowRow[] = []
      for (const window of await listWindows(connection, options)) {
        if (priorWindows.has(`${window.pid}:${window.windowId}`)) continue
        let identity: ComputerUseLiveProcessIdentity
        try {
          identity = identify(window.pid)
        } catch {
          continue
        }
        if (!candidateMatchesIdentity(candidate, identity)) continue
        inspectAllowed(window.pid, starts)
        matches.push(window)
      }
      const active = matches.filter((window) => window.active)
      if (matches.length === 1) return matches[0]
      if (active.length === 1) return active[0]
      now = Date.now()
      if (now >= deadline) break
      await delay(0.1, options.signal)
      now = Date.now()
    }
    return undefined
  }

  const resolveWindow = async (
    connection: ComputerUseDriverConnection,
    args: Data,
    options: BackendCallOptions,
    starts: Map<number, string>,
  ): Promise<WindowRow> => {
    const target = targetFields(args)
    const requestedApp = typeof args.app === 'string' ? args.app.trim().toLowerCase() : ''
    let activePid: number | undefined
    if (target.pid === undefined && target.window_id === undefined && !requestedApp) {
      const apps = await connection.call('list_apps', {}, { timeoutMs: 10_000, signal: options.signal })
      const active = appRows(apps).find((row) => row.active === true && Number.isSafeInteger(row.pid))
      if (active) activePid = Number(active.pid)
    }
    const windows = await listWindows(connection, options)
    const matches = windows.filter((window) => {
      if (target.pid !== undefined && window.pid !== target.pid) return false
      if (target.window_id !== undefined && window.windowId !== target.window_id) return false
      if (requestedApp && window.app.trim().toLowerCase() !== requestedApp) return false
      return target.pid !== undefined || target.window_id !== undefined || requestedApp
        ? true
        : activePid !== undefined
          ? window.pid === activePid
          : window.active
    })
    const active = matches.filter((window) => window.active)
    const found = matches.length === 1 ? matches[0] : active.length === 1 ? active[0] : undefined
    if (!found) {
      if (target.pid !== undefined || target.window_id !== undefined)
        throw new Error(
          'Computer Use target window is no longer present; call list_windows and use only a window from that latest result',
        )
      throw new Error('Computer Use could not resolve one exact target window')
    }
    inspectAllowed(found.pid, starts)
    return found
  }

  const normalizeCapture = async (
    result: Awaited<ReturnType<ComputerUseDriverConnection['call']>>,
    mode: 'som' | 'vision' | 'ax',
    window: WindowRow,
  ): Promise<Data> => {
    if (result.isError) throw new Error('Computer Use capture failed')
    const raw = data(result.structuredContent, 'Computer Use capture result is invalid')
    const imageBlocks = result.content.filter((block) => block.type === 'image')
    const decoded = decodeSafeImages(imageBlocks, {
      maxBytesPerImage: input.profile.capture.maxBytesPerImage,
      maxPixelsPerImage: input.profile.capture.maxImageDimension ** 2,
      maxAggregateBytes: input.profile.capture.maxBytesPerImage,
      maxAggregatePixels: input.profile.capture.maxImageDimension ** 2,
    })
    if (mode === 'ax' && decoded.length > 0)
      throw new Error('Computer Use AX capture returned unexpected pixels')
    if (mode !== 'ax' && decoded.length !== 1)
      throw new Error('Computer Use capture returned an invalid image count')
    if (
      decoded.some(
        (image) =>
          image.width > input.profile.capture.maxImageDimension ||
          image.height > input.profile.capture.maxImageDimension,
      )
    )
      throw new Error('Computer Use capture exceeds the maximum image dimension')
    const safety = captureSafety(raw)
    const elements = captureElements(raw.elements)
    const snapshotId = raw.snapshot_id ?? raw.snapshotId
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || snapshotId.length === 0))
      throw new Error('Computer Use capture snapshot identity is invalid')
    const image = decoded[0]
    const ref = image
      ? await input.artifacts.put(image.bytes, {
          mime: image.mime,
          name: image.mime === 'image/png' ? 'computer-use-screenshot.png' : 'computer-use-screenshot.jpg',
        })
      : undefined
    return {
      content: result.content.flatMap((block) => (block.type === 'text' ? [{ ...block }] : [])),
      structuredContent: {
        mode,
        width: image?.width ?? window.bounds[2],
        height: image?.height ?? window.bounds[3],
        app: window.app,
        window_title: window.title,
        target: {
          app: window.app,
          pid: window.pid,
          window_id: window.windowId,
          ...(typeof snapshotId === 'string' ? { snapshot_id: snapshotId } : {}),
        },
        elements,
        ...(safety ? { safety } : {}),
        ...(image && ref
          ? {
              image: {
                ref,
                mime: image.mime,
                width: image.width,
                height: image.height,
                digest: ref.sha256,
              },
            }
          : {}),
      },
      isError: false,
    }
  }

  const normalizeDesktopCapture = async (
    result: Awaited<ReturnType<ComputerUseDriverConnection['call']>>,
    app: 'screen' | 'desktop',
  ): Promise<Data> => {
    if (result.isError) throw new Error('Computer Use full-desktop capture failed')
    const raw = data(result.structuredContent, 'Computer Use full-desktop capture result is invalid')
    const imageBlocks = result.content.filter((block) => block.type === 'image')
    const decoded = decodeSafeImages(imageBlocks, {
      maxBytesPerImage: input.profile.capture.maxBytesPerImage,
      maxPixelsPerImage: input.profile.capture.maxImageDimension ** 2,
      maxAggregateBytes: input.profile.capture.maxBytesPerImage,
      maxAggregatePixels: input.profile.capture.maxImageDimension ** 2,
    })
    if (decoded.length !== 1)
      throw new Error('Computer Use full-desktop capture returned an invalid image count')
    const image = decoded[0]
    if (
      !image ||
      image.width > input.profile.capture.maxImageDimension ||
      image.height > input.profile.capture.maxImageDimension
    )
      throw new Error(
        'Computer Use full-desktop capture exceeds the configured image limit; use an exact application window',
      )
    const declaredWidth = raw.screenshot_width
    const declaredHeight = raw.screenshot_height
    if (declaredWidth !== image.width || declaredHeight !== image.height)
      throw new Error('Computer Use full-desktop capture dimensions disagree with the image')
    const expectedPlatform =
      input.platform === 'win32' ? 'windows' : input.platform === 'darwin' ? 'macos' : 'linux'
    if (raw.platform !== expectedPlatform)
      throw new Error('Computer Use full-desktop capture returned the wrong platform')
    if (raw.display !== 'primary')
      throw new Error('Computer Use full-desktop capture returned an unsupported display')
    if (raw.screenshot_mime_type !== 'image/png' || image.mime !== 'image/png')
      throw new Error('Computer Use full-desktop capture returned an unsupported image type')
    const ref = await input.artifacts.put(image.bytes, {
      mime: image.mime,
      name: image.mime === 'image/png' ? 'computer-use-desktop.png' : 'computer-use-desktop.jpg',
    })
    return {
      content: result.content.flatMap((block) => (block.type === 'text' ? [{ ...block }] : [])),
      structuredContent: {
        mode: 'vision',
        width: image.width,
        height: image.height,
        app,
        target: { app },
        elements: [],
        note: 'Full-desktop capture is vision-only and read-only. Capture one exact allowed application window before input.',
        image: {
          ref,
          mime: image.mime,
          width: image.width,
          height: image.height,
          digest: ref.sha256,
        },
      },
      isError: false,
    }
  }

  const preflightDesktopCapture = async (
    connection: ComputerUseDriverConnection,
    cursorSession: string,
    options: BackendCallOptions,
  ): Promise<void> => {
    if (!connection.catalog.has('get_screen_size'))
      throw new Error('Computer Use driver catalog lacks get_screen_size')
    const result = await connection.call(
      'get_screen_size',
      { session: cursorSession },
      { timeoutMs: 10_000, signal: options.signal },
    )
    if (result.isError) throw new Error('Computer Use could not read the primary display size')
    const raw = data(result.structuredContent, 'Computer Use screen-size result is invalid')
    const width = raw.width
    const height = raw.height
    const scale = raw.scale_factor ?? 1
    if (
      typeof width !== 'number' ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      typeof height !== 'number' ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      typeof scale !== 'number' ||
      !Number.isFinite(scale) ||
      scale <= 0
    )
      throw new Error('Computer Use screen-size result is invalid')
    const physicalWidth = input.platform === 'darwin' ? Math.ceil(width * scale) : width
    const physicalHeight = input.platform === 'darwin' ? Math.ceil(height * scale) : height
    if (
      physicalWidth > input.profile.capture.maxImageDimension ||
      physicalHeight > input.profile.capture.maxImageDimension ||
      physicalWidth * physicalHeight > input.profile.capture.maxImageDimension ** 2
    )
      throw new Error(
        `Computer Use full-desktop capture is ${physicalWidth}x${physicalHeight}, above the configured ${input.profile.capture.maxImageDimension}px limit; use an exact application window`,
      )
  }

  const buildBackend = (
    connection: ComputerUseDriverConnection,
    session: ComputerUseSessionRef,
    cursorSession: string,
    starts: Map<number, string>,
  ): Backend => {
    const mode = runtime.permissionMode(session)
    const runtimePolicy: Backend['runtimePolicy'] =
      mode === 'bounded'
        ? Object.freeze({
            mode,
            authorization: 'reviewed-manifest' as const,
            sessionKey: session.key,
            lane: session.lane,
            capabilityManifestDigest: boundedManifest?.sha256 ?? '',
          })
        : mode === 'unrestricted'
          ? Object.freeze({
              mode,
              authorization: 'session-yolo' as const,
              sessionKey: session.key,
              lane: session.lane,
            })
          : Object.freeze({
              mode: 'standard' as const,
              authorization: 'driver-standard' as const,
              sessionKey: session.key,
              lane: session.lane,
            })
    return Object.freeze({
      profileHash: input.profileHash,
      generation: connection.generation,
      runtimePolicy,
      modifierActions: Object.freeze([
        'click' as const,
        'double_click' as const,
        'right_click' as const,
        'middle_click' as const,
        'drag' as const,
        'scroll' as const,
      ]),
      async call(args, options) {
        const action = args.action
        if (typeof action !== 'string') throw new Error('Computer Use action is invalid')
        if (action === 'wait') return delay(Number(args.seconds ?? 1), options.signal)
        if (action === 'list_apps') {
          const rows = await listAppRows(connection, options)
          const candidates = new Map(
            launchableCandidates(rows).map((candidate) => [candidate.stableId.toLowerCase(), candidate]),
          )
          const apps = rows.flatMap<Data>((row) => {
            if (row.pid > 0) {
              try {
                inspectAllowed(row.pid, starts)
              } catch {
                return []
              }
              const candidate = launchableCandidateForRow(row)
              return [
                {
                  app: row.name,
                  pid: row.pid,
                  frontmost: row.active,
                  ...(candidate ? { running: true, launchable: true } : {}),
                },
              ]
            }
            const candidate = launchableCandidateForRow(row)
            if (!candidate || !candidates.has(candidate.stableId.toLowerCase())) return []
            return [
              {
                app: candidate.name,
                app_id: candidate.stableId,
                running: false,
                launchable: true,
              },
            ]
          })
          return { structuredContent: { apps }, content: [], isError: false }
        }
        if (action === 'list_windows') {
          const windows = (await listWindows(connection, options)).flatMap((window) => {
            try {
              inspectAllowed(window.pid, starts)
            } catch {
              return []
            }
            return [
              {
                app: window.app,
                pid: window.pid,
                window_id: window.windowId,
                title: window.title,
                bounds: window.bounds,
              },
            ]
          })
          return { structuredContent: { windows }, content: [], isError: false }
        }
        if (action === 'capture') {
          const requestedApp = typeof args.app === 'string' ? args.app.trim().toLowerCase() : ''
          const desktopApp = FULL_DESKTOP_CAPTURE_APPS.has(requestedApp)
            ? (requestedApp as 'screen' | 'desktop')
            : undefined
          if (desktopApp) {
            if (!input.profile.capture.allowFullDesktop)
              throw new Error('Computer Use full-desktop capture is disabled')
            if (args.mode === 'ax')
              throw new Error('Computer Use full-desktop capture is vision-only; use mode=vision or mode=som')
            if (!connection.catalog.has('get_desktop_state'))
              throw new Error('Computer Use driver catalog lacks get_desktop_state')
            await preflightDesktopCapture(connection, cursorSession, options)
            const result = await connection.call(
              'get_desktop_state',
              { session: cursorSession },
              { timeoutMs: 20_000, signal: options.signal },
            )
            return normalizeDesktopCapture(result, desktopApp)
          }
          const window = await resolveWindow(connection, args, options, starts)
          const mode = args.mode === 'ax' || args.mode === 'vision' ? args.mode : 'som'
          const result = await connection.call(
            'get_window_state',
            {
              session: cursorSession,
              pid: window.pid,
              window_id: window.windowId,
              include_accessibility_tree: mode !== 'vision',
              include_screenshot: mode !== 'ax',
              max_dimension: input.profile.capture.maxImageDimension,
            },
            { timeoutMs: 20_000, signal: options.signal },
          )
          return normalizeCapture(result, mode, window)
        }

        if (action === 'launch_app') {
          if (!connection.catalog.has('launch_app'))
            throw new Error('Computer Use driver catalog lacks launch_app')
          const resolution = await resolveLaunchCandidate(connection, args, options)
          if (!resolution.ok)
            return {
              structuredContent: { ok: false, action, code: resolution.code, message: resolution.message },
              content: [],
              isError: true,
            }
          const candidate = resolution.candidate
          const priorWindows = new Set(
            (await listWindows(connection, options)).map((window) => `${window.pid}:${window.windowId}`),
          )
          const browserArguments = browserLaunchArguments(candidate, input.platform)
          const invocation = {
            ...candidate.invocation,
            ...(browserArguments ? { additional_arguments: [...browserArguments] } : {}),
            ...(input.platform === 'darwin' && browserArguments
              ? { creates_new_application_instance: true }
              : {}),
          }
          const launched = await connection.call('launch_app', invocation as JsonValue, {
            timeoutMs: 20_000,
            signal: options.signal,
          })
          if (launched.isError)
            return {
              structuredContent: {
                ok: false,
                action,
                code: 'launch_failed',
                message: 'The operating system rejected the application launch.',
              },
              content: [],
              isError: true,
            }
          const launchedWindow = await findLaunchedWindow(
            connection,
            candidate,
            options,
            starts,
            priorWindows,
          )
          return {
            structuredContent: {
              ok: true,
              action,
              effect: launchedWindow ? 'confirmed' : 'unverifiable',
              ...(launchedWindow
                ? {
                    target: {
                      app: launchedWindow.app,
                      pid: launchedWindow.pid,
                      window_id: launchedWindow.windowId,
                    },
                  }
                : {
                    message:
                      'The launch request succeeded, but no single admitted window appeared within five seconds. Call list_windows before continuing and do not repeat the launch.',
                  }),
            },
            content: [],
            isError: false,
          }
        }

        let window: WindowRow | undefined
        if (action === 'focus_app') window = await resolveWindow(connection, args, options, starts)
        else {
          const target = targetFields(args)
          if (typeof target.pid !== 'number') throw new Error('Computer Use input lacks a captured target')
          if (typeof target.window_id !== 'number')
            throw new Error('Computer Use input lacks an exact captured window')
          inspectAllowed(target.pid, starts)
          const currentWindow = (await listWindows(connection, options)).find(
            (candidate) => candidate.pid === target.pid && candidate.windowId === target.window_id,
          )
          if (!currentWindow) throw new Error('Computer Use captured window identity changed')
          inspectAllowed(currentWindow.pid, starts)
        }
        const base: Data = { ...elementFields(args), session: cursorSession }
        const point = coordinate(args.coordinate, 'Computer Use coordinate is invalid')
        if (point) Object.assign(base, { x: point[0], y: point[1] })
        if (Array.isArray(args.modifiers) && args.modifiers.length) base.modifier = [...args.modifiers]
        if (args.delivery_mode === 'background' || args.delivery_mode === 'foreground')
          base.delivery_mode = args.delivery_mode
        let tool = action
        if (action === 'focus_app') {
          if (args.raise_window !== true)
            return {
              structuredContent: {
                ok: true,
                action,
                effect: 'confirmed',
                target: { app: window?.app, pid: window?.pid, window_id: window?.windowId },
              },
              content: [],
              isError: false,
            }
          tool = 'bring_to_front'
          Object.assign(base, { pid: window?.pid, window_id: window?.windowId })
        } else if (action === 'middle_click') tool = 'click'
        if (action === 'type') {
          tool = 'type_text'
          base.text = args.text
        } else if (action === 'key') {
          const keys = String(args.keys ?? '')
            .split(/[+\s]+/u)
            .filter(Boolean)
          if (keys.length > 1) {
            tool = 'hotkey'
            base.keys = keys
          } else {
            tool = 'press_key'
            base.key = keys[0]
          }
        } else if (action === 'set_value') base.value = args.value
        else if (action === 'scroll') {
          base.direction = args.direction
          base.amount = args.amount
        } else if (action === 'drag') {
          const from = coordinate(args.from_coordinate, 'Computer Use drag origin is invalid')
          const to = coordinate(args.to_coordinate, 'Computer Use drag destination is invalid')
          if (!from || !to) throw new Error('Computer Use driver requires coordinate drag targets')
          Object.assign(base, { from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] })
        }
        if (['click', 'double_click', 'right_click', 'drag'].includes(tool)) base.button = args.button
        const result = await connection.call(tool, base as JsonValue, {
          timeoutMs: 20_000,
          signal: options.signal,
        })
        const envelope = resultEnvelope(result)
        if (action === 'focus_app' && !result.isError)
          envelope.structuredContent = {
            ...(data(envelope.structuredContent ?? {}, 'Computer Use focus result is invalid') as Data),
            ok: true,
            action,
            target: { app: window?.app, pid: window?.pid, window_id: window?.windowId },
          }
        return envelope
      },
    })
  }

  return Object.freeze({
    async acquire(session, signal) {
      const key = sessionKey(session)
      const lifecycle = lifecycleTasks.get(key)
      if (lifecycle) await lifecycle.catch(() => undefined)
      if (disposed) throw new Error('Computer Use backend provider is disposed')
      if (signal.aborted) throw new DOMException('Computer Use request cancelled', 'AbortError')
      const existing = backends.get(key)
      if (existing) return existing
      const opening = openingBackends.get(key)
      if (opening) return opening
      const lifecycleGeneration = lifecycleGenerations.get(key) ?? 0
      const lifetime = new AbortController()
      lifetimeControllers.set(key, lifetime)
      const task = (async () => {
        startAttempted = true
        const connection = await runtime.open(session, lifetime.signal)
        if (disposed || (lifecycleGenerations.get(key) ?? 0) !== lifecycleGeneration) {
          await runtime.close(session, 'session_end').catch(() => undefined)
          throw new Error('Computer Use backend lifecycle changed while opening')
        }
        let cursorSession: string
        try {
          cursorSession = await startAgentCursorSession(connection, lifetime.signal)
        } catch (error) {
          try {
            await runtime.close(session, 'session_end')
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Computer Use cursor startup cleanup failed')
          }
          throw error
        }
        if (disposed || (lifecycleGenerations.get(key) ?? 0) !== lifecycleGeneration) {
          await endAgentCursorSession(connection, cursorSession).catch(() => undefined)
          await runtime.close(session, 'session_end').catch(() => undefined)
          throw new Error('Computer Use backend lifecycle changed while opening')
        }
        const starts = new Map<number, string>()
        const backend = buildBackend(connection, session, cursorSession, starts)
        connections.set(key, connection)
        cursorSessions.set(key, cursorSession)
        processStarts.set(key, starts)
        backends.set(key, backend)
        connection.onClose(() => {
          if (connections.get(key) !== connection) return
          connections.delete(key)
          cursorSessions.delete(key)
          processStarts.delete(key)
          backends.delete(key)
          const activeLifetime = lifetimeControllers.get(key)
          if (activeLifetime === lifetime) {
            lifetimeControllers.delete(key)
            activeLifetime.abort()
          }
        })
        return backend
      })()
      openingBackends.set(key, task)
      try {
        return await task
      } finally {
        if (openingBackends.get(key) === task) openingBackends.delete(key)
        if (!backends.has(key) && lifetimeControllers.get(key) === lifetime) {
          lifetimeControllers.delete(key)
          lifetime.abort()
        }
      }
    },
    async release(session) {
      if (disposed) return
      const key = sessionKey(session)
      return runLifecycle(key, async () => {
        lifecycleGenerations.set(key, (lifecycleGenerations.get(key) ?? 0) + 1)
        const opening = openingBackends.get(key)
        const connection = connections.get(key)
        const cursorSession = cursorSessions.get(key)
        const lifetime = lifetimeControllers.get(key)
        let cursorError: unknown
        if (connection && cursorSession)
          try {
            await endAgentCursorSession(connection, cursorSession)
          } catch (error) {
            cursorError = error
          }
        let closeError: unknown
        try {
          await runtime.close(session, 'session_end')
        } catch (error) {
          closeError = error
        }
        await opening?.catch(() => undefined)
        if (openingBackends.get(key) === opening) openingBackends.delete(key)
        connections.delete(key)
        cursorSessions.delete(key)
        processStarts.delete(key)
        backends.delete(key)
        lifetimeControllers.delete(key)
        lifetime?.abort()
        if (cursorError && closeError)
          throw new AggregateError([cursorError, closeError], 'Computer Use session cleanup failed')
        if (cursorError) throw cursorError
        if (closeError) throw closeError
      })
    },
    async setPermissionMode(session, mode) {
      if (mode === 'bounded' && !boundedManifest)
        throw new Error('Computer Use bounded mode requires a reviewed capability manifest')
      if (disposed) throw new Error('Computer Use backend provider is disposed')
      const key = sessionKey(session)
      return runLifecycle(key, async () => {
        // The runtime intentionally keeps an existing transport when the mode is unchanged. Mirror
        // that idempotence here; tearing down only the provider maps would orphan the live transport.
        if (runtime.permissionMode(session) === mode) return
        lifecycleGenerations.set(key, (lifecycleGenerations.get(key) ?? 0) + 1)
        const opening = openingBackends.get(key)
        const connection = connections.get(key)
        const cursorSession = cursorSessions.get(key)
        const lifetime = lifetimeControllers.get(key)
        let cursorError: unknown
        if (connection && cursorSession)
          try {
            await endAgentCursorSession(connection, cursorSession)
          } catch (error) {
            cursorError = error
          }
        let modeError: unknown
        try {
          await runtime.setPermissionMode(session, mode)
        } catch (error) {
          modeError = error
        }
        await opening?.catch(() => undefined)
        if (openingBackends.get(key) === opening) openingBackends.delete(key)
        connections.delete(key)
        cursorSessions.delete(key)
        processStarts.delete(key)
        backends.delete(key)
        lifetimeControllers.delete(key)
        lifetime?.abort()
        if (cursorError && modeError)
          throw new AggregateError([cursorError, modeError], 'Computer Use mode change cleanup failed')
        if (cursorError) throw cursorError
        if (modeError) throw modeError
      })
    },
    status() {
      return Object.freeze({ activeSessions: connections.size, startAttempted })
    },
    dispose() {
      if (disposeTask) return disposeTask
      disposed = true
      disposeTask = (async () => {
        const lifetimes = [...lifetimeControllers.values()]
        await Promise.allSettled([...lifecycleTasks.values()])
        const opening = [...openingBackends.values()]
        const cursorOutcomes = await Promise.allSettled(
          [...connections.entries()].map(async ([key, connection]) => {
            const cursorSession = cursorSessions.get(key)
            if (cursorSession) await endAgentCursorSession(connection, cursorSession)
          }),
        )
        let disposeError: unknown
        try {
          await runtime.dispose()
        } catch (error) {
          disposeError = error
        }
        // The callers awaiting an interrupted acquire receive its exact failure. Runtime.dispose()
        // already reports cleanup failures, so a controlled opening cancellation must not make the
        // provider's own shutdown fail a second time.
        await Promise.allSettled(opening)
        openingBackends.clear()
        lifecycleGenerations.clear()
        lifecycleTasks.clear()
        connections.clear()
        cursorSessions.clear()
        processStarts.clear()
        backends.clear()
        for (const lifetime of lifetimes) lifetime.abort()
        lifetimeControllers.clear()
        const failures = cursorOutcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason] : [],
        )
        if (disposeError) failures.push(disposeError)
        if (failures.length) throw new AggregateError(failures, 'Computer Use provider cleanup failed')
      })()
      return disposeTask
    },
  })
}
