import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

export type PowerShellRequest = 'auto' | '5.1' | '7' | Readonly<{ path: string }>
export type PowerShellDescriptor = Readonly<{
  path: string
  version: string
  edition: 'Desktop' | 'Core'
  nativeArguments: 'Legacy' | 'Standard' | 'Windows'
  /**
   * The code page a new console starts in, which is what a program that does not write UTF-8 writes
   * to a pipe. Command output that is not UTF-8 is decoded in it.
   */
  codePage?: number
}>
export type PowerShellCandidate = Readonly<{ path: string; family: '5.1' | '7' }>
type Probe = (path: string) => Promise<PowerShellDescriptor>

/** Shared by runtime assembly and read-only diagnostics; callers provide the effective environment. */
export function resolveConfiguredPowerShell(env: NodeJS.ProcessEnv): Promise<PowerShellDescriptor> {
  const request = env.AGNES_POWERSHELL ?? 'auto'
  return resolvePowerShell(
    request === 'auto' || request === '5.1' || request === '7' ? request : { path: request },
    powerShellCandidates(env),
  )
}

const execute = promisify(execFile)
// The probe runs in a new console as a command does, so the code page it reads before switching
// to UTF-8 is the one a command's console starts in.
const probeScript = [
  "$ErrorActionPreference = 'Stop'",
  '$codePage = [Console]::OutputEncoding.CodePage',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  "$mode = 'Legacy'",
  'if (Test-Path variable:PSNativeCommandArgumentPassing) { $mode = [string]$PSNativeCommandArgumentPassing }',
  '@{ path = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;',
  'version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition;',
  'nativeArguments = $mode; codePage = $codePage } | ConvertTo-Json -Compress',
].join('\n')

const absolutePath = (path: string): boolean =>
  win32.isAbsolute(path) && win32.parse(path).root.length > 1 && !path.includes('\0')
const usablePath = (path: string): boolean => absolutePath(path) && /\.exe$/i.test(path)

/** No raw shell output is included: a profile or failed executable may print credentials. */
export class PowerShellUnavailable extends Error {
  readonly code = 'E_POWERSHELL_UNAVAILABLE'
  constructor(readonly attempts: ReadonlyArray<Readonly<{ path: string; reason: string }>>) {
    super('No requested PowerShell executable passed the version probe')
  }
}

function checked(value: unknown): PowerShellDescriptor {
  if (!value || typeof value !== 'object') throw new Error('invalid-probe')
  const d = value as Record<string, unknown>
  if (
    typeof d.path !== 'string' ||
    !usablePath(d.path) ||
    typeof d.version !== 'string' ||
    !/^(?:5\.1\.\d+(?:\.\d+)?|7\.\d+\.\d+(?:\.\d+)?)$/.test(d.version) ||
    (d.edition !== 'Desktop' && d.edition !== 'Core') ||
    (d.nativeArguments !== 'Legacy' && d.nativeArguments !== 'Standard' && d.nativeArguments !== 'Windows') ||
    (d.version.startsWith('5.1.') && (d.edition !== 'Desktop' || d.nativeArguments !== 'Legacy')) ||
    (d.version.startsWith('7.') && d.edition !== 'Core')
  )
    throw new Error('invalid-probe')
  // Only output decoding depends on the code page, so a value that is not one is left out rather
  // than failing the shell.
  const codePage =
    typeof d.codePage === 'number' && Number.isInteger(d.codePage) && d.codePage > 0 && d.codePage < 65536
      ? d.codePage
      : undefined
  return Object.freeze({
    path: d.path,
    version: d.version,
    edition: d.edition,
    nativeArguments: d.nativeArguments,
    ...(codePage === undefined ? {} : { codePage }),
  })
}

export async function probePowerShell(path: string): Promise<PowerShellDescriptor> {
  if (!usablePath(path)) throw new PowerShellUnavailable([{ path, reason: 'invalid-path' }])
  try {
    const { stdout } = await execute(
      path,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        Buffer.from(probeScript, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384, windowsHide: true },
    )
    return checked(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
  } catch {
    throw new PowerShellUnavailable([{ path, reason: 'probe-failed' }])
  }
}

/** Absolute candidates avoid CreateProcess's implicit search of the current working directory. */
export function powerShellCandidates(env: NodeJS.ProcessEnv): PowerShellCandidate[] {
  const variable = (name: string): string | undefined =>
    Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const dirs = (variable('PATH') ?? '')
    .split(';')
    .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
    .filter(absolutePath)
  const result: PowerShellCandidate[] = []
  const seen = new Set<string>()
  const add = (path: string, family: PowerShellCandidate['family']) => {
    const key = path.toLowerCase()
    if (!usablePath(path) || seen.has(key)) return
    seen.add(key)
    result.push({ path, family })
  }
  for (const dir of dirs) add(win32.join(dir, 'pwsh.exe'), '7')
  const programs = variable('ProgramFiles')
  if (programs) add(win32.join(programs, 'PowerShell', '7', 'pwsh.exe'), '7')
  const system = variable('SystemRoot')
  if (system) add(win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '5.1')
  for (const dir of dirs) add(win32.join(dir, 'powershell.exe'), '5.1')
  return result
}

/** Selection has no effect on an existing session until Host explicitly binds this descriptor. */
export async function resolvePowerShell(
  request: PowerShellRequest,
  candidates: readonly PowerShellCandidate[],
  probe: Probe = probePowerShell,
): Promise<PowerShellDescriptor> {
  const selected =
    typeof request === 'object'
      ? [{ path: request.path, family: undefined }]
      : candidates
          .filter((candidate) => request === 'auto' || candidate.family === request)
          .sort((a, b) => (a.family === b.family ? 0 : a.family === '7' ? -1 : 1))
  const attempts: Array<{ path: string; reason: string }> = []
  for (const candidate of selected) {
    if (!usablePath(candidate.path)) {
      attempts.push({ path: candidate.path, reason: 'invalid-path' })
      continue
    }
    try {
      const descriptor = checked(await probe(candidate.path))
      if (candidate.family && !descriptor.version.startsWith(candidate.family === '7' ? '7.' : '5.1.')) {
        attempts.push({ path: candidate.path, reason: 'version-mismatch' })
        continue
      }
      return descriptor
    } catch {
      attempts.push({ path: candidate.path, reason: 'probe-failed' })
    }
  }
  throw new PowerShellUnavailable(attempts)
}
