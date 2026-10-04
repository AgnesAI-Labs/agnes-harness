import { inspectComparisonInput } from '@agnes/host'
import type { ComparisonJournalFact, ComparisonResultSummary, EventEnvelope } from '@agnes/protocol'

type Coordinator = Extract<ComparisonJournalFact, { kind: 'coordinator' }>
type Round = NonNullable<Coordinator['latestRound']>

/** Project one root's current input only, using the exact same detached prefix as accounting. */
export async function comparisonLaneResult(input: {
  side: 'left' | 'right'
  sessionId: string
  throughSeq: number
  events: readonly EventEnvelope[]
  complete: boolean
  coordinator?: Coordinator
  rounds: ReadonlyMap<string, Round>
}): Promise<ComparisonResultSummary['lanes'][number]> {
  const { side, coordinator, throughSeq, events } = input
  const round = coordinator?.latestRound
  const issues: string[] = []
  if (!coordinator) issues.push('coordinator_evidence_unavailable')
  if (!input.complete) issues.push('root_prefix_incomplete')
  let run = round?.runs[side] ?? 'unknown'
  let terminalCause = round?.terminalCauses[side] ?? 'unknown'
  let phase = coordinator?.lanes[side]?.phase ?? 'unknown'
  let latestAnswer: ComparisonResultSummary['lanes'][number]['latestAnswer'] = null
  if (round) {
    const terminalSeq = round.terminalSeqs?.[side]
    if (terminalSeq !== undefined && terminalSeq > throughSeq) {
      issues.push('settlement_not_captured')
      run = 'unknown'
      terminalCause = 'unknown'
      phase = 'recovering'
    }
    if (round.acceptances[side] === 'accepted' && input.complete) {
      const inspected = await inspectComparisonInput({
        sessionId: input.sessionId,
        inputId: round.inputId,
        throughSeq,
        includeExecution: true,
        scan: async (query) =>
          events
            .filter((event) => event.seq >= (query.fromSeq ?? 1) && event.seq <= (query.toSeq ?? throughSeq))
            .slice(0, query.limit ?? events.length),
      })
      if (inspected.receipt?.status !== 'accepted' || inspected.receipt.seq !== round.acceptedSeqs[side]) {
        issues.push('input_receipt_not_captured')
      } else if (inspected.execution) {
        const execution = inspected.execution
        const answer = events.find((event) => event.seq === execution.answerSeq)
        const data = answer?.data as { content?: Array<{ type?: string; text?: string }> } | undefined
        const text = data?.content
          ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
        if (answer && text)
          latestAnswer = { seq: answer.seq, text: text.slice(0, 2000), truncated: text.length > 2000 }
        if (
          run === 'settled' &&
          (!inspected.state?.settled || inspected.state.terminalCause !== terminalCause)
        )
          issues.push('terminal_evidence_not_captured')
      } else if (
        run === 'settled' &&
        !(
          inspected.cancellation === 'acknowledged' &&
          inspected.state?.settled &&
          inspected.state.terminalCause === 'cancelled' &&
          terminalCause === 'cancelled'
        )
      )
        issues.push('execution_evidence_unavailable')
    } else if (round.acceptances[side] === 'unknown') issues.push('input_receipt_unknown')
  }
  // DSH's cumulative wall metric is all-or-nothing across rounds. Never derive it from
  // event timestamps, current wall time, or a recovered run with no monotonic measurement.
  let elapsedMs: number | null = coordinator && input.rounds.size === coordinator.roundCount ? 0 : null
  if (elapsedMs !== null)
    for (const item of input.rounds.values()) {
      const timing = item.timings?.[side]
      const end = item.terminalSeqs?.[side]
      if (
        !timing?.terminalConfirmed ||
        timing.elapsedMs === null ||
        !Number.isSafeInteger(timing.elapsedMs) ||
        timing.elapsedMs < 0 ||
        end === undefined ||
        end > throughSeq
      ) {
        elapsedMs = null
        break
      }
      elapsedMs += timing.elapsedMs
      if (!Number.isSafeInteger(elapsedMs)) {
        elapsedMs = null
        break
      }
    }
  if (issues.length && run === 'settled') {
    run = 'unknown'
    terminalCause = 'unknown'
    phase = 'recovering'
  }
  return {
    side,
    phase,
    run,
    terminalCause,
    acceptance: round?.acceptances[side] ?? 'none',
    elapsedMs,
    latestAnswer,
    complete: issues.length === 0,
    issues,
  }
}
