import type { ToolResult } from '@agnes/extension-api'
import type { UiSourceFailure } from '@agnes/intelligent-ui-contract'
import { type RpcError, rpcError } from '@agnes/protocol'

export type UiArtifactFailure =
  | 'UI_ARTIFACT_NOT_FOUND'
  | 'UI_ARTIFACT_IDENTITY_MISMATCH'
  | 'UI_ARTIFACT_RECLAIMED'
  | 'UI_ARTIFACT_UNAVAILABLE'
export type UiInputIssue = { path: string; expected: string }
type UiSourceRejection = UiSourceFailure | UiArtifactFailure | 'UI_STALE'
type UnpublishedCode = UiSourceRejection | 'UI_LIMIT'

// Only validation before state/source/ledger access may mint this private marker.
const beforeEffect = new WeakSet<object>()
// Source resolution and its audit may have run; only surface publication is known to be refused.
const unpublished = new WeakMap<object, UnpublishedCode>()
const unpublishedRetryHints: Partial<Record<UnpublishedCode, string>> = {
  UI_LIMIT:
    'This session already has the maximum number of open cards. Close a card you no longer need, then retry.',
  UI_ARTIFACT_NOT_FOUND:
    'This reference is not registered in this session/lane. Use artifacts.put or present to register the file.',
  UI_ARTIFACT_IDENTITY_MISMATCH: 'Use the exact sha256, byte size and MIME returned by artifacts.put.',
  UI_ARTIFACT_RECLAIMED: 'This file was reclaimed; register a new file.',
}

function rejectUnpublished(code: UnpublishedCode): never {
  const error = rpcError('SEMANTIC_REJECTED', { code })
  unpublished.set(error, code)
  throw error
}
export function rejectUiSource(code: UiSourceRejection): never {
  return rejectUnpublished(code)
}
export function rejectLiveSurfaceLimit(): never {
  return rejectUnpublished('UI_LIMIT')
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
        content: [
          {
            type: 'text',
            text: `${code}: surface was not published. ${unpublishedRetryHints[code] ?? 'Check availability and retry.'}`,
          },
        ],
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
