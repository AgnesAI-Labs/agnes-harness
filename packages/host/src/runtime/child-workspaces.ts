import type { ChildTaskRecord, PlannedWorkspace } from '@agnes/core'
import { HostError } from '../errors.js'
import type { SessionWorkspaceRuntime } from '../session-workspace-runtime.js'
import { delegatedWorktreeBinding, type WorkspaceBinding } from '../workspace-authority.js'

function refuse(): never {
  throw new HostError('E_WORKSPACE_UNTRUSTED', 'child worktree authority is unavailable')
}

/** No cwd-only authority: persisted ownership, current file policy and Git registration must agree. */
export async function verifiedChildWorktree(
  parent: SessionWorkspaceRuntime,
  record: ChildTaskRecord,
  workspace: PlannedWorkspace | null,
  identity: { sessionKey: string; runtimeOwnerSessionKey: string } = {
    sessionKey: parent.binding.sessionKey,
    runtimeOwnerSessionKey: parent.binding.sessionKey,
  },
): Promise<WorkspaceBinding | undefined> {
  if (
    parent.binding.sessionKey !== identity.sessionKey ||
    record.parentKey !== identity.sessionKey ||
    record.runtimeOwnerSessionKey !== identity.runtimeOwnerSessionKey
  )
    refuse()
  if (!parent.fencedFs) refuse()
  await parent.fencedFs.stat(record.cwd)
  const requestedRoot = await parent.fencedFs.canonicalize(record.cwd)
  if (requestedRoot === parent.root) return undefined
  if (
    record.isolation !== 'worktree' ||
    !workspace ||
    workspace.childKey !== record.childKey ||
    workspace.workspaceId !== record.workspaceId ||
    workspace.path !== record.cwd ||
    workspace.phase !== 'attached' ||
    !workspace.root ||
    !workspace.branch ||
    !parent.fencedFs ||
    !parent.seam
  )
    refuse()
  const fs = parent.fencedFs
  const seam = parent.seam
  const stat = await fs.stat(workspace.path)
  if (stat.kind !== 'dir') refuse()
  const canonical = await fs.canonicalize(workspace.path)
  if (canonical !== workspace.path) refuse()
  await fs.stat(workspace.root)
  const result = await seam.exec(['git', 'worktree', 'list', '--porcelain', '-z'], {
    cwd: workspace.root,
    timeoutMs: 30_000,
  })
  if (result.code !== 0 || result.truncated || result.stdout.length > 1_048_576) refuse()
  const registration = result.stdout
    .split('\0\0')
    .find((entry) => entry.split('\0').includes(`worktree ${canonical}`))
  if (!registration?.split('\0').includes(`branch refs/heads/${workspace.branch}`)) refuse()
  const metadata = async (cwd: string) => {
    const output = await seam.exec(
      ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      {
        cwd,
        timeoutMs: 30_000,
      },
    )
    if (output.code !== 0 || output.truncated) refuse()
    const values = output.stdout.trimEnd().split('\n')
    if (values.length !== 2) refuse()
    return values
  }
  const owner = await metadata(workspace.root)
  const child = await metadata(canonical)
  if (child[0] !== canonical || owner[1] !== child[1]) refuse()
  return delegatedWorktreeBinding(parent.binding, record.childKey, canonical)
}
