/** Incremental admission of completed answers from the portable runtime ledger. */
import type { RecordId, RuntimeRecord } from './types.js'

type Request = RuntimeRecord & { kind: 'model.requested' }
type Settlement = RuntimeRecord & { kind: 'model.settled' }

/** Final-answer settlements and arbitration answers selected after response review. */
export class AcceptedAnswers {
  private readonly requests = new Map<RecordId, Request>()
  private readonly settlements = new Map<RecordId, Settlement>()
  private readonly admitted = new Set<RecordId>()

  /**
   * Fold one committed record in ledger order.
   * Arbitration text stays private until its RESPOND selection is committed;
   * legacy selections without answer content admit no assistant message.
   * @param record - next record in the validated committed prefix.
   * @returns the admitted answer and actual request; repeated arbitration selections are ignored.
   */
  apply(record: RuntimeRecord): { request: Request; settled: Settlement } | undefined {
    if (record.kind === 'model.requested') this.requests.set(record.id, record)
    if (record.kind === 'model.settled') this.settlements.set(record.requested, record)
    const requested =
      record.kind === 'model.settled'
        ? record.requested
        : record.kind === 'decision.selected' &&
            record.source === 'llm_arbitration' &&
            record.phase === 'RESPOND' &&
            record.operation === 'RESPOND'
          ? record.requested
          : undefined
    if (requested === undefined || (record.kind !== 'model.settled' && this.admitted.has(requested))) return
    const request = this.requests.get(requested)
    const settled = this.settlements.get(requested)
    if (request === undefined || settled === undefined || settled.settlement.error !== undefined) return
    if (
      record.kind === 'model.settled'
        ? request.call.purpose !== 'answer'
        : request.call.purpose !== 'arbitration'
    )
      return
    const output = settled.settlement.output
    if (
      record.kind === 'decision.selected' &&
      (output === undefined ||
        output === null ||
        typeof output !== 'object' ||
        Array.isArray(output) ||
        output.kind !== 'answer' ||
        !Array.isArray(output.content))
    )
      return
    this.admitted.add(requested)
    return { request, settled }
  }
}
