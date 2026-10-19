import { join } from 'node:path'
import { type AutomaticPermissionEvidence, withPermissionContext } from '@agnes/daemon-rpc/local/prompter'
import { createFileAudit } from '@agnes/host'
import type { PermissionContext } from '@agnes/protocol'

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
) {
  if (!context) return work()
  const evidence: AutomaticPermissionEvidence[] = []
  try {
    const value = await withPermissionContext(
      context,
      async (decision) => {
        // The control-plane journal precedes the effect, even if the worker is lost before its reply.
        const audit = createFileAudit(join(directory, 'permission-decisions.jsonl'))
        audit.write({ kind: 'extension.service-call', detail: decision })
        await audit.close?.()
        evidence.push(decision)
      },
      work,
    )
    return { value, __aghPermissionEvidence: evidence }
  } catch (error) {
    throw new PermissionRequestFailure(evidence, error)
  }
}
