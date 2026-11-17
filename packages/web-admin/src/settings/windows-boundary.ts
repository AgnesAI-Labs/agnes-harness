import type { RuntimeSecurityStatus } from '@agnes/protocol'

type Workspace = RuntimeSecurityStatus['workspaces'][number]
type Text = (key: string) => string

/**
 * Whether this status names the Windows partial contract anywhere, so its side effects apply. Only
 * the Host's own local provider on Windows applies it; another provider naming it applies nothing.
 */
export const hasWindowsBoundary = (status: RuntimeSecurityStatus): boolean =>
  status.platform.os === 'win32' &&
  (status.workspaces.some((workspace) => workspace.provider === 'local' && workspace.enforcement?.boundary) ||
    [...status.presetPolicies, ...(status.permissionPolicies ?? [])].some((policy) => policy.boundary))

/**
 * What a session's commands can actually reach on Windows, in the words the model is told: the
 * partial contract per access when the local provider's enforcement carries it, and the full-access
 * line for a local full-access session without a full boundary (Windows has no full local backend,
 * so its posture reads `none` or the unconfined `partial` file-only fallback). Another provider and
 * other platforms keep their existing text. `detail` adds the limits of the write restriction.
 */
export function windowsBoundaryText(
  workspace: Workspace,
  os: string,
  t: Text,
  detail: boolean,
): string | undefined {
  if (os !== 'win32' || workspace.provider !== 'local') return undefined
  const { enforcement, access } = workspace
  if (enforcement?.boundary) {
    if (access === 'read-only') return t('windowsBoundary.read-only')
    if (access === 'workspace-write')
      return t(detail ? 'windowsBoundaryDetail.workspace-write' : 'windowsBoundary.workspace-write')
    return t('windowsAclLevel')
  }
  if (access === 'full-access' && enforcement && enforcement.level !== 'full')
    return t('windowsBoundary.full-access')
  return undefined
}
