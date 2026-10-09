import { join } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import { AGH_DIR } from '@agnes/protocol'
import { canonicalFs } from '@agnes/system-node'

/** Prepare only the AGH-owned mount anchor, without following links or creating missing parents. */
export async function prepareSandboxWorkspaceAncestor(root: string): Promise<void> {
  const path = join(root, AGH_DIR)
  try {
    try {
      await canonicalFs('mkdir', path, false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if ((await canonicalFs('stat', path)).kind !== 'dir')
      throw new HostError(
        'E_SANDBOX_WORKSPACE',
        'workspace .agh must be a real directory, not a symlink or file',
        {
          detail: { reason: 'workspace-ancestor-not-directory' },
        },
      )
  } catch (error) {
    if (error instanceof HostError) throw error
    throw new HostError('E_SANDBOX_WORKSPACE', 'cannot safely prepare the workspace .agh mount anchor', {
      detail: { reason: 'workspace-ancestor-unavailable' },
    })
  }
}
