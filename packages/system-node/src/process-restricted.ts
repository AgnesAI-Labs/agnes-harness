// Write-restricted launch parameters for the Windows Job gate. The broker the Host has already
// assigned to the command's Job creates the target suspended with a restricted Low integrity token
// (native/process-restricted.h); the Host resumes it only after proving it is in that Job.
import { windowsCommand } from '../runtime/windows-command.mjs'
import { windowsDetachedCommand, windowsDetachedEnvironment } from './process-detached.js'
import { windowsWriteSid } from './windows-acl.js'

/**
 * What one restricted launch may write with. `writeSids` are the capability SIDs of the grants the
 * token may use (the workspace grant's, then the private temp's); a read-only launch has none.
 * Only sealWindowsConfinement creates an accepted value, and each value starts one launch.
 */
export type WindowsConfinement = Readonly<{
  mode: 'read-only' | 'workspace-write'
  /** Workspace root the grant covers. */
  root: string
  writeSids: readonly string[]
  /** Private temp directory; the target's TEMP and TMP point here. */
  tempRoot?: string
}>

/** Native launch input; the broker passes it to the restricted launch unchanged. */
export type RestrictedLaunch = {
  application: string
  commandLine: string
  /** Complete UTF-16 environment block. */
  environment: string
  writeSids: string[]
  readOnly: boolean
}

const sealed = new WeakSet<object>()
const invalid = (message: string): TypeError => Object.assign(new TypeError(message), { code: 'EINVAL' })

function drivePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32_000 &&
    !value.includes('\0') &&
    /^[A-Za-z]:[\\/]/.test(value) &&
    !value.slice(2).includes(':')
  )
}

/**
 * Seals the launch parameters a Host redeemed from its execution lease. Copies, deserialized or
 * otherwise rebuilt objects are refused by startWindowsJobProcess, and so is a second use.
 */
export function sealWindowsConfinement(input: WindowsConfinement): WindowsConfinement {
  if (typeof input !== 'object' || input === null) throw invalid('Invalid Windows confinement')
  const { mode, root, writeSids, tempRoot } = input
  if (mode !== 'read-only' && mode !== 'workspace-write') throw invalid('Invalid Windows confinement mode')
  if (!drivePath(root)) throw invalid('Windows confinement root must be a local drive path')
  if (!Array.isArray(writeSids)) throw invalid('Invalid Windows confinement write SIDs')
  const sids = writeSids.map((sid: unknown) => windowsWriteSid(sid))
  const expected = mode === 'read-only' ? 0 : tempRoot === undefined ? 1 : 2
  if (sids.length !== expected || new Set(sids).size !== sids.length || (mode === 'read-only' && tempRoot))
    throw invalid(
      'A read-only launch has no write SID or temp; a writing launch has one SID per writable root',
    )
  if (tempRoot !== undefined && !drivePath(tempRoot))
    throw invalid('Windows confinement temp root must be a local drive path')
  const value: WindowsConfinement = Object.freeze({
    mode,
    root,
    writeSids: Object.freeze(sids),
    ...(tempRoot === undefined ? {} : { tempRoot }),
  })
  sealed.add(value)
  return value
}

/** Takes a sealed confinement for one launch; anything else, or a used one, is undefined. */
export function claimWindowsConfinement(value: unknown): WindowsConfinement | undefined {
  if (typeof value !== 'object' || value === null || !sealed.has(value)) return undefined
  sealed.delete(value)
  return value as WindowsConfinement
}

/**
 * Resolves the target exactly as the direct broker launch does and encodes it for CreateProcess:
 * literal CRT quoting, or the verbatim cmd.exe line for a batch file. `parentEnv` is the broker's
 * own environment, which supplies the variables Windows programs need when `env` lacks them.
 */
export function restrictedLaunch(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  windowsBatch: 'script' | 'argv-proxy',
  confinement: WindowsConfinement,
  parentEnv: NodeJS.ProcessEnv,
): RestrictedLaunch {
  const command = windowsCommand(argv, cwd, env, windowsBatch)
  const [application, ...rest] = command.argv
  if (!application) throw invalid('Windows command resolved to nothing')
  const commandLine = command.verbatim ? command.argv.join(' ') : windowsDetachedCommand(application, rest)
  if (commandLine.length > 32_766) throw invalid('Windows command line is too long')
  return {
    application,
    commandLine,
    environment: windowsDetachedEnvironment(env, parentEnv),
    writeSids: [...confinement.writeSids],
    readOnly: confinement.mode === 'read-only',
  }
}
