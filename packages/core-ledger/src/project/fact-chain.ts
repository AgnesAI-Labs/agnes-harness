import { ToolReviewFact, validateAgainst } from '@agnes/protocol'
import type {
  ArtifactRef,
  EventEnvelope,
  FactChainAnchor,
  FactChainNode,
  FactChainResult,
} from '@agnes/protocol'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown, max = 128): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
const hash = (value: unknown) => (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null)
const core = (event: EventEnvelope) => event.origin === 'system' && event.trust === 'trusted'
const sameRef = (a: ArtifactRef, b: ArtifactRef) =>
  a.sha256 === b.sha256 && a.size === b.size && a.mime === b.mime
const synthetic = new Set([
  'TOOL_OUTCOME_UNKNOWN',
  'TOOL_DISPATCH_FAILED',
  'TOOL_DISPATCH_NOT_SENT',
  'CANCELLED',
  'AUTHZ_DENIED',
  'HOOK_DENIED',
  'TOOL_NOT_DISCLOSED',
  'APPROVAL_REJECTED',
])

/** Only explicit ledger identities establish edges. Timeline proximity is not causal evidence. */
export function projectFactChain(input: {
  sessionId: string
  laneId: string
  anchor: FactChainAnchor
  atSeq: number
  events: readonly EventEnvelope[]
  truncated?: boolean
}): FactChainResult {
  const { sessionId, laneId, anchor, atSeq } = input
  const result: FactChainResult = { sessionId, laneId, atSeq, nodes: [], edges: [], gaps: [] }
  const events = input.events.filter((row) => (row.lane ?? 'main') === laneId && row.seq <= atSeq)
  const bySeq = new Map(events.map((row) => [row.seq, row]))
  const nodes = new Map<string, FactChainNode>()
  const edges: FactChainResult['edges'] = []
  const gaps: FactChainResult['gaps'] = []
  const add = (node: FactChainNode) => nodes.set(node.id, node)
  const gap = (at: string, reason: FactChainResult['gaps'][number]['reason']) => gaps.push({ at, reason })
  const edge = (
    from: string,
    to: string,
    relation: FactChainResult['edges'][number]['relation'],
    evidence: number[],
  ) => {
    edges.push({ from, to, relation, evidence: evidence.slice(0, 8), basis: 'ledger' })
  }
  const calls = events.filter((row) => row.type === 'tool/call')
  const callIds = new Map<string, number>()
  for (const call of calls) {
    const id = text(object(call.data).toolUseId)
    if (id) callIds.set(id, (callIds.get(id) ?? 0) + 1)
  }
  for (const call of calls) {
    const data = object(call.data),
      toolUseId = text(data.toolUseId)
    if (!toolUseId || callIds.get(toolUseId) !== 1) continue
    const id = `tool:${laneId}:${toolUseId}`
    const intents = events.filter(
      (row) =>
        row.type === 'effect/intent' &&
        core(row) &&
        object(object(row.data).tool).toolUseId === toolUseId &&
        object(row.data).argsSeq === call.seq,
    )
    const intent = intents.length === 1 ? intents[0] : undefined
    const intentData = object(intent?.data),
      effectId = text(intentData.effectId)
    const links = events.filter(
      (row) => row.type === 'x/core/loop-effect' && core(row) && object(row.data).toolUseId === toolUseId,
    )
    const link = links.length === 1 ? links[0] : undefined
    const reviewEvent = events.findLast(
      (row) =>
        row.type === 'x/approval/review' &&
        core(row) &&
        object(row.data).toolUseId === toolUseId &&
        row.sourceEventSeqs?.includes(call.seq),
    )
    const review = object(reviewEvent?.data).review
    add({
      ...(validateAgainst(ToolReviewFact, review).ok ? { review: review as ToolReviewFact } : {}),
      id,
      kind: 'invocation',
      toolUseId,
      name: text(data.name, 256) ?? 'tool',
      callSeq: call.seq,
      invocationId: text(object(link?.data).invocationId),
      effectId,
      definitionFingerprint: hash(data.definitionFingerprint),
      policyHash: hash(data.policyHash),
      parentEffectId: text(intentData.parentEffectId),
    })
    // The legacy UI span's "active inference" is a layout heuristic, never a fact-chain edge.
    gap(id, 'ambiguous-link')
    if (intents.length > 1 || links.length > 1) gap(id, 'ambiguous-link')
    const receipts = events.filter(
      (row) =>
        row.type === 'tool/result' &&
        object(row.data).toolUseId === toolUseId &&
        row.sourceEventSeqs?.includes(call.seq),
    )
    const settlements = effectId
      ? events.filter(
          (row) => row.type === 'effect/settled' && core(row) && object(row.data).effectId === effectId,
        )
      : []
    const deferred = events.find(
      (row) => row.type === 'x/core/deferred-job' && core(row) && object(row.data).toolUseId === toolUseId,
    )
    const receipt = receipts.length === 1 ? receipts[0] : undefined
    const settlement = settlements.length === 1 ? settlements[0] : undefined
    const rd = object(receipt?.data),
      sd = object(settlement?.data),
      code = text(rd.code)
    const uncertain =
      !receipt || code === 'TOOL_OUTCOME_UNKNOWN' || sd.outcome === 'unknown' || receipts.length > 1
    const outcome = uncertain
      ? 'unknown'
      : rd.isError === true
        ? code === 'CANCELLED'
          ? 'aborted'
          : 'error'
        : 'ok'
    const receiptId = receipt ? `receipt:${receipt.seq}` : `receipt:${call.seq}:unavailable`
    add({
      id: receiptId,
      kind: 'receipt',
      toolUseId,
      resultSeq: receipt?.seq ?? null,
      settledSeq: settlement?.seq ?? null,
      isError: receipt ? rd.isError === true : null,
      code,
      outcome,
      resultKind: receipt
        ? code && synthetic.has(code)
          ? 'synthetic'
          : 'actual'
        : deferred
          ? 'deferred-accepted'
          : 'unavailable',
      partial: rd.partial === true,
      externalOutcome: 'unknown',
    })
    edge(id, receiptId, receipt || settlement ? 'settled' : 'status', [
      call.seq,
      ...(receipt ? [receipt.seq] : []),
      ...(settlement ? [settlement.seq] : []),
      ...(deferred ? [deferred.seq] : []),
    ])
    if (uncertain) gap(receiptId, receipts.length > 1 ? 'ambiguous-link' : 'in-progress')
  }
  for (const row of events) {
    if (row.type !== 'request/sent') continue
    const data = object(row.data),
      callId = text(data.requestTraceId)
    if (!callId) continue
    const id = `request:${callId}`
    add({
      id,
      kind: 'request',
      callId,
      seq: row.seq,
      model: text(object(data.model).id, 512) ?? '',
      generationId: null,
      derivedHash: hash(data.derived_hash),
      promptHash: null,
      toolSchemaHash: hash(data.tool_schema_hash),
      messagesHash: null,
      memoryRevision: null,
      memoryHash: null,
      hashBasis: 'ledger-stamp',
      incomplete: true,
    })
    gap(id, 'capture-unavailable')
    const intent = (row.sourceEventSeqs ?? [])
      .map((seq) => bySeq.get(seq))
      .find((source) => source?.type === 'effect/intent' && core(source))
    const effectId = text(object(intent?.data).effectId)
    // An explicit parent effect proves nesting, not that the model returned this tool call.
    for (const node of nodes.values())
      if (node.kind === 'invocation' && effectId && node.parentEffectId === effectId)
        edge(id, node.id, 'dispatched', [row.seq, intent!.seq, node.callSeq])
  }
  for (const row of events) {
    if (row.type !== 'tool/result') continue
    const data = object(row.data),
      toolUseId = text(data.toolUseId)
    const tool = toolUseId ? `tool:${laneId}:${toolUseId}` : ''
    const call = nodes.get(tool)
    if (
      call?.kind !== 'invocation' ||
      !row.sourceEventSeqs?.includes(call.callSeq) ||
      !Array.isArray(data.artifactRefs)
    )
      continue
    for (const [index, value] of data.artifactRefs.slice(0, 64).entries()) {
      const ref = object(value)
      if (!hash(ref.sha256) || !Number.isSafeInteger(ref.size) || Number(ref.size) < 0 || !text(ref.mime))
        continue
      const artifact: ArtifactRef = {
        sha256: ref.sha256 as string,
        size: ref.size as number,
        mime: ref.mime as string,
      }
      const id = `artifact:${row.seq}:${index}:${artifact.sha256}`
      add({ id, kind: 'artifact', seq: row.seq, ref: artifact, relation: 'produced' })
      edge(tool, id, 'produced', [call.callSeq, row.seq])
    }
    if (data.artifactRefsTruncated === true) gap(tool, 'truncated')
  }
  for (const row of events) {
    if (row.type !== 'artifact/job') continue
    const data = object(row.data),
      ref = object(data.ref)
    if (!hash(ref.sha256) || !Number.isSafeInteger(ref.size) || Number(ref.size) < 0 || !text(ref.mime))
      continue
    const artifact: ArtifactRef = {
      sha256: ref.sha256 as string,
      size: ref.size as number,
      mime: ref.mime as string,
    }
    const id = `artifact:${row.seq}:${artifact.sha256}`
    const sources = (row.sourceEventSeqs ?? [])
      .map((seq) => bySeq.get(seq))
      .filter((source) => source?.type === 'tool/result' || source?.type === 'tool/call')
    const source = core(row) && data.status === 'done' && sources.length === 1 ? sources[0] : undefined
    const toolUseId = text(object(source?.data).toolUseId),
      tool = toolUseId ? `tool:${laneId}:${toolUseId}` : null
    const proved = tool && nodes.has(tool)
    add({ id, kind: 'artifact', seq: row.seq, ref: artifact, relation: proved ? 'produced' : 'recorded' })
    if (proved) edge(tool, id, 'produced', [source!.seq, row.seq])
    else gap(id, 'legacy-unlinked')
  }
  let selected: string | undefined
  if (anchor.kind === 'tool') selected = `tool:${laneId}:${anchor.toolUseId}`
  if (anchor.kind === 'request') selected = `request:${anchor.callId}`
  if (anchor.kind === 'artifact') {
    const node = [...nodes.values()].find(
      (value) => value.kind === 'artifact' && value.seq === anchor.seq && sameRef(value.ref, anchor.ref),
    )
    if (node?.kind === 'artifact' && sameRef(node.ref, anchor.ref)) selected = node.id
  }
  if (!selected || !nodes.has(selected)) {
    result.gaps.push({
      at: null,
      reason: input.truncated
        ? 'truncated'
        : anchor.kind === 'tool' && (callIds.get(anchor.toolUseId) ?? 0) > 1
          ? 'ambiguous-link'
          : 'source-unavailable',
    })
    return result
  }
  const connected = new Set([selected])
  for (let changed = true; changed; ) {
    changed = false
    for (const e of edges)
      if (connected.has(e.from) || connected.has(e.to)) {
        if (!connected.has(e.from) || !connected.has(e.to)) changed = true
        connected.add(e.from)
        connected.add(e.to)
      }
  }
  result.nodes = [...nodes.values()].filter((node) => connected.has(node.id)).slice(0, 256)
  const retained = new Set(result.nodes.map((node) => node.id))
  result.edges = edges.filter((e) => retained.has(e.from) && retained.has(e.to)).slice(0, 512)
  result.gaps = gaps.filter((g) => g.at && retained.has(g.at)).slice(0, 254)
  if (input.truncated || connected.size > 256) result.gaps.push({ at: null, reason: 'truncated' })
  return result
}
