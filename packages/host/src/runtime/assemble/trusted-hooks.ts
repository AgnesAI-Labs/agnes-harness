import { posix, win32 } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import { localRealpathSync as realpath } from '@agnes/host-infrastructure/adapters/fs-io-local'
import { type CommandHooksPolicy, validateCommandHooksPolicy } from '@agnes/protocol'
import { samePlatformPath } from '../adapters/index.js'

export type TrustedHookCommands = Readonly<{
  allowsUnconfined(source: 'data' | 'workspace', configDigest: string, workspaceRoot?: string): boolean
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
  const pinnedGrants = grants.map((grant) => {
    try {
      return { grant, root: realpath(grant.workspaceRoot) }
    } catch {
      return undefined
    }
  })
  return Object.freeze({
    allowsUnconfined(
      source: 'data' | 'workspace',
      configDigest: string,
      invocationRoot = workspaceRoot,
    ): boolean {
      try {
        if (!samePlatformPath(realpath(workspaceRoot), pinnedRoot, semantics.caseSensitive)) return false
        const root = realpath(invocationRoot)
        return pinnedGrants.some((entry) => {
          if (!entry) return false
          const { grant, root: original } = entry
          return (
            grant.source === source &&
            grant.configDigest === configDigest &&
            paths.isAbsolute(grant.workspaceRoot) &&
            (semantics.pathSep !== '\\' || paths.parse(grant.workspaceRoot).root.length > 1) &&
            samePlatformPath(root, original, semantics.caseSensitive) &&
            samePlatformPath(realpath(grant.workspaceRoot), original, semantics.caseSensitive)
          )
        })
      } catch {
        return false
      }
    },
  })
}
