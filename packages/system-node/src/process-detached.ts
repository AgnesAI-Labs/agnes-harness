import { win32 } from 'node:path'
import { type OwnedDetachedProcess, windowsEnvironmentNamesEqual, windowsSpawnDetachedSync } from './index.js'

// Match libuv 1.51's essential environment fallback, not an unrestricted parent-env merge.
const required = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]
const invalid = () => Object.assign(new Error('Invalid Windows detached process input'), { code: 'EINVAL' })
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid()
}
/** CRT argv quoting; no shell expansion, including empty arguments and trailing backslashes. */
export function windowsDetachedCommand(executable: string, argv: readonly string[]): string {
  const values = [executable, ...argv]
  for (const value of values) text(value)
  const command = values
    .map((value) => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`)
    .join(' ')
  if (command.length > 32766) throw invalid()
  return command
}
/** Native sorts the completed UTF-16 block using Windows ordinal comparison. */
export function windowsDetachedEnvironment(
  env: NodeJS.ProcessEnv,
  parent: NodeJS.ProcessEnv = process.env,
): string {
  const selected: NodeJS.ProcessEnv = Object.create(null)
  for (const key in env) selected[key] = env[key]
  // Match Node's exact own-property test before its case-insensitive deduplication.
  if (!Object.hasOwn(env, 'NODE_V8_COVERAGE') && parent.NODE_V8_COVERAGE)
    selected.NODE_V8_COVERAGE = parent.NODE_V8_COVERAGE
  const keys: string[] = []
  for (const key in selected) keys.push(key)
  const seen = new Set<string>()
  const entries: Array<[string, string]> = []
  for (const key of keys.sort()) {
    // Match Node's first-lexicographic-key behavior, even if that key is undefined.
    const folded = key.toUpperCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    const value = selected[key]
    if (value === undefined) continue
    text(key)
    text(value)
    if (!key || key.includes('=')) throw invalid()
    entries.push([key, value])
  }
  for (const name of required) {
    if (entries.some(([key]) => windowsEnvironmentNamesEqual(key, name))) continue
    const key = Object.keys(parent).find((key) => windowsEnvironmentNamesEqual(key, name))
    const value = key === undefined ? undefined : parent[key]
    if (value !== undefined && value !== '') {
      text(value)
      entries.push([name, value])
    }
  }
  const block = `${entries.map(([key, value]) => `${key}=${value}`).join('\0')}\0\0`
  if (block.length > 1048576) throw invalid()
  return block
}
/** Caller owns this handle and must close it after readiness or failed-start cleanup. */
export function createWindowsDetachedProcess(
  executable: string,
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): OwnedDetachedProcess {
  // Native CreateProcess would bypass Node's child/propagated-permission checks.
  if (process.permission)
    throw Object.assign(new Error('Detached startup under Node permission mode is not supported'), {
      code: 'E_NODE_PERMISSION_UNSUPPORTED',
    })
  text(executable)
  text(options.cwd)
  if ([executable, options.cwd].some((path) => !win32.isAbsolute(path) || win32.parse(path).root.length < 2))
    throw invalid()
  return windowsSpawnDetachedSync(
    executable,
    windowsDetachedCommand(executable, argv),
    options.cwd,
    windowsDetachedEnvironment(options.env),
  )
}
