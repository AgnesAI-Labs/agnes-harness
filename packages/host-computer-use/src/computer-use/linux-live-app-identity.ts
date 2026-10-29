import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ComputerUseResolvedAppIdentity } from './app-admission.js'

export type LinuxLiveAppIdentity = Extract<ComputerUseResolvedAppIdentity, { platform: 'linux' }>
export type LinuxDesktopAppIdentity = Readonly<{
  desktopId: string
  executablePath: string
  installSource: string
  launchPath: string
}>

const MAX_DESKTOP_FILE_BYTES = 256 * 1024
const MAX_DESKTOP_FILES = 4096
const MAX_DESKTOP_DEPTH = 8
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u

function desktopRoots(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = environment.HOME
  const user = environment.XDG_DATA_HOME ?? (home ? join(home, '.local', 'share') : undefined)
  const system = (environment.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [user, ...system]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value, 'applications'))
}

function desktopId(root: string, path: string): string | undefined {
  const rel = relative(root, path)
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.endsWith('.desktop')) return undefined
  const id = rel.slice(0, -'.desktop'.length).split(sep).join('-')
  return TOKEN.test(id) ? id : undefined
}

function entryValue(text: string, key: string): string | undefined {
  let inDesktopEntry = false
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inDesktopEntry = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inDesktopEntry || trimmed.startsWith('#')) continue
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim()
  }
  return undefined
}

function firstExecToken(value: string): string | undefined {
  let token = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const char of value.trim()) {
    if (escaped) {
      token += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) break
    token += char
  }
  if (escaped || quote || !token || token.startsWith('%') || token.includes('\0')) return undefined
  return token
}

function stripExecFieldCodes(value: string): string {
  let result = ''
  const characters = [...value]
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] === '%') {
      index += 1
      continue
    }
    result += characters[index]
  }
  return result.trim()
}

function executablePath(command: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? '/usr/local/bin:/usr/bin:/bin')
        .split(':')
        .filter(Boolean)
        .map((directory) => join(directory, command))
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate)
      const stat = lstatSync(canonical)
      if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0) return canonical
    } catch {
      // Continue through PATH; absence and broken links are not stable identities.
    }
  }
  return undefined
}

function readDesktopIdentity(
  root: string,
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): LinuxDesktopAppIdentity | undefined {
  try {
    const source = realpathSync(path)
    const stat = lstatSync(source)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_DESKTOP_FILE_BYTES ||
      source.length > 1024
    )
      return undefined
    const id = desktopId(root, path)
    if (!id) return undefined
    const text = readFileSync(source, 'utf8')
    const type = entryValue(text, 'Type')
    if (
      (type !== undefined && type !== 'Application') ||
      entryValue(text, 'Hidden')?.toLowerCase() === 'true' ||
      entryValue(text, 'NoDisplay')?.toLowerCase() === 'true'
    )
      return undefined
    const rawLaunchPath = entryValue(text, 'Exec')
    const launchPath = rawLaunchPath ? stripExecFieldCodes(rawLaunchPath) : undefined
    if (!launchPath || launchPath.length > 4096 || launchPath.includes('\0')) return undefined
    const command = firstExecToken(launchPath)
    const executable = command ? executablePath(command, environment) : undefined
    if (!executable || executable.length > 4096) return undefined
    return Object.freeze({ desktopId: id, executablePath: executable, installSource: source, launchPath })
  } catch {
    return undefined
  }
}

function desktopFiles(root: string): readonly string[] {
  try {
    const files: string[] = []
    const walk = (directory: string, depth: number): void => {
      if (depth > MAX_DESKTOP_DEPTH)
        throw new Error('Computer Use Linux desktop application tree is too deep')
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(path, depth + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.desktop')) continue
        files.push(path)
        if (files.length > MAX_DESKTOP_FILES)
          throw new Error('Computer Use Linux desktop application tree is too large')
      }
    }
    walk(root, 0)
    return files
  } catch {
    return []
  }
}

function effectiveDesktopApps(
  environment: NodeJS.ProcessEnv = process.env,
): readonly LinuxDesktopAppIdentity[] {
  const seen = new Set<string>()
  const identities: LinuxDesktopAppIdentity[] = []
  for (const root of desktopRoots(environment)) {
    for (const path of desktopFiles(root)) {
      const id = desktopId(root, path)
      if (!id || seen.has(id)) continue
      // A higher-precedence entry shadows the same desktop id even when malformed or hidden.
      seen.add(id)
      const identity = readDesktopIdentity(root, path, environment)
      if (identity) identities.push(identity)
    }
  }
  return identities
}

/** Resolves an XDG desktop id to one canonical launcher and executable using XDG precedence. */
export function linuxDesktopAppIdentitySync(
  requestedDesktopId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LinuxDesktopAppIdentity | undefined {
  if (!TOKEN.test(requestedDesktopId)) return undefined
  return effectiveDesktopApps(environment).find((identity) => identity.desktopId === requestedDesktopId)
}

function processStartTime(pid: number): string {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(boot))
    throw new Error('Computer Use Linux boot identity is invalid')
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  if (Buffer.byteLength(stat) > 8192 || !stat.startsWith(`${pid} (`))
    throw new Error('Computer Use Linux process identity is invalid')
  const end = stat.lastIndexOf(')')
  const fields =
    end < 0
      ? []
      : stat
          .slice(end + 2)
          .trim()
          .split(/\s+/u)
  const ticks = fields[19]
  if (!ticks || !/^[0-9]{1,20}$/u.test(ticks) || BigInt(ticks) > 18_446_744_073_709_551_615n)
    throw new Error('Computer Use Linux process start time is invalid')
  return `linux:${boot}:${pid}:${ticks}`
}

/** Re-attests /proc executable and the unique XDG launcher before every target operation. */
export function linuxLiveAppIdentitySync(pid: number): LinuxLiveAppIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
    throw new Error('Computer Use Linux process id is invalid')
  const started = processStartTime(pid)
  const executable = realpathSync(readlinkSync(`/proc/${pid}/exe`))
  const matches = new Map<string, LinuxDesktopAppIdentity>()
  for (const identity of effectiveDesktopApps())
    if (identity.executablePath === executable) matches.set(identity.desktopId, identity)
  if (matches.size !== 1)
    throw new Error('Computer Use Linux target has no unique installed desktop identity')
  const identity = [...matches.values()][0] as LinuxDesktopAppIdentity
  // Close PID reuse and executable replacement races around filesystem/XDG inspection.
  if (processStartTime(pid) !== started || realpathSync(readlinkSync(`/proc/${pid}/exe`)) !== executable)
    throw new Error('Computer Use Linux process identity changed during inspection')
  return Object.freeze({ platform: 'linux', ...identity, processStartTime: started })
}
