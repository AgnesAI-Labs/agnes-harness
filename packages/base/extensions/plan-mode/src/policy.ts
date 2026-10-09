import type { ToolPolicy, ToolPolicyDecision, ToolPolicyInput, ToolPolicyPorts } from '@agnes/extension-api'
import { readPlanMode } from './state.js'

/**
 * While the workspace plan file is active, read-only tools keep the fallback decision and every
 * other tool is refused. `exit_plan_mode` asks, including when full access or approval mode is off.
 * A denied approval never executes the tool, so the file stays active.
 */
export function decidePlanMode(
  input: ToolPolicyInput,
  signal: AbortSignal,
  fallback: ToolPolicy,
  ports?: ToolPolicyPorts,
): ToolPolicyDecision | Promise<ToolPolicyDecision> {
  if (!readPlanMode(input.cwd).active) return fallback.decide(input, signal, ports)
  if (input.call.name === 'exit_plan_mode')
    return { effect: 'ask', reason: 'Approve the plan to leave plan mode' }
  if (input.policy.isReadOnly) return fallback.decide(input, signal, ports)
  return { effect: 'deny', reason: 'Plan mode blocks write and exec tools until the plan is approved' }
}
