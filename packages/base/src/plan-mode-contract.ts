import type { ToolPolicy, ToolPolicyInput, ToolPolicyPorts } from '@agnes/extension-api'

/** Read-only backend dependency. UI installation has no bearing on enforcement. */
export interface PlanModeSnapshot {
  active: boolean
  blocked?: boolean
  revision?: string
  updatedAt: string
}
export interface PlanModeReader {
  status(workspaceRoot: string, signal: AbortSignal): PlanModeSnapshot | Promise<PlanModeSnapshot>
}

export function decidePlanState(
  reader: PlanModeReader | undefined,
  input: ToolPolicyInput,
  signal: AbortSignal,
  fallback: ToolPolicy,
  ports?: ToolPolicyPorts,
) {
  signal.throwIfAborted()
  const snapshot = reader?.status(input.workspaceRoot, signal)
  const decide = (state: PlanModeSnapshot | undefined) => {
    signal.throwIfAborted()
    if (state?.blocked || (state?.active && !state.revision))
      return {
        effect: 'deny' as const,
        reason: 'Plan mode state is corrupt or unreadable; human repair is required',
      }
    if (!state?.active) return fallback.decide(input, signal, ports)
    if (input.call.name === 'exit_plan_mode')
      return {
        effect: 'ask' as const,
        reason: 'Approve the plan to leave plan mode',
        approval: {
          reviewerRequirement: 'human' as const,
          grantConstraints: 'once' as const,
          subjectRevision: state.revision ?? '',
        },
      }
    if (input.policy.isReadOnly) return fallback.decide(input, signal, ports)
    return {
      effect: 'deny' as const,
      reason: 'Plan mode blocks write and exec tools until the plan is approved',
    }
  }
  return snapshot instanceof Promise ? snapshot.then(decide) : decide(snapshot)
}
