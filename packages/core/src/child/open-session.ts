import { childAgentAllowlist, setChildAgentAllowlist } from '@agnes/core-child-control/child/allowlist'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { ChildWorkspaceLifecycle } from '@agnes/core-effects/workspace/runtime'
import type { ChildTaskRecord } from '@agnes/extension-api'
import type { Kernel, SessionOptions } from '../kernel.js'
import type { SessionImpl } from '../step/session.js'
import { type ResolvedChildRole, recordedChildRole } from './roles.js'
import { childSessionToolFilter, narrowChildToolFilter } from './tool-filter.js'

export async function openDelegatedSession(
  kernel: Kernel,
  parent: SessionImpl,
  record: ChildTaskRecord,
  opts: {
    cwd: string
    forkAt?: number
    toolFilter?: import('@agnes/extension-api').ChildAgentToolFilter
    resolvedRole?: ResolvedChildRole
  },
  checkParent: () => void,
  modelTarget?: { route: string; model: string },
  delegation?: SessionOptions['delegation'],
  workspace?: ChildWorkspaceLifecycle,
): Promise<SessionImpl> {
  if (!opts.resolvedRole && (await recordedChildRole(parent, record.childKey)))
    throw new CoreError('E_UNSUPPORTED', 'A role child must reopen through its pinned Host composition')
  const childPreset = {
    ...(modelTarget
      ? {
          ...parent.preset,
          model: {
            ...parent.preset.model,
            route: { ...parent.preset.model.route, primary: modelTarget.route },
            id: { ...parent.preset.model.id, primary: modelTarget.model },
          },
        }
      : parent.preset),
  }
  const store = requireChildControl(parent.d.log.storage)
  const cwd = (await store.lookupByKey(record.childKey))?.cwd ?? record.cwd ?? opts.cwd
  checkParent()
  setChildAgentAllowlist(record.childKey, childAgentAllowlist(parent.key))
  const filter = narrowChildToolFilter(childSessionToolFilter(parent), opts.toolFilter)
  const open =
    opts.resolvedRole?.open ?? ((key: string, options: SessionOptions) => kernel.session(key, options))
  const child = await open(record.childKey, {
    ...(filter ? { toolFilter: filter } : {}),
    actor: parent.d.actor,
    resolvedProfileHash: parent.d.resolvedProfileHash,
    ...(!modelTarget && parent.d.resolvedPresetHash
      ? { resolvedPresetHash: parent.d.resolvedPresetHash }
      : {}),
    ...(parent.d.policyDigest ? { policyDigest: parent.d.policyDigest } : {}),
    preset: childPreset,
    ...(!opts.resolvedRole
      ? {
          parent: {
            key: parent.key,
            boundarySeq:
              record.boundarySeq ||
              (opts.forkAt ??
                (record.kind === 'fork' ? parent.op()?.meta.triggerSeq : undefined) ??
                parent.lastSeq),
          },
        }
      : {}),
    cwd,
    writerRunId: `${parent.writerRunId}/child/${kernel.ids.ulid()}`,
    lane: parent.lane,
    ...(workspace
      ? {
          workspaceRuntime: workspace.runtime,
          workspaceIdentity: workspace.runtime.identity,
          workspaceLease: workspace,
          ...(workspace.sandbox ? { seams: { sandbox: workspace.sandbox } } : {}),
        }
      : {}),
    ...(parent.d.childWorkspaceRuntime ? { childWorkspaceRuntime: parent.d.childWorkspaceRuntime } : {}),
    delegation: delegation ?? {
      kind: record.kind,
      creationId: record.creationId,
      rootTaskId: record.rootTaskId,
      generationDepth: record.generationDepth,
    },
  })
  return child
}
