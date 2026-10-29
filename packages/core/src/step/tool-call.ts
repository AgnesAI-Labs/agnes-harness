import type { ToolPresentation } from '@agnes/protocol'
import type { ResolvedToolPolicyEnvelope } from '../registry/tool-policy.js'

/** Record display metadata alongside the same arguments and policy in every call-entry path. */
export function toolCallPayload(
  call: { toolUseId: string; name: string; args: unknown; ordinal: number },
  presentation: ToolPresentation | undefined,
  policy: ResolvedToolPolicyEnvelope | undefined,
) {
  return { ...call, ...(presentation ? { presentation } : {}), ...(policy ?? {}) }
}
