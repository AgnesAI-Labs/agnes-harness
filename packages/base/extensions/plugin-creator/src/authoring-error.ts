import { authoringDiagnosticText, safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import type { ToolResult } from '@agnes/extension-api'

type FailureKind = 'unavailable-host-capability' | 'permission-denied' | 'stale-hash' | 'validation-failure'
const unavailable = new Set(['PLUGIN_PORT_UNAVAILABLE', 'PLUGIN_MANAGEMENT_UNAVAILABLE'])
const denied = new Set([
  'CAPABILITY_DENIED',
  'PLUGIN_PERMISSION_REQUIRED',
  'PLUGIN_LOCAL_OWNER_REQUIRED',
  'PLUGIN_TEST_REJECTED',
  'PLUGIN_TEST_UNANSWERED',
  'PLUGIN_TEST_SANDBOX_REQUIRED',
  'E_CAPABILITY_UNDECLARED',
  'E_WORKSPACE_UNTRUSTED',
  'E_LEASE_EXPIRED',
  'E_PACKAGE_UNTRUSTED',
  'E_PACKAGE_TRUST',
  'E_PACKAGE_SOURCE_POLICY',
  'E_PACKAGE_PROVENANCE',
])
const stale = new Set(['PLUGIN_CANDIDATE_STALE', 'E_PACKAGE_PREVIEW_STALE'])
const invalid = new Set([
  'INVALID_PARAMS',
  'PLUGIN_FILES_INVALID',
  'E_PACKAGE_SOURCE',
  'E_PACKAGE_MANIFEST',
  'E_PACKAGE_API_RANGE',
  'E_PACKAGE_CAPABILITY',
  'CANDIDATE_ACTION_FAILED',
  'E_PACKAGE_STATE',
  'E_PACKAGE_BLOCKED',
])

/** Safe categories describe the failed operation, without guessing installation or admin settings. */
export function authoringFailure(
  operation: string,
  candidateId: string | undefined,
  stage: 'host-capability' | 'request' | 'result',
  error: unknown,
): (ToolResult & { details: NonNullable<ToolResult['details']> }) | undefined {
  const value = error as {
    code?: unknown
    diagnostics?: unknown
    data?: { code?: unknown; reason?: unknown; diagnostics?: unknown }
  } | null
  const code = [value?.data?.reason, value?.data?.code, value?.code].find((v) => typeof v === 'string')
  if (typeof code !== 'string') return undefined
  const kind: FailureKind | undefined = unavailable.has(code)
    ? 'unavailable-host-capability'
    : denied.has(code)
      ? 'permission-denied'
      : stale.has(code)
        ? 'stale-hash'
        : invalid.has(code)
          ? 'validation-failure'
          : undefined
  if (!kind) return undefined
  const diagnostics =
    kind === 'validation-failure'
      ? safeAuthoringDiagnostics(value?.data?.diagnostics ?? value?.diagnostics)
      : []
  const detail = { code, kind, operation, stage, candidateId: candidateId ?? null, diagnostics }
  const guidance =
    kind === 'unavailable-host-capability'
      ? '宿主未提供受控作者能力；保留现有草稿。 / Host authoring capability is unavailable; keep the existing draft.'
      : kind === 'permission-denied'
        ? '此调用被拒绝；不要绕过。 / This invocation was denied; do not bypass it.'
        : kind === 'stale-hash'
          ? '重新读取同一候选后再编辑。 / Read the same candidate again before editing.'
          : '候选验证失败；检查此阶段的回执。 / Candidate validation failed; inspect the receipt for this stage.'
  return {
    isError: true,
    details: detail,
    structured: detail,
    content: [
      {
        type: 'text',
        text: `${JSON.stringify(detail)}\n${guidance}\n${authoringDiagnosticText(diagnostics)}`,
      },
    ],
  }
}
