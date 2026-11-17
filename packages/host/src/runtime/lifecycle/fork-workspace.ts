import { HostError } from '@agnes/host-common/errors'
import {
  assertWorkspaceBinding,
  sameWorkspaceBindingAuthority,
  type WorkspaceBinding,
} from '@agnes/host-common/workspace-authority'
import type { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'

const ROLE_DELEGATION_ROW = 'x/core/role-delegation'

/**
 * The binding a forked session opens its own workspace runtime from, or undefined where the existing
 * paths apply. A fork opened through the Host is a session of its own: its own key, history and
 * lifetime. Under the Windows write restriction it must not borrow its parent's lease, private
 * temporary directory and SID, so it gets a runtime of its own, with its own gate and lease, from the
 * binding its parent would have shared. Subagent children, which work inside their parent's turn,
 * reserve the parent's runtime through the session's child port and keep sharing it.
 *
 * Every other fork is left as it was: one that inherits its parent's workspace shares the parent's
 * runtime, and one that adds directories already opens its own.
 */
export async function forkOwnWorkspace(
  table: Pick<SessionWorkspaceRuntimeTable, 'securityStatus' | 'reserve'>,
  storage: { scan(key: string, query: { type: string; limit: number }): Promise<readonly unknown[]> },
  o: Readonly<{ key?: string; parent?: Readonly<{ key: string }>; binding?: unknown }>,
): Promise<WorkspaceBinding | undefined> {
  const parentKey = o.parent?.key
  if (parentKey === undefined || table.securityStatus(parentKey)?.enforcement?.boundary === undefined)
    return undefined
  const binding = o.binding as WorkspaceBinding | undefined
  if (binding) assertWorkspaceBinding(binding)
  if (!o.key)
    throw new HostError('E_WORKSPACE_REQUIRED', 'fork child needs a stable session key', {
      detail: { reason: 'child-session-key-required' },
    })
  const reserved = await table.reserve(parentKey, o.key)
  const inherited = reserved.runtime.binding as WorkspaceBinding
  await reserved.close()
  if (binding && !sameWorkspaceBindingAuthority(binding, inherited)) return undefined
  // A role session's fence comes from its captured delegation, which its fork does not carry; a
  // runtime of the fork's own would fall back to the default policy. Refuse, never share.
  if ((await storage.scan(parentKey, { type: ROLE_DELEGATION_ROW, limit: 1 })).length > 0)
    throw new HostError(
      'E_WORKSPACE_UNTRUSTED',
      'a fork of a role session cannot get its own Windows write restriction',
      { detail: { reason: 'fork-windows-role-session' } },
    )
  return binding ?? inherited
}
