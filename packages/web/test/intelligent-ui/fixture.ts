import type { UiActionReceipt, UiReadResult, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
export const financeRecord = (revision = 1): UiSurfaceRecord => ({
  owner: 'agnes/intelligent-ui',
  lane: 'main',
  taskId: 'finance',
  createdSeq: 1,
  updatedSeq: revision,
  status: 'open',
  surface: {
    id: 'finance-review',
    revision,
    title: 'Reconciliation (USD cents)',
    placement: { inline: true, workbench: true },
    components: [
      {
        id: 'differences',
        kind: 'table',
        dataKey: 'rows',
        rowKey: 'id',
        columns: [
          { key: 'id', label: 'Transaction' },
          { key: 'amountCents', label: 'USD cents', format: 'number' },
        ],
        selection: 'multiple',
      },
      {
        id: 'adjustment',
        kind: 'form',
        dataKey: 'draft',
        schema: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', title: 'Reason' } },
          additionalProperties: false,
        },
        actionIds: ['confirm'],
      },
      {
        id: 'amounts',
        kind: 'chart',
        dataKey: 'rows',
        chartType: 'bar',
        categoryKey: 'id',
        series: [{ key: 'amountCents', label: 'USD cents' }],
      },
      { id: 'buttons', kind: 'button-group', actionIds: ['confirm'] },
    ],
    data: {
      rows: [{ id: 'txn-1', amountCents: 250 }],
      draft: { reason: revision === 1 ? 'Mismatch' : 'Updated difference' },
    },
    actions: [
      {
        id: 'confirm',
        label: 'Confirm adjustment',
        tool: 'fde_finance_approve',
        argsTemplate: { reason: { from: 'input', key: 'adjustment', pointer: '/reason' } },
        paramsSchema: { type: 'object', properties: { reason: { type: 'string' } } },
        confirm: 'Confirm simulated adjustment? Nothing is posted.',
      },
    ],
  },
})
export const uiPage = (
  record = financeRecord(),
  actions: UiActionReceipt[] = [],
  lastSeq = 10,
): UiReadResult => ({ sessionId: 'session-finance', surfaces: [record], actions, lastSeq })
export const uiReceipt = (
  status: UiActionReceipt['status'],
  extra: Partial<UiActionReceipt> = {},
): UiActionReceipt => ({
  sessionId: 'session-finance',
  surfaceId: 'finance-review',
  revision: 1,
  actionId: 'confirm',
  commandId: 'command-1',
  seq: 11,
  duplicate: false,
  status,
  ...(status === 'pending-approval' ? { invocationId: 'invocation-1', approvalId: 'approval-1' } : {}),
  ...(status === 'succeeded' ? { invocationId: 'invocation-1', resultSeq: 12 } : {}),
  ...(status === 'failed'
    ? {
        failure: {
          code: 'NO_DISPATCH',
          message: 'Cancelled before dispatch',
          retryable: true,
          outcomeUnknown: false,
        },
      }
    : {}),
  ...(status === 'rejected'
    ? { refusal: { reason: 'invalid', code: 'UI_INVALID', message: 'Invalid reason' } }
    : {}),
  ...extra,
})
