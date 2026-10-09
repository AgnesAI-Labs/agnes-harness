import { readFileSync } from 'node:fs'
import { actionOutcome, guardAdjustment, recordAdjustment, reviewSurface } from './surface.mjs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

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
function ledger(file) {
  const [header, ...lines] = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
    .trim()
    .split(/\r?\n/)
  if (header !== 'id,date,amount,currency,description') throw new Error('Unsupported ledger CSV header')
  return lines.map((line) => {
    const parts = line.split(',')
    const [id, date, amount, currency, description] = parts
    if (
      parts.length !== 5 ||
      line.includes('"') ||
      !id ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^-?\d+\.\d{2}$/.test(amount) ||
      currency !== 'USD'
    )
      throw new Error('Fixture CSV requires unquoted fields, ISO dates and USD amounts with two decimals')
    const amountCents = Number(amount.replace('.', ''))
    if (!Number.isSafeInteger(amountCents)) throw new Error('Ledger amount exceeds safe integer cents')
    return { id, date, amountCents, currency, description }
  })
}
function keyed(rows) {
  const map = new Map()
  for (const item of rows) {
    if (map.has(item.id)) throw new Error(`Duplicate transaction ID: ${item.id}; reconcile manually`)
    if (!Number.isSafeInteger(item.amountCents)) throw new Error('Unsafe integer cents')
    map.set(item.id, item)
  }
  return map
}
export const tools = [
  tool(
    'fde_finance_ledgers',
    'Read the synthetic bank and book CSV ledgers using exact integer cents.',
    Type.Object({}),
    () => ({
      bank: ledger('bank.csv'),
      book: ledger('book.csv'),
      currency: 'USD',
    }),
  ),
  tool(
    'fde_finance_reconcile',
    'Match unique IDs, flag differences and propose reviewed adjustments; no ledger mutation.',
    Type.Object({ bank: Type.Array(row), book: Type.Array(row) }),
    ({ bank, book }) => {
      const banks = keyed(bank),
        books = keyed(book),
        mismatches = [],
        proposals = [],
        matched = []
      for (const id of new Set([...banks.keys(), ...books.keys()])) {
        const a = banks.get(id),
          b = books.get(id)
        if (a && b && a.date !== b.date) {
          mismatches.push({ id, kind: 'date-mismatch', bank: a, book: b })
          continue
        }
        if (a && b && a.amountCents === b.amountCents) {
          matched.push(id)
          continue
        }
        const kind = !a ? 'book-only' : !b ? 'bank-only' : 'amount-mismatch'
        mismatches.push({ id, kind, bank: a ?? null, book: b ?? null })
        if (a) {
          const amountCents = a.amountCents - (b?.amountCents ?? 0)
          if (!Number.isSafeInteger(amountCents)) throw new Error('Adjustment exceeds safe integer cents')
          proposals.push({ id, amountCents, reason: kind })
        }
      }
      return {
        matched,
        mismatches,
        proposals,
        markdown:
          '# Reconciliation draft (USD cents)\n\n' +
          mismatches
            .map(
              (item) =>
                `- ${item.id}: ${item.kind}; bank ${item.bank?.amountCents ?? 'missing'}, book ${item.book?.amountCents ?? 'missing'}`,
            )
            .join('\n'),
        unresolved: mismatches
          .filter((item) => ['book-only', 'date-mismatch'].includes(item.kind))
          .map((item) => item.id),
      }
    },
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
          report,
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
        { receipt, unresolved: state.data.report.unresolved },
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
export const { main, factory, createFactory, policy } = makeBundle({
  name: 'finance-reconcile',
  tools,
  stages,
  guardToolCall: guardAdjustment,
  recordToolResult: recordAdjustment,
})
