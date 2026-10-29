import type { EventEnvelope, FactChainResult, UiSurfaceRecord } from '@agnes/protocol'

const prefix = 'x/agnes/intelligent-ui/'
export const intelligentUiFactTypes = [
  'surface.opened',
  'surface.updated',
  'surface.closed',
  ...[
    'received',
    'rejected',
    'executing',
    'pending-approval',
    'succeeded',
    'failed',
    'retried',
    'delivered',
  ].map((state) => `action.${state}`),
].map((name) => prefix + name)

/** Add only explicitly linked plugin facts to an already authorized, bounded tool graph. */
export function appendIntelligentUiFactChain(result: FactChainResult, rows: readonly EventEnvelope[]) {
  const facts = rows
    .filter(
      (row) =>
        row.seq <= result.atSeq &&
        row.lane === result.laneId &&
        row.origin === 'ext:agnes/intelligent-ui' &&
        intelligentUiFactTypes.includes(row.type),
    )
    .sort((a, b) => a.seq - b.seq)
  const invocations = result.nodes.filter((node) => node.kind === 'invocation')
  for (const received of facts.filter((row) => row.type === prefix + 'action.received')) {
    const record = (
      received.data as unknown as {
        record?: {
          request: { surfaceId: string; revision: number; commandId: string }
          surfaceSeq?: number
          invocation?: { id: string }
        }
      }
    ).record
    if (!record?.invocation || !record.request) continue
    const tool = invocations.find((node) => node.invocationId === record.invocation!.id)
    if (!tool) continue
    const selected = facts.filter((row) => {
      const data = row.data as unknown as {
        record?: { surface?: { id: string }; request?: { commandId: string } }
        commandId?: string
      }
      return (
        data.record?.surface?.id === record.request.surfaceId ||
        (data.record?.request?.commandId ?? data.commandId) === record.request.commandId
      )
    })
    const queueRows = rows.filter(
      (row) =>
        row.seq <= result.atSeq &&
        row.lane === result.laneId &&
        row.origin === 'system' &&
        row.trust === 'trusted' &&
        row.type === 'x/agnes/deferred-invocations/state' &&
        (row.data as unknown as { invocation?: { id: string; source: string; sourceSeq: number } }).invocation
          ?.id === record.invocation!.id,
    )
    for (const row of queueRows) {
      const data = row.data as unknown as {
        invocation: { source: string; sourceSeq: number }
        state: string
        previousSeq?: number
      }
      if (data.invocation.source !== 'agnes/intelligent-ui' || data.invocation.sourceSeq !== received.seq)
        continue
      const id = `ui-fact:${result.laneId}:${row.seq}`
      result.nodes.push({
        id,
        kind: 'plugin-fact',
        seq: row.seq,
        namespace: 'agnes/deferred-invocations',
        event: `invocation.${data.state}`,
        label: record.request.commandId,
        state: data.state,
        surfaceId: record.request.surfaceId,
        revision: record.request.revision,
        commandId: record.request.commandId,
      })
      if (data.previousSeq && !queueRows.some((item) => item.seq === data.previousSeq))
        result.gaps.push({ at: id, reason: 'source-unavailable' })
      const predecessor = data.previousSeq ?? received.seq
      result.edges.push({
        from: `ui-fact:${result.laneId}:${predecessor}`,
        to: id,
        relation: 'status',
        evidence: [predecessor, row.seq],
        basis: 'ledger',
      })
    }
    const selectedSeqs = new Set(selected.map((row) => row.seq))
    for (const row of selected) {
      const data = row.data as unknown as {
        record?: UiSurfaceRecord
        sourceSeq?: number
        inboxSeq?: number
        deferredSeq?: number
        receipt?: { resultSeq?: number }
      }
      const event = row.type.slice(prefix.length)
      const surface = data.record?.surface
      const id = `ui-fact:${result.laneId}:${row.seq}`
      if (!result.nodes.some((node) => node.id === id))
        result.nodes.push({
          id,
          kind: 'plugin-fact',
          seq: row.seq,
          namespace: 'agnes/intelligent-ui',
          event,
          label: surface?.title ?? record.request.commandId,
          state: event.split('.').at(-1)!,
          surfaceId: surface?.id ?? record.request.surfaceId,
          revision: surface?.revision ?? record.request.revision,
          ...(!surface ? { commandId: record.request.commandId } : {}),
        })
      if (
        data.deferredSeq &&
        result.nodes.some((node) => node.id === `ui-fact:${result.laneId}:${data.deferredSeq}`)
      )
        result.edges.push({
          from: `ui-fact:${result.laneId}:${data.deferredSeq}`,
          to: id,
          relation: 'status',
          evidence: [data.deferredSeq, row.seq],
          basis: 'ledger',
        })
      if (data.receipt?.resultSeq) {
        const receipt = result.nodes.find(
          (node) => node.kind === 'receipt' && node.resultSeq === data.receipt!.resultSeq,
        )
        if (receipt)
          result.edges.push({
            from: receipt.id,
            to: id,
            relation: 'status',
            evidence: [data.receipt.resultSeq, row.seq],
            basis: 'ledger',
          })
        else result.gaps.push({ at: id, reason: 'source-unavailable' })
      }
      if (data.inboxSeq) {
        const inbox = rows.find(
          (item) =>
            item.seq === data.inboxSeq &&
            item.lane === result.laneId &&
            item.type === 'inbox' &&
            item.origin === 'system' &&
            item.trust === 'trusted',
        )
        const items = (inbox?.data as unknown as { items?: { commandId?: string }[] })?.items
        if (items?.some((item) => item.commandId === `ui-result:${record.request.commandId}`)) {
          const queuedId = `ui-input:${result.laneId}:${data.inboxSeq}`
          if (!result.nodes.some((node) => node.id === queuedId))
            result.nodes.push({
              id: queuedId,
              kind: 'plugin-fact',
              seq: data.inboxSeq,
              namespace: 'agnes/session-input',
              event: 'input.queued',
              label: record.request.commandId,
              state: 'recorded',
              surfaceId: record.request.surfaceId,
              revision: record.request.revision,
              commandId: record.request.commandId,
            })
          result.edges.push({
            from: queuedId,
            to: id,
            relation: 'status',
            evidence: [data.inboxSeq, row.seq],
            basis: 'ledger',
          })
        } else result.gaps.push({ at: id, reason: 'source-unavailable' })
      }
      const previous = data.sourceSeq
      if (previous && selectedSeqs.has(previous))
        result.edges.push({
          from: `ui-fact:${result.laneId}:${previous}`,
          to: id,
          relation: 'status',
          evidence: [previous, row.seq],
          basis: 'ledger',
        })
      else if (previous && event !== 'surface.opened')
        result.gaps.push({ at: id, reason: 'source-unavailable' })
    }
    result.edges.push({
      from: `ui-fact:${result.laneId}:${received.seq}`,
      to: tool.id,
      relation: 'dispatched',
      evidence: [received.seq, tool.callSeq],
      basis: 'ledger',
    })
    if (record.surfaceSeq && !selectedSeqs.has(record.surfaceSeq))
      result.gaps.push({ at: `ui-fact:${result.laneId}:${received.seq}`, reason: 'source-unavailable' })
  }
}
