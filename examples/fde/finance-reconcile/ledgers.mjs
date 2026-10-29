import { readFileSync } from 'node:fs'

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

/** Match unique IDs. The result has no approval receipt. */
export function reconcile(bank, book) {
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
}

/** Rows for finance/differences. A caller may mark receipt ids; the published source does not. */
export function differenceRows(report, receipt = null) {
  const approved = new Set(receipt?.entries.map((entry) => entry.id) ?? [])
  return report.mismatches.map((item) => ({
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
}

export function readLedgers() {
  return { bank: ledger('bank.csv'), book: ledger('book.csv'), currency: 'USD' }
}

/** Fixture differences for `finance/differences`. No receipt, so no simulated approval. */
export function fixtureDifferenceRows() {
  const { bank, book } = readLedgers()
  return differenceRows(reconcile(bank, book))
}

export { keyed, ledger }
