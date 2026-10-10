import { uiDataSourceKind } from '@agnes/intelligent-ui-contract'
import { Type } from '@sinclair/typebox'
import { fixtureDifferenceRows, keyed, ledger, reconcile, readLedgers } from './ledgers.mjs'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'
import { actionOutcome, guardAdjustment, recordAdjustment, reviewSurface } from './surface.mjs'

const row = Type.Object({
  id: Type.String(),
  date: Type.String(),
  amountCents: Type.Integer(),
  currency: Type.Literal('USD'),
  description: Type.String(),
})
const proposal = Type.Object(
  { id: Type.String(), amountCents: Type.Integer(), reason: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
)
export const tools = [
  tool(
    'fde_finance_ledgers',
    'Read the synthetic bank and book CSV ledgers using exact integer cents.',
    Type.Object({}),
    () => readLedgers(),
  ),
  tool(
    'fde_finance_reconcile',
    'Match unique IDs, flag differences and propose reviewed adjustments; no ledger mutation.',
    Type.Object({ bank: Type.Array(row), book: Type.Array(row) }),
    ({ bank, book }) => reconcile(bank, book),
  ),
  // Preset UI collects the business choice; policy separately owns tool authorization.
  tool(
    'fde_finance_approve',
    'Approve simulated balanced adjusting entries against a review suspense account; never post to a real ledger.',
    Type.Object(
      { proposals: Type.Array(proposal, { minItems: 1, maxItems: 1000 }) },
      { additionalProperties: false },
    ),
    ({ proposals }) => {
      const banks = keyed(ledger('bank.csv')),
        books = keyed(ledger('book.csv')),
        seen = new Set()
      for (const item of proposals) {
        const bank = banks.get(item.id),
          book = books.get(item.id)
        if (
          !bank ||
          (book && bank.date !== book.date) ||
          seen.has(item.id) ||
          item.amountCents !== bank.amountCents - (book?.amountCents ?? 0) ||
          !item.reason.trim()
        )
          throw new Error('Adjustment does not match the immutable synthetic evidence')
        seen.add(item.id)
      }
      const entries = proposals.map((item) => {
        if (!Number.isSafeInteger(item.amountCents) || item.amountCents === 0)
          throw new Error('Invalid adjustment')
        return {
          id: item.id,
          reason: item.reason,
          currency: 'USD',
          lines: [
            { account: 'cash', signedCents: item.amountCents },
            { account: 'review-suspense', signedCents: -item.amountCents },
          ],
        }
      })
      return { receipt: { status: 'simulated-approved', posted: false, entries } }
    },
    writeMeta,
  ),
]
// Counts and totals only. Resolved rows stay on the authenticated read path.
function modelEvidence(report, receipt) {
  const counts = {
    matchedCount: report.matched.length,
    mismatchCount: report.mismatches.length,
    proposalCount: report.proposals.length,
    unresolvedCount: report.unresolved.length,
    proposedAdjustmentCents: report.proposals.reduce((sum, item) => sum + item.amountCents, 0),
  }
  if (!receipt) return counts
  return {
    ...counts,
    receiptStatus: receipt.status,
    posted: receipt.posted,
    entryCount: receipt.entries.length,
  }
}
const stages = [
  {
    name: 'read-ledgers',
    async run(ctx, _state, signal) {
      return value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
    },
  },
  {
    name: 'reconcile',
    async run(ctx, state, signal) {
      const report = value(
        await ctx.tools.execute(
          { name: tools[1].name, args: { bank: state.data.bank, book: state.data.book } },
          signal,
        ),
      )
      return {
        report,
        commentary: await modelText(
          ctx,
          'Explain the exact ledger differences, unresolved transactions and proposed review entries. Never change amounts or claim entries were posted. These are synthetic accounting drafts.',
          modelEvidence(report),
          signal,
        ),
      }
    },
  },
  {
    name: 'show-differences',
    async run(ctx, state, signal) {
      const surface = reviewSurface(`finance-${state.outputKey.slice(0, 32)}`, state.data.report)
      const output = await ctx.tools.execute({ name: 'ui_render', args: { surface } }, signal)
      if (output.isError) throw new Error('Unable to render reconciliation review')
      return { surface }
    },
  },
  {
    name: 'await-adjustment',
    inputStage: true,
    async run(ctx, state, signal) {
      const outcome = await actionOutcome(ctx, state, signal)
      if (!outcome) return { waitingForInput: true }
      if (outcome.state === 'failed') {
        if (outcome.error?.outcomeUnknown)
          throw new Error('Adjustment outcome unknown; reconcile the original receipt before continuing')
        return { waitingForInput: true }
      }
      const { receipt } = value(outcome.result)
      if (!receipt || receipt.posted !== false || receipt.status !== 'simulated-approved')
        throw new Error('Unexpected adjustment receipt')
      const commentary = await modelText(
        ctx,
        'Explain the authorized simulation receipt and remaining unresolved rows. No real ledger was posted.',
        modelEvidence(state.data.report, receipt),
        signal,
      )
      const surface = reviewSurface(
        state.data.surface.id,
        state.data.report,
        state.data.surface.revision + 1,
        receipt,
      )
      const output = await ctx.tools.execute(
        {
          name: 'ui_update',
          args: { surfaceId: surface.id, expectedRevision: state.data.surface.revision, surface },
        },
        signal,
      )
      if (output.isError) throw new Error('Unable to update reconciliation review')
      return { receipt, surface, commentary }
    },
  },
]
const sourceParams = { type: 'object', additionalProperties: false, properties: {} }
export const { main, factory, createFactory, policy } = makeBundle({
  name: 'finance-reconcile',
  tools,
  stages,
  guardToolCall: guardAdjustment,
  recordToolResult: recordAdjustment,
  onApply(ctx) {
    const off = ctx.providers.register(uiDataSourceKind, '@agnes-fde/finance-reconcile', {
      id: 'finance/differences',
      version: '1.0.0',
      paramsSchema: sourceParams,
      result: 'rows',
      permission: 'finance.differences.read',
      capabilities: ['refresh'],
      open() {
        return {
          async query(_params, signal) {
            signal.throwIfAborted()
            return fixtureDifferenceRows()
          },
        }
      },
    })
    ctx.effect(() => off)
  },
})
