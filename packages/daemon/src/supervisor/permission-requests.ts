import { join } from 'node:path'
import { type AutomaticPermissionEvidence, withPermissionContext } from '@agnes/daemon-rpc/local/prompter'
import type { PermissionContext } from '@agnes/protocol'
import { journalAuthorization } from './authorization-journal.js'

export class PermissionRequestFailure extends Error {
  constructor(
    readonly evidence: AutomaticPermissionEvidence[],
    cause: unknown,
  ) {
    super('Permission-bound operation failed', { cause })
  }
}

/** Private worker requests carry Host-owned policy independently of tool arguments. */
export async function permissionRequest<T>(
  context: PermissionContext | undefined,
  directory: string,
  work: () => Promise<T>,
  verify?: () => Promise<PermissionContext | undefined>,
  current?: () => PermissionContext | undefined,
) {
  if (!context || !verify) {
    const value = await work()
    return context ? { value, __aghPermissionEvidence: [] } : value
  }
  const evidence: AutomaticPermissionEvidence[] = []
  try {
    const value = await withPermissionContext(
      context,
      async (decision) => {
        // The control-plane journal precedes the effect, even if the worker is lost before its reply.
        await journalAuthorization(join(directory, 'permission-decisions.jsonl'), decision)
        evidence.push(decision)
      },
      work,
      verify,
      current,
    )
    return { value, __aghPermissionEvidence: evidence }
  } catch (error) {
    throw new PermissionRequestFailure(evidence, error)
  }
}
