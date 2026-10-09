import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { projectFactChain, type RequestTraceStore, type ScanRead } from '@agnes/host'
import type {
  AuthoringCandidate,
  EventEnvelope,
  FactChainNode,
  FactChainParams,
  FactChainResult,
} from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { FactChainNode as NodeSchema } from '@agnes/protocol/gen/agnes-v1'
import { appendIntelligentUiFactChain, intelligentUiFactTypes } from './intelligent-ui-fact-chain.js'

const types = [
  ...intelligentUiFactTypes,
  'x/agnes/deferred-invocations/state',
  'inbox',
  'request/sent',
  'request/header',
  'tool/call',
  'x/approval/review',
  'tool/result',
  'effect/intent',
  'effect/settled',
  'artifact/job',
  'x/core/loop-effect',
  'x/core/deferred-job',
]
/** One bounded read. No registry.open, writer claim, plugin assembly or external dispatch. */
export function registerFactChain(
  endpoint: LocalEndpoint,
  deps: {
    requireSessionOwner(method: string, sessionId: string, context: CallContext): void
    scan(sessionId: string): ScanRead<EventEnvelope>
    traces?: Pick<RequestTraceStore, 'metadata'>
    binding?(sessionId: string, generationId: string | null): Promise<FactChainNode[]> | FactChainNode[]
    candidate?(candidateId: string, context: CallContext): Promise<AuthoringCandidate>
    clock?: () => number
  },
) {
  endpoint.register('_agnes/v1/session.factChain', async (params, context): Promise<FactChainResult> => {
    const { sessionId, laneId, anchor } = params as FactChainParams
    deps.requireSessionOwner('session.factChain', sessionId, context)
    const empty: FactChainResult = { sessionId, laneId, atSeq: 0, nodes: [], edges: [], gaps: [] }
    const clock = deps.clock ?? Date.now,
      started = clock()
    const read = async <T>(source: () => T | Promise<T>): Promise<T> => {
      const remaining = 5000 - (clock() - started)
      if (remaining <= 0) throw new Error('Read budget exhausted')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve().then(source),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Read budget exhausted')), remaining)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    let rows: EventEnvelope[] = [],
      truncated = false,
      atSeq = 0
    try {
      const scan = deps.scan(sessionId)
      const head = (await read(() => scan({ order: 'desc', limit: 1 })))[0]
      atSeq = head?.seq ?? 0
      let toSeq = atSeq,
        bytes = 0
      while (toSeq > 0 && rows.length < 2000 && clock() - started < 5000) {
        const page = await read(() => scan({ type: types, lane: laneId, order: 'desc', toSeq, limit: 100 }))
        for (const row of page) {
          bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength
          if (bytes > 4 * 1024 * 1024) {
            truncated = true
            break
          }
          rows.push(row)
        }
        if (truncated || page.length < 100) {
          toSeq = 0
          break
        }
        toSeq = page.at(-1)!.seq - 1
      }
      truncated ||= toSeq > 0
    } catch {
      return { ...empty, gaps: [{ at: null, reason: 'source-unavailable' }] }
    }
    let candidate: AuthoringCandidate | undefined
    if (anchor.kind === 'authoring') {
      try {
        candidate = await read(() => deps.candidate?.(anchor.candidateId, context))
        if (!candidate || candidate.origin.sessionKey !== sessionId) throw new Error('Unavailable')
      } catch {
        return { ...empty, atSeq, gaps: [{ at: null, reason: 'source-unavailable' }] }
      }
    }
    const result = projectFactChain({
      sessionId,
      laneId,
      anchor: candidate ? { kind: 'tool', toolUseId: candidate.origin.toolUseId } : anchor,
      atSeq,
      events: rows,
      truncated,
    })
    // Missing anchors disclose no captured request, composition, package or candidate metadata.
    if (!result.nodes.length) return result
    appendIntelligentUiFactChain(result, rows)
    for (const node of [...result.nodes]) {
      if (node.kind !== 'request') continue
      try {
        const capture = await read(() => deps.traces?.metadata(sessionId, node.callId))
        if (
          !capture ||
          !validateAgainst(NodeSchema, capture.request).ok ||
          capture.attempts.some((attempt) => !validateAgainst(NodeSchema, attempt).ok)
        ) {
          result.gaps.push({ at: node.id, reason: 'not-retained' })
          continue
        }
        const request = { ...capture.request, seq: node.seq }
        // Keep ledger hashes in their own basis: never equate them to redacted capture hashes.
        result.nodes[result.nodes.indexOf(node)] = request
        result.gaps = result.gaps.filter(
          (gap) => !(gap.at === node.id && gap.reason === 'capture-unavailable'),
        )
        for (const attempt of capture.attempts) {
          result.nodes.push(attempt)
          result.edges.push({
            from: node.id,
            to: attempt.id,
            relation: 'attempted',
            evidence: [],
            basis: 'request-capture',
          })
          if (attempt.wireUnavailable) result.gaps.push({ at: attempt.id, reason: 'capture-unavailable' })
        }
      } catch {
        result.gaps.push({ at: node.id, reason: 'capture-unavailable' })
      }
    }
    if (candidate) {
      const id = `authoring:${candidate.candidateId}`
      const testsMatch = candidate.tests?.hash === candidate.candidateHash
      result.nodes.push({
        id,
        kind: 'authoring',
        candidateId: candidate.candidateId,
        packageId: candidate.packageId,
        version: candidate.preview?.version ?? null,
        state: candidate.state,
        candidateHash: candidate.candidateHash,
        reviewHash: candidate.reviewHash,
        baseHash: candidate.baseHash,
        testHash: candidate.tests?.hash ?? null,
        testsState: testsMatch ? candidate.tests!.state : null,
        testsCount: testsMatch ? candidate.tests!.count : 0,
        reviewed: candidate.reviewer !== null && candidate.reviewHash !== null && testsMatch,
        turn: candidate.origin.turn,
        toolUseId: candidate.origin.toolUseId,
      })
      result.edges.push({
        from: `tool:${laneId}:${candidate.origin.toolUseId}`,
        to: id,
        relation: 'drafted',
        evidence: [],
        basis: 'authoring-record',
      })
      if (!testsMatch) result.gaps.push({ at: id, reason: 'source-unavailable' })
    }
    const requests = result.nodes.filter(
      (node): node is Extract<FactChainNode, { kind: 'request' }> => node.kind === 'request',
    )
    const generations = [...new Set(requests.map((node) => node.generationId))]
    for (const generationId of generations.length ? generations : [null]) {
      try {
        const bindings = (await read(() => deps.binding?.(sessionId, generationId))) ?? []
        for (const binding of bindings) {
          if (!validateAgainst(NodeSchema, binding).ok) throw new Error('Unavailable')
          if (!result.nodes.some((node) => node.id === binding.id)) result.nodes.push(binding)
          for (const request of requests.filter((node) => node.generationId === generationId))
            result.edges.push({
              from: binding.id,
              to: request.id,
              relation: 'bound',
              evidence: [],
              basis: binding.kind === 'generation' ? 'generation-snapshot' : 'composition-binding',
            })
        }
        if (generationId && !bindings.some((node) => node.kind === 'generation'))
          throw new Error('Unavailable')
        if (!generationId) result.gaps.push({ at: null, reason: 'resource-version-unavailable' })
      } catch {
        result.gaps.push({ at: null, reason: 'resource-version-unavailable' })
      }
    }
    if (result.nodes.length > 256 || result.edges.length > 512 || result.gaps.length > 255)
      result.gaps = [...result.gaps.slice(0, 254), { at: null, reason: 'truncated' }]
    result.nodes = result.nodes.slice(0, 256)
    const retained = new Set(result.nodes.map((node) => node.id))
    result.edges = result.edges
      .filter((edge) => retained.has(edge.from) && retained.has(edge.to))
      .slice(0, 512)
    result.gaps = result.gaps.filter((gap) => !gap.at || retained.has(gap.at)).slice(0, 256)
    return result
  })
}
