import { posix, win32 } from 'node:path'
import { type CommandHooksPolicy, validateCommandHooksPolicy } from '@agnes/protocol'
import { localRealpathSync as realpath } from '../adapters/fs-io-local.js'
import { samePlatformPath } from '../adapters/index.js'
import { HostError } from '../errors.js'

export type TrustedHookCommands = Readonly<{
  allowsUnconfined(source: 'data' | 'workspace', configDigest: string): boolean
}>

export function trustedHookCommands(
  policy: CommandHooksPolicy | undefined,
  workspaceRoot: string,
  semantics: { pathSep: string; caseSensitive: boolean },
): TrustedHookCommands | undefined {
  if (policy === undefined) return undefined
  semantics = { ...semantics }
  const checked = validateCommandHooksPolicy(policy)
  if (!checked.ok) throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid command hooks policy')
  if (semantics.pathSep !== '/' && semantics.pathSep !== '\\')
    throw new HostError('E_SEAM_INIT', 'unknown command hooks path semantics')
  const grants = structuredClone(checked.value.trustedUnconfined)
  const paths = semantics.pathSep === '\\' ? win32 : posix
  const pinnedRoot = realpath(workspaceRoot)
  const same = (path: string) => samePlatformPath(realpath(path), pinnedRoot, semantics.caseSensitive)
  return Object.freeze({
    allowsUnconfined(source: 'data' | 'workspace', configDigest: string): boolean {
      try {
        if (!same(workspaceRoot)) return false
        return grants.some(
          (grant) =>
            grant.source === source &&
            grant.configDigest === configDigest &&
            paths.isAbsolute(grant.workspaceRoot) &&
            (semantics.pathSep !== '\\' || paths.parse(grant.workspaceRoot).root.length > 1) &&
            same(grant.workspaceRoot),
        )
      } catch {
        return false
      }
    },
  })
}
