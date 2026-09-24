import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { createPlatform } from '@agnes/host'
import type { WorkspacePicker, WorkspacePickerResult } from '@agnes/web/server'

const MAX_OUTPUT_BYTES = 16 * 1024

export type PickerCommandResult = Readonly<{ exitCode: number | null; stdout: string }>
export type PickerCommandRunner = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
) => Promise<PickerCommandResult>

export type NativeWorkspacePickerOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: PickerCommandRunner
  findExecutable?: (candidates: readonly string[]) => Promise<string | undefined>
}

type PickerBackend = Readonly<{
  executable: string
  args: readonly string[]
  decode(result: PickerCommandResult): WorkspacePickerResult
}>

const macScript = `
tell application "Finder"
  activate
  try
    set chosenFolder to choose folder with prompt "选择 Agnes 工作区"
    return "selected" & linefeed & POSIX path of chosenFolder
  on error number -128
    return "cancelled"
  end try
end tell`.trim()

const windowsScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
  $dialog.Description = '选择 Agnes 工作区'
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $result = @{ status = 'selected'; path = $dialog.SelectedPath }
  } else {
    $result = @{ status = 'cancelled' }
  }
} catch {
  $result = @{ status = 'unavailable' }
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`.trim()

export const runPickerCommand: PickerCommandRunner = (executable, args, signal, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      signal,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }
    child.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        fail(new Error('workspace picker output exceeded its limit'))
        return
      }
      chunks.push(chunk)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString('utf8') })
    })
  })

function structured(
  result: PickerCommandResult,
  absolute: (value: string) => boolean,
): WorkspacePickerResult {
  if (result.exitCode !== 0) return { status: 'unavailable' }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { status?: unknown; path?: unknown }
    if (parsed.status === 'cancelled') return { status: 'cancelled' }
    if (parsed.status !== 'selected' || typeof parsed.path !== 'string') return { status: 'unavailable' }
    if (
      parsed.path.length === 0 ||
      parsed.path.length > 4096 ||
      parsed.path.includes('\0') ||
      !absolute(parsed.path)
    )
      return { status: 'unavailable' }
    return { status: 'selected', path: parsed.path }
  } catch {
    return { status: 'unavailable' }
  }
}

function pickerEnvironment(platform: NodeJS.Platform, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = [
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'PATH',
    ...(platform === 'linux'
      ? ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
      : []),
    ...(platform === 'win32'
      ? ['SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']
      : []),
  ]
  return Object.fromEntries(
    names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name] as string]])),
  )
}

function desktopResult(result: PickerCommandResult): WorkspacePickerResult {
  if (result.exitCode === 1) return { status: 'cancelled' }
  if (result.exitCode !== 0) return { status: 'unavailable' }
  const path = result.stdout.replace(/\r?\n$/, '')
  if (path.length === 0 || path.length > 4096 || path.includes('\0') || !posix.isAbsolute(path))
    return { status: 'unavailable' }
  return { status: 'selected', path }
}

function macResult(result: PickerCommandResult): WorkspacePickerResult {
  if (result.exitCode !== 0) return { status: 'unavailable' }
  const output = result.stdout.replace(/\r?\n$/, '')
  if (output === 'cancelled') return { status: 'cancelled' }
  if (!output.startsWith('selected\n')) return { status: 'unavailable' }
  const path = output.slice('selected\n'.length)
  if (path.length === 0 || path.length > 4096 || path.includes('\0') || !posix.isAbsolute(path))
    return { status: 'unavailable' }
  return { status: 'selected', path }
}

async function defaultFindExecutable(
  candidates: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathApi = platform === 'win32' ? win32 : posix
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const directories = (env.PATH ?? '').split(pathDelimiter).filter(Boolean)
  for (const candidate of candidates) {
    const paths =
      pathApi.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')
        ? [candidate]
        : directories.map((directory) => pathApi.join(directory, candidate))
    for (const path of paths) {
      try {
        await access(path, constants.X_OK)
        return path
      } catch {
        // Keep looking; unavailable desktop helpers are an expected fallback condition.
      }
    }
  }
  return undefined
}

/** Platform seam for the loopback Web launcher; callers can inject every OS dependency in tests. */
export function createNativeWorkspacePicker(options: NativeWorkspacePickerOptions = {}): WorkspacePicker {
  const platform = options.platform ?? createPlatform().os
  const env = options.env ?? process.env
  const run = options.run ?? runPickerCommand
  const childEnv = pickerEnvironment(platform, env)
  const find = options.findExecutable ?? ((candidates) => defaultFindExecutable(candidates, platform, env))
  let backendPromise: Promise<PickerBackend | undefined> | undefined

  const backend = (): Promise<PickerBackend | undefined> =>
    (backendPromise ??= (async () => {
      if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return undefined
      if (platform === 'darwin') {
        const executable = await find(['/usr/bin/osascript', 'osascript'])
        return executable
          ? {
              executable,
              args: ['-e', macScript],
              decode: macResult,
            }
          : undefined
      }
      if (platform === 'win32') {
        const systemPowerShell = env.SystemRoot
          ? win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : undefined
        const executable = await find(
          [systemPowerShell, 'powershell.exe', 'pwsh.exe'].filter(
            (value): value is string => value !== undefined,
          ),
        )
        return executable
          ? {
              executable,
              args: [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-STA',
                '-EncodedCommand',
                Buffer.from(windowsScript, 'utf16le').toString('base64'),
              ],
              decode: (result) => structured(result, win32.isAbsolute),
            }
          : undefined
      }
      if (platform === 'linux') {
        if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined
        const zenity = await find(['zenity'])
        if (zenity)
          return {
            executable: zenity,
            args: ['--file-selection', '--directory', '--title=选择 Agnes 工作区'],
            decode: desktopResult,
          }
        const kdialog = await find(['kdialog'])
        if (kdialog)
          return {
            executable: kdialog,
            args: ['--getexistingdirectory', env.HOME ?? '/', '--title', '选择 Agnes 工作区'],
            decode: desktopResult,
          }
      }
      return undefined
    })())

  return {
    available: async () => (await backend()) !== undefined,
    pick: async (signal) => {
      const selected = await backend()
      if (!selected) return { status: 'unavailable' }
      try {
        return selected.decode(await run(selected.executable, selected.args, signal, childEnv))
      } catch {
        return { status: 'unavailable' }
      }
    },
  }
}
