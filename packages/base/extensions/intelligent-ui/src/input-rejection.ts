import type { ToolResult } from '@agnes/extension-api'
import { type RpcError, rpcError } from '@agnes/protocol'

export type UiInputIssue = { path: string; expected: string }
// Only validation before state/source/ledger access may mint this private marker.
const beforeEffect = new WeakSet<object>()
export function rejectUiInput(issues: UiInputIssue[], code = 'INVALID_PARAMS'): never {
  const error = rpcError('INVALID_PARAMS', { code, effect: 'none', issues: issues.slice(0, 8) })
  beforeEffect.add(error)
  throw error
}
export async function correctableUiInput(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    if (!error || typeof error !== 'object' || !beforeEffect.has(error)) throw error
    const data = (error as RpcError).data
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `UI_INVALID: no effect. Correct the input and retry. ${JSON.stringify(data.issues)}`,
        },
      ],
      structured: { ...data, code: 'UI_INVALID' },
    }
  }
}
