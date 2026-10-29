import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { renameWriteThrough } from '@agnes/system-node'
import { OPERATION_CAPACITY, type RetainedOperation } from './receipt-retention.js'

export const RECEIPT_BYTE_CAP = 16 * 1024 * 1024
const DATE_BYTE_CAP = 2 * 1024 * 1024

type Journal = { operations: Record<string, RetainedOperation> }
type DateRecord = { digest: string; terminalAt: number }
const digest = (op: RetainedOperation) => createHash('sha256').update(JSON.stringify(op)).digest('hex')
const fail = (): never => {
  throw new Error('OVERLOADED')
}
async function atomic(file: string, body: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, body, { mode: 0o600, flush: true })
  await renameWriteThrough(temporary, file)
}

/** Sidecar dates bind to exact records, so a crash or operation-id reuse cannot borrow a date. */
export function readReceiptDates(file: string, state: Journal): void {
  const datesFile = `${file}.dates`
  if (!existsSync(datesFile)) return
  const body = readFileSync(datesFile, 'utf8')
  if (Buffer.byteLength(body) > DATE_BYTE_CAP) fail()
  const dates = JSON.parse(body) as Record<string, DateRecord>
  for (const [key, op] of Object.entries(state.operations)) {
    const date = Object.hasOwn(dates, key) ? dates[key] : undefined
    if (op.terminalAt === undefined && date && Number.isFinite(date.terminalAt) && date.digest === digest(op))
      op.terminalAt = date.terminalAt
    if (op.state === 'unknown' && op.code === undefined) op.code = 'OUTCOME_UNKNOWN'
  }
}

/** Keep the journal cap unchanged; legacy retention metadata has its own bounded atomic file. */
export async function saveReceiptJournal(file: string, state: Journal): Promise<void> {
  const body = JSON.stringify(state)
  if (Buffer.byteLength(body) <= RECEIPT_BYTE_CAP) return atomic(file, body)
  const compact = structuredClone(state)
  const dates: Record<string, DateRecord> = {}
  for (const [key, op] of Object.entries(compact.operations)) {
    const terminalAt = op.terminalAt
    delete op.terminalAt
    // Unknown's code is implied by its state and is restored on read.
    if (op.state === 'unknown' && op.code === 'OUTCOME_UNKNOWN') delete op.code
    if (terminalAt !== undefined) dates[key] = { digest: digest(op), terminalAt }
  }
  const compactBody = JSON.stringify(compact),
    dateBody = JSON.stringify(dates)
  if (
    Buffer.byteLength(compactBody) > RECEIPT_BYTE_CAP ||
    Object.keys(dates).length > OPERATION_CAPACITY ||
    Buffer.byteLength(dateBody) > DATE_BYTE_CAP
  )
    return fail()
  // Dates first: interruption can conservatively extend retention, never expire an unmatched record.
  await atomic(`${file}.dates`, dateBody)
  await atomic(file, compactBody)
}
