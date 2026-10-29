import {
  authoringDiagnosticText,
  authoringFailureSummary,
  safeAuthoringDiagnostics,
  safeAuthoringOutput,
  safePackagePath,
} from '@agnes/error-sanitization'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { AuthoringCandidate } from '@agnes/protocol'
import { creatorAssets } from './generated/assets.js'

// Leave room for Core's conservative JSON accounting and the bridge envelope.
const STRUCTURED_BYTES = 240 * 1024
const PAGE_BYTES = 32 * 1024
type ReadOptions = { offset?: number; expectedHash?: string }
const failure = (code: string, message: string): ToolResult => ({
  isError: true,
  details: { code },
  content: [{ type: 'text', text: message }],
})
// Only explicit receipt evidence advances a verification stage. Browser checks are external.
const verification = (value: AuthoringCandidate) => ({
  draftGenerated: value.candidateId ? 'verified' : 'not-verified',
  structureValidated: value.preview?.blockers?.length === 0 ? 'verified' : 'not-verified',
  candidateTestPassed:
    value.tests?.state === 'passed' && value.tests.hash === value.candidateHash && value.tests.count > 0
      ? 'verified'
      : 'not-verified',
  installVerified: value.state === 'published' ? 'verified' : 'not-verified',
  browserAppearanceVerified: 'not-verified',
  published: value.state === 'published' ? 'verified' : 'not-verified',
})
const summaryKeys = ['added', 'removed', 'changed', 'entries', 'missing'] as const
const writeSummary = (value: NonNullable<AuthoringCandidate['writeSummary']>) => ({
  ...Object.fromEntries(summaryKeys.map((key) => [key, value[key].filter(safePackagePath).slice(0, 64)])),
  unchanged: value.unchanged,
})
const receipt = (value: AuthoringCandidate) => ({
  verification: verification(value),
  browserCheck:
    '未验证：请检查亮暗模式、禁用及默认外观恢复。 / Not verified: check light/dark mode, disable and restore default appearance.',
  candidateId: value.candidateId,
  candidateHash: value.candidateHash,
  packageId: value.packageId,
  state: value.state,
  baseHash: value.baseHash,
  reviewHash: value.reviewHash,
  message: value.message,
  tests: value.tests && { ...value.tests, output: safeAuthoringOutput(value.tests.output ?? '') },
  diagnostics: safeAuthoringDiagnostics(value.diagnostics),
  ...(value.writeSummary ? { writeSummary: writeSummary(value.writeSummary) } : {}),
})

/** Only adapts tool output; the Host retains full diffs and authoring authority. */
export async function candidateResult(
  ctx: ToolContext,
  value: AuthoringCandidate,
  read?: ReadOptions,
  operation?: string,
): Promise<ToolResult> {
  const summary = { ...receipt(value), operation, stage: 'result' }
  const display = {
    ...summary,
    tests: value.tests && { ...value.tests, output: undefined },
    ...(value.writeSummary
      ? {
          writeSummary: Object.fromEntries(
            Object.entries(summary.writeSummary ?? {}).map(([key, paths]) => [
              key,
              Array.isArray(paths)
                ? { count: paths.length, paths: paths.filter(safePackagePath).slice(0, 3) }
                : paths,
            ]),
          ),
        }
      : {}),
  }
  let text = JSON.stringify(display)
  const diagnosticText = authoringDiagnosticText(value.diagnostics)
  if (diagnosticText) text += `\nWarning / 警告: ${diagnosticText}`
  if (value.writeSummary?.unchanged)
    text +=
      '\nNo progress: read the diagnostics or read the candidate first. / 无进展：请先阅读诊断或读取候选。'
  if (value.tests?.state === 'failed')
    text += `\nTest failure / 测试失败:\n${authoringFailureSummary(value.tests.output ?? '')}\nFull redacted output: use run_code with tools.plugin_candidate_read({candidateId}) and inspect tests.output; assemble source pages first if returned. / 完整脱敏输出：通过 run_code 调用 plugin_candidate_read，必要时拼接分页后读取 tests.output。`
  if (
    value.tests?.state === 'failed' &&
    /E_TOOLDEF_META|Test port not configured/.test(value.tests.output ?? '')
  )
    text += `\nRepair hint / 修复提示: ${creatorAssets.toolSafetyGuidance}`
  if (read === undefined) {
    const failed =
      ['failed', 'interrupted', 'cancelled', 'rejected'].includes(value.state) ||
      value.tests?.state === 'failed'
    return {
      ...(failed ? { isError: true, details: { code: 'CANDIDATE_ACTION_FAILED' } } : {}),
      content: [{ type: 'text', text }],
      structured: summary,
    }
  }
  if (read.expectedHash !== undefined && read.expectedHash !== value.candidateHash)
    return failure(
      'E_PACKAGE_PREVIEW_STALE',
      'Candidate changed. Read it again from the beginning before editing.',
    )
  const snapshot = {
    candidateId: value.candidateId,
    candidateHash: value.candidateHash,
    sourceFiles: value.sourceFiles,
    ...(value.tests ? { tests: summary.tests } : {}),
  }
  const json = JSON.stringify(snapshot),
    bytes = Buffer.from(json, 'utf8'),
    offset = read.offset ?? 0
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) ||
    (offset > 0 && !read.expectedHash)
  )
    return failure(
      'E_PACKAGE_SOURCE',
      'Invalid source offset. Continue with the returned nextOffset and candidateHash.',
    )
  let structured: ToolResult['structured'] = snapshot
  if (read.offset !== undefined || bytes.length > STRUCTURED_BYTES) {
    let end = Math.min(bytes.length, offset + PAGE_BYTES)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    const page = () => ({
      kind: 'candidate-source-page',
      candidateId: value.candidateId,
      candidateHash: value.candidateHash,
      offset,
      data: bytes.subarray(offset, end).toString('utf8'),
      nextOffset: end === bytes.length ? null : end,
      totalBytes: bytes.length,
    })
    // Measure the final escaped envelope, not source characters or the model's text budget.
    while (Buffer.byteLength(JSON.stringify(page())) > STRUCTURED_BYTES && end > offset) {
      end--
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--
    }
    structured = page()
    text += `\nSource page ${offset}..${end} of ${bytes.length} bytes; nextOffset=${end === bytes.length ? 'null' : end}.`
  }
  const displayBudget = Math.min(ctx.outputMaxBytes ?? 32768, 4096)
  if (
    read.offset === undefined &&
    Buffer.byteLength(JSON.stringify([{ type: 'text', text: `${text}\n${json}` }])) <= displayBudget
  )
    text += `\n${json}`
  else if (offset === 0) {
    try {
      const ref = await ctx.artifacts.put(bytes, { mime: 'text/plain', name: 'candidate-source.json' })
      text += `\nFull source: artifact://${ref.sha256}?size=${ref.size}. Use read/grep with this path, or run_code with the structured result.`
    } catch {
      text +=
        '\nFull preview could not be saved. Program data is still available through run_code; do not recreate the candidate.'
    }
  }
  ctx.signal.throwIfAborted()
  return { content: [{ type: 'text', text }], structured }
}
