import type { ToolPolicy, ToolPolicyInput, ToolPolicyPorts } from '@agnes/extension-api'
import { decidePlanState } from '../../../src/plan-mode-contract.js'
import { readPlanMode } from './state.js'

export function decidePlanMode(
  input: ToolPolicyInput,
  signal: AbortSignal,
  fallback: ToolPolicy,
  ports?: ToolPolicyPorts,
) {
  return decidePlanState({ status: readPlanMode }, input, signal, fallback, ports)
}
