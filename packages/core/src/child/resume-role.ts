import { hasChildControl, requireChildControl } from '@agnes/core-child-control/child/store'
import { isActiveChildState, isTerminalChildState } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import type { ChildHandle, ChildrenFactory } from '@agnes/core-effects/effects/tool-context'
import type { ChildTaskRecord } from '@agnes/extension-api'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { type ChildRolePort, type ResolvedChildRole, recordedChildRole } from './roles.js'

/** Cold role recovery uses the old pin and old authority, never current application resolution. */
export async function resumeRoleChild(
  parent: SessionImpl,
  record: ChildTaskRecord,
  roles: ChildRolePort | undefined,
  port: {
    open(
      opts: Parameters<ChildrenFactory['create']>[0] & {
        recovering: boolean
        resolvedRole: ResolvedChildRole
      },
    ): Promise<ChildHandle>
    session(): SessionImpl
    continued(): void
  },
): Promise<ChildHandle> {
  const role = await recordedChildRole(parent, record.childKey)
  if (!role || !roles?.reopen)
    throw new CoreError('E_UNSUPPORTED', 'cross-instance child resume is not supported in this release', {
      childKey: record.childKey,
    })
  const handle = await port.open({
    parent: parent.key,
    cwd: record.cwd,
    input: record.inputText,
    role: role.ref,
    resident: true,
    recovering: true,
    resolvedRole: { role, open: roles.reopen },
  })
  const child = port.session()
  await child.d.log.fullVerified()
  const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
  if (child.op() || inbox?.items?.length) {
    void handle.run(record.inputText).catch(bestEffort(parent.d.logger, 'role-child-resume'))
  } else {
    port.continued()
    const [end] = await child.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    const interrupted = (end?.data as { reason?: string } | undefined)?.reason !== 'completed'
    const store = requireChildControl(parent.d.log.storage)
    const live = await store.lookupByKey(record.childKey)
    if (live && !isTerminalChildState(live.state))
      await store.casState(record.childKey, live.stateRevision, interrupted ? 'interrupted' : 'idle')
  }
  return handle
}

export async function recoverRoleChildren(
  parent: SessionImpl,
  roles: ChildRolePort | undefined,
  attached: (key: string) => boolean,
  resume: (key: string) => Promise<ChildHandle>,
): Promise<void> {
  if (!roles?.reopen || !hasChildControl(parent.d.log.storage)) return
  for (const record of await parent.d.log.storage.listByParent(parent.key)) {
    if (
      record.creationPhase !== 'committed' ||
      !isActiveChildState(record.state) ||
      isTerminalChildState(record.state) ||
      record.state === 'cancelling' ||
      attached(record.childKey)
    )
      continue
    if (await recordedChildRole(parent, record.childKey)) await resume(record.childKey)
  }
}
