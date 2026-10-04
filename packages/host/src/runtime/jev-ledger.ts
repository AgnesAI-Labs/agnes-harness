import { type EventInput, type SessionImpl, scanAll } from '@agnes/core'
import {
  AcceptedAnswers,
  assertRuntimeRecord,
  type LedgerEntry,
  type RuntimeLedger,
  type RuntimeRecord,
  replayRecords,
} from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { ToolResult } from '@agnes/protocol/gen/session-v1'
import { assertRuntimeOwner } from '@agnes/runtime-api'
import { isAnswerOutput, requireAssistantSettlement } from '@agnes/runtime-jev'
import { drainJevCostOutbox, jevCostOutbox, projectJevCost } from './jev-cost.js'
import { drainJevTreeBudget } from './jev-tree-budget.js'

/** One durable stream and one writer. UI facts are committed with their admitting runtime record. */
export async function createJevLedger(
  session: SessionImpl,
  options: {
    /** Additional durable presentation sources for this adopted answer, never an alternate admission owner. */
    acceptedAnswerSources?: (
      request: Extract<RuntimeRecord, { kind: 'model.requested' }>,
    ) => readonly number[]
  } = {},
): Promise<RuntimeLedger<number>> {
  const entries: LedgerEntry<number>[] = []
  for (const event of await scanAll((query) => session.scan(query), {
    type: 'runtime/record',
    toSeq: session.lastSeq,
  })) {
    const data = event.data as { runtime: unknown; record: unknown }
    assertRuntimeOwner(data.runtime, session.runtimeIdentity)
    assertRuntimeRecord(data.record)
    entries.push({ cursor: event.seq, record: data.record })
  }
  replayRecords(entries)
  {
    const answers = new AcceptedAnswers()
    for (const entry of entries) {
      const accepted = answers.apply(entry.record)
      if (
        accepted &&
        isAnswerOutput(accepted.settled.settlement.output) &&
        accepted.settled.settlement.snapshot !== undefined
      )
        requireAssistantSettlement(accepted.settled.settlement)
    }
  }
  await drainJevCostOutbox(session)
  await drainJevTreeBudget(session)
  return {
    read: async () => structuredClone(entries),
    cursorText: String,
    async commit(input) {
      // Detach before joining the writer queue. The caller cannot mutate an admitted transaction.
      const record = structuredClone(input)
      assertRuntimeRecord(record)
      const cursor = await session.locked(async () => {
        const next = { cursor: session.lastSeq + 1, record }
        // Validate causality BEFORE storage. An invalid append must not poison the durable prefix.
        replayRecords([...entries, next])
        const rows: EventInput[] = [
          session.ev('runtime/record', { runtime: session.runtimeIdentity, record }),
        ]
        if (record.kind === 'action.settled') {
          const calls = await scanAll((query) => session.scan(query), {
            type: 'tool/call',
            toSeq: session.lastSeq,
          })
          const call = calls.findLast(
            (row) => (row.data as { toolUseId?: string }).toolUseId === record.intentId,
          )
          if (call) {
            const prior = await scanAll((query) => session.scan(query), {
              type: 'tool/result',
              fromSeq: call.seq,
              toSeq: session.lastSeq,
            })
            if (!prior.some((row) => (row.data as { toolUseId?: string }).toolUseId === record.intentId)) {
              const saved = record.outcome.snapshot as unknown as
                | { codec?: string; value?: { projection?: { data?: unknown; trust?: unknown } } }
                | undefined
              const projection = saved?.codec === 'agnes-tool-result-v1' ? saved.value?.projection : undefined
              const checked = projection
                ? validateAgainst<ToolResult>(ToolResult, projection.data)
                : undefined
              if (
                projection &&
                (!checked?.ok ||
                  checked.value.toolUseId !== record.intentId ||
                  (projection.trust !== 'trusted' && projection.trust !== 'untrusted'))
              )
                throw new Error('Invalid Host tool result projection')
              const data: ToolResult = checked?.ok
                ? checked.value
                : {
                    toolUseId: record.intentId,
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: record.outcome.error?.message ?? 'Tool execution has no durable result',
                      },
                    ],
                    code: record.outcome.error?.code ?? 'TOOL_OUTCOME_UNKNOWN',
                    enforcement: { level: 'none', scope: [] },
                    authz: { decisionId: '' },
                  }
              rows.push(
                session.ev('tool/result', data, {
                  origin: 'system',
                  trust: projection?.trust === 'trusted' ? 'trusted' : 'untrusted',
                  sourceEventSeqs: [call.seq],
                }),
              )
            }
          }
        }
        const answers = new AcceptedAnswers()
        for (const entry of entries) answers.apply(entry.record)
        const accepted = answers.apply(record)
        if (accepted && isAnswerOutput(accepted.settled.settlement.output)) {
          const content = requireAssistantSettlement(accepted.settled.settlement).content.flatMap((block) =>
            block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [],
          )
          if (content.length)
            rows.push(
              session.ev(
                'assistant/message',
                { content, stopReason: 'end_turn' },
                {
                  origin: 'model',
                  sourceEventSeqs: [
                    next.cursor,
                    ...(options.acceptedAnswerSources?.(accepted.request) ?? []),
                  ],
                  surfaceOp: 'append',
                },
              ),
            )
        }
        const cost = projectJevCost(session, entries, record)
        if (cost) {
          const costSeq = next.cursor + rows.length
          rows.push(cost, jevCostOutbox(session, cost, costSeq))
        }
        const receipt = await session.d.log.append(rows)
        const cursor = receipt.firstSeq
        entries.push({ cursor, record })
        return cursor
      })
      await drainJevCostOutbox(session)
      await drainJevTreeBudget(session)
      return cursor
    },
  }
}

export function jevRecords(entries: readonly LedgerEntry<number>[]): readonly RuntimeRecord[] {
  return entries.map((entry) => entry.record)
}
