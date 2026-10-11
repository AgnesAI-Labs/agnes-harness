import type { ToolResult } from '@agnes/extension-api'
import type { UiSourceFailure } from '@agnes/intelligent-ui-contract'
import { type RpcError, rpcError } from '@agnes/protocol'

export type UiInputIssue = { path: string; expected: string }
// Only validation before state/source/ledger access may mint this private marker.
const beforeEffect = new WeakSet<object>()
// Source resolution and its audit may have run; only surface publication is known to be refused.
const unpublished = new WeakMap<object, UiSourceFailure | 'UI_STALE'>()
export function rejectUiSource(code: UiSourceFailure | 'UI_STALE'): never {
  const error = rpcError('SEMANTIC_REJECTED', { code })
  unpublished.set(error, code)
  throw error
}
export function rejectUiInput(issues: UiInputIssue[], code = 'INVALID_PARAMS'): never {
  const error = rpcError('INVALID_PARAMS', { code, effect: 'none', issues: issues.slice(0, 8) })
  beforeEffect.add(error)
  throw error
}
export async function correctableUiRejection(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    const code = error && typeof error === 'object' ? unpublished.get(error) : undefined
    if (code)
      return {
        isError: true,
        content: [{ type: 'text', text: `${code}: surface was not published. Check the source and retry.` }],
        structured: { code, published: false },
      }
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
