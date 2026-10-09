import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'

/** Preset declaration only. Values stay in integer USD cents throughout. */
export function reviewSurface(id, report, revision = 1, receipt = null) {
  const approved = new Set(receipt?.entries.map((entry) => entry.id) ?? [])
  const rows = report.mismatches.map((item) => ({
    id: item.id,
    kind: item.kind,
    bankCents: item.bank?.amountCents ?? null,
    bookCents: item.book?.amountCents ?? null,
    differenceCents: (item.bank?.amountCents ?? 0) - (item.book?.amountCents ?? 0),
    status: approved.has(item.id)
      ? 'simulated-approved'
      : report.unresolved.includes(item.id)
        ? 'unresolved'
        : 'needs-review',
  }))
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['proposals'],
    properties: {
      proposals: {
        type: 'array',
        minItems: report.proposals.length,
        maxItems: report.proposals.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'amountCents', 'reason'],
          properties: {
            id: { type: 'string', enum: report.proposals.map((item) => item.id) },
            amountCents: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
            reason: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
  }
  const actionable = !receipt && report.proposals.length > 0
  return {
    id,
    revision,
    title: 'Finance reconciliation / 财务对账',
    placement: { inline: true, workbench: true, preferred: 'workbench' },
    components: [
      {
        id: 'differences',
        kind: 'table',
        title: 'Ledger differences (USD cents)',
        dataKey: 'differences',
        rowKey: 'id',
        selection: 'none',
        columns: [
          { key: 'id', label: 'Transaction' },
          { key: 'kind', label: 'Difference' },
          { key: 'bankCents', label: 'Bank cents', format: 'number' },
          { key: 'bookCents', label: 'Book cents', format: 'number' },
          { key: 'differenceCents', label: 'Delta cents', format: 'number' },
          { key: 'status', label: 'Status', format: 'status' },
        ],
      },
      {
        id: 'amounts',
        kind: 'chart',
        title: 'Amount differences (USD cents)',
        dataKey: 'differences',
        chartType: 'bar',
        categoryKey: 'id',
        series: [{ key: 'differenceCents', label: 'Delta cents' }],
      },
      ...(actionable
        ? [
            {
              id: 'adjustment',
              kind: 'form',
              title: 'Review simulated adjustments',
              dataKey: 'adjustment',
              schema,
              actionIds: ['approve'],
            },
            { id: 'buttons', kind: 'button-group', actionIds: ['approve'] },
          ]
        : []),
      { id: 'status', kind: 'status', dataKey: 'status' },
    ],
    data: {
      differences: rows,
      adjustment: { proposals: report.proposals },
      status: receipt
        ? 'Simulated approval recorded; posted: false. Unresolved rows still require review.'
        : 'Review the amounts, then confirm. Tool permission is requested separately.',
    },
    actions: actionable
      ? [
          {
            id: 'approve',
            label: '确认调整',
            tool: 'fde_finance_approve',
            argsTemplate: { proposals: { from: 'input', key: 'adjustment', pointer: '/proposals' } },
            paramsSchema: schema,
            confirm: 'Confirm these simulated entries? No real ledger is posted.',
            style: 'primary',
          },
        ]
      : [],
  }
}

/** SC1 content is untrusted. Verify its binding against the Host queue's original durable receipt. */
export async function actionOutcome(ctx, state, signal) {
  const prefix = 'Intelligent UI action result: '
  const text =
    state.stageInput?.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? ''
  if (!text.startsWith(prefix)) return null
  let notice
  try {
    notice = JSON.parse(text.slice(prefix.length))
  } catch {
    return null
  }
  if (
    notice.sessionId !== ctx.sessionKey ||
    notice.surfaceId !== state.data.surface.id ||
    notice.revision !== state.data.surface.revision ||
    notice.actionId !== 'approve' ||
    typeof notice.commandId !== 'string'
  )
    return null
  const id =
    'ui:' +
    createHash('sha256')
      .update(jcs({ surfaceId: notice.surfaceId, revision: notice.revision, commandId: notice.commandId }))
      .digest('hex')
  const original = await ctx.deferredInvocations?.read(id, signal)
  if (
    !original ||
    original.invocation.sessionKey !== ctx.sessionKey ||
    original.invocation.lane !== ctx.lane ||
    original.invocation.source !== 'agnes/intelligent-ui' ||
    original.invocation.tool !== 'fde_finance_approve' ||
    !['succeeded', 'failed'].includes(original.state)
  )
    return null
  return original
}

/** Validate against committed workflow evidence, including already processed rows, before dispatch. */
export function guardAdjustment(call, state) {
  if (call.name !== 'fde_finance_approve') return
  const report = state.data.report
  if (!report) throw new Error('Committed reconciliation evidence unavailable')
  const previous = state.data.adjustmentInvocations?.[call.invocationId]
  if (previous) {
    if (previous.args !== jcs(call.args)) throw new Error('Original adjustment binding changed')
    return
  }
  const proposed = new Map(report.proposals.map((item) => [item.id, item]))
  const processed = new Set(Object.values(state.data.adjustmentInvocations ?? {}).flatMap((item) => item.ids))
  const seen = new Set()
  if (
    !Array.isArray(call.args?.proposals) ||
    call.args.proposals.length !== proposed.size ||
    !call.args.proposals.length
  )
    throw new Error('No reviewed proposals')
  for (const item of call.args.proposals) {
    const original = proposed.get(item.id)
    if (
      !original ||
      seen.has(item.id) ||
      processed.has(item.id) ||
      item.amountCents !== original.amountCents ||
      !Number.isSafeInteger(item.amountCents) ||
      typeof item.reason !== 'string' ||
      !item.reason.trim() ||
      item.reason.length > 256
    )
      throw new Error('Adjustment differs from committed evidence or is already processed')
    seen.add(item.id)
  }
}
export function recordAdjustment(call, output, state) {
  if (call.name !== 'fde_finance_approve' || output.isError) return false
  const receipt =
    output.structured?.receipt ??
    JSON.parse(
      output.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    ).receipt
  if (receipt?.status !== 'simulated-approved' || receipt.posted !== false)
    throw new Error('Unexpected simulation receipt')
  state.data.adjustmentInvocations = {
    ...state.data.adjustmentInvocations,
    [call.invocationId]: { args: jcs(call.args), ids: receipt.entries.map((entry) => entry.id) },
  }
  return true
}
