import type { RuntimeSecurityStatus } from '@agnes/protocol'

type Workspace = RuntimeSecurityStatus['workspaces'][number]
type Text = (key: string) => string

/** Whether this status names the Windows partial contract anywhere, so its side effects apply. */
export const hasWindowsBoundary = (status: RuntimeSecurityStatus): boolean =>
  status.workspaces.some((workspace) => workspace.enforcement?.boundary) ||
  [...status.presetPolicies, ...(status.permissionPolicies ?? [])].some((policy) => policy.boundary)

/**
 * What a session's commands can actually reach on Windows, in the words the model is told: the
 * partial contract per access when the enforcement carries it, and the full-access line for an
 * unconfined local session. Anything else keeps its existing text, so other platforms are unchanged.
 * `detail` adds the limits of the write restriction.
 */
export function windowsBoundaryText(
  workspace: Workspace,
  os: string,
  t: Text,
  detail: boolean,
): string | undefined {
  const { enforcement, access } = workspace
  if (enforcement?.boundary) {
    if (access === 'read-only') return t('windowsBoundary.read-only')
    if (access === 'workspace-write')
      return t(detail ? 'windowsBoundaryDetail.workspace-write' : 'windowsBoundary.workspace-write')
    return t('windowsAclLevel')
  }
  if (
    os === 'win32' &&
    workspace.provider === 'local' &&
    access === 'full-access' &&
    enforcement?.level === 'none'
  )
    return t('windowsBoundary.full-access')
  return undefined
}
