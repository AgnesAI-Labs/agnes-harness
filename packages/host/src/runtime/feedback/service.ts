import {
  FEEDBACK_EVENT,
  FEEDBACK_GROWTH_EVENT,
  type FeedbackItem,
  type FeedbackPorts,
  type FeedbackRequest,
  type FeedbackResult,
  type FeedbackService,
} from '@agnes/extension-api'
import { type Actor, type EventEnvelope, rpcError, validateMethod } from '@agnes/protocol'

function refuse(reason: string): never {
  throw rpcError('SEMANTIC_REJECTED', { reason })
}
const turnRange = (rows: readonly EventEnvelope[], turn: number | null) => {
  const start = rows.find(
    (row) =>
      row.type === 'turn/start' && row.lane === 'main' && (row.data as { turn?: number })?.turn === turn,
  )
  const end =
    start && rows.find((row) => row.seq > start.seq && row.type === 'turn/end' && row.lane === start.lane)
  return start && end ? { start, end } : undefined
}
const sameTarget = (a: FeedbackItem['target'], b: FeedbackItem['target'] | undefined) =>
  a.messageSeq === b?.messageSeq && a.turn === b?.turn
const counts = (items: readonly FeedbackItem[]) => ({
  up: items.filter((i) => !i.withdrawn && i.rating === 'up').length,
  down: items.filter((i) => !i.withdrawn && i.rating === 'down').length,
  withdrawn: items.filter((i) => i.withdrawn).length,
  withCandidate: items.filter((i) => i.candidateId !== null).length,
})
const trusted = (row: EventEnvelope) =>
  row.origin === 'system' && row.trust === 'trusted' && row.ignorable === true

/** Append-only human facts; current values are a projection, including withdrawal tombstones. */
export const createFeedbackService = (ports: FeedbackPorts): FeedbackService => {
  const tails = new Map<string, Promise<unknown>>()
  async function serialized<T>(id: string, run: () => Promise<T>): Promise<T> {
    const work = (tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(run)
    tails.set(id, work)
    try {
      return await work
    } finally {
      if (tails.get(id) === work) tails.delete(id)
    }
  }
  async function list(ids: readonly string[], signal: AbortSignal): Promise<FeedbackResult> {
    const items: FeedbackItem[] = []
    const growth: FeedbackResult['growth'] = []
    let truncated = false
    for (const id of ids) {
      signal.throwIfAborted()
      const rows = await ports.scan(id, [FEEDBACK_EVENT, FEEDBACK_GROWTH_EVENT])
      const current = new Map<string, FeedbackItem>()
      const revisions = new Map<number, FeedbackItem>()
      for (const row of rows) {
        signal.throwIfAborted()
        if (!trusted(row)) continue
        if (row.type === FEEDBACK_EVENT) {
          const item = { ...(row.data as Omit<FeedbackItem, 'revision'>), revision: row.seq }
          const probe = {
            items: [item],
            growth: [],
            counts: { up: 0, down: 0, withdrawn: 0, withCandidate: 0 },
            truncated: false,
          }
          if (
            !validateMethod('_agnes/v1/admin.feedback', 'result', probe).ok ||
            item.sessionId !== id ||
            item.actor !== row.actor.id
          )
            refuse('FEEDBACK_CORRUPT')
          current.set(item.id, item)
          revisions.set(row.seq, item)
        }
        if (row.type === FEEDBACK_GROWTH_EVENT) {
          const data = row.data as {
            feedbackId: string
            feedbackRevision: number
            messageSeq: number
            candidateId: string
            candidateHash: string
          }
          const source = revisions.get(data.feedbackRevision)
          if (
            !source ||
            source.id !== data.feedbackId ||
            source.target.messageSeq !== data.messageSeq ||
            source.actor !== row.actor.id
          )
            refuse('FEEDBACK_CORRUPT')
          const candidate = await ports.evidence(data.candidateId).catch(() => undefined)
          const verified =
            candidate &&
            candidate.origin.sessionKey === id &&
            candidate.origin.feedbackId === data.feedbackId &&
            candidate.origin.feedbackRevision === data.feedbackRevision &&
            candidate.origin.messageSeq === data.messageSeq
              ? candidate
              : undefined
          const value = {
            ...data,
            candidateHash: verified ? verified.candidateHash : data.candidateHash,
            reviewHash: verified ? verified.reviewHash : null,
            state: verified ? verified.state : 'unavailable',
            reviewer: verified ? verified.reviewer : null,
            packageId: verified ? verified.packageId : '',
            version: verified ? (verified.preview?.version ?? null) : null,
          }
          if (
            !validateMethod('_agnes/v1/admin.feedback', 'result', {
              items: [],
              growth: [value],
              counts: counts([]),
              truncated: false,
            }).ok
          )
            refuse('FEEDBACK_CORRUPT')
          growth.push(value)
          const item = current.get(data.feedbackId)
          if (item)
            current.set(item.id, {
              ...item,
              candidateId: data.candidateId,
              candidateHash: data.candidateHash,
            })
        }
      }
      items.push(...current.values())
      if (items.length > 4096 || growth.length > 4096) {
        items.splice(4096)
        growth.splice(4096)
        truncated = true
        break
      }
    }
    return { items, growth, counts: counts(items), truncated }
  }
  async function execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult> {
    signal.throwIfAborted()
    if (!validateMethod('_agnes/v1/admin.feedback', 'params', input).ok) throw rpcError('INVALID_PARAMS')
    if (input.action === 'list') {
      const scope = input.sessionId ? { ids: [input.sessionId], truncated: false } : await ports.sessions()
      const result = await list(scope.ids, signal)
      const items = result.items.filter(
        (i) =>
          (input.category === undefined || i.category === input.category) &&
          (input.rating === undefined || i.rating === input.rating) &&
          (input.hasCandidate === undefined || (i.candidateId !== null) === input.hasCandidate),
      )
      const retained = new Set(items.map((i) => i.id))
      return {
        ...result,
        items,
        growth: result.growth.filter((g) => retained.has(g.feedbackId)),
        counts: counts(items),
        truncated: result.truncated || scope.truncated,
      }
    }
    if (!input.sessionId) refuse('FEEDBACK_SESSION_REQUIRED')
    if (input.id !== undefined && !input.id) refuse('FEEDBACK_NOT_FOUND')
    const sessionId = input.sessionId!
    return serialized(sessionId, async () => {
      signal.throwIfAborted()
      const result = await list([sessionId], signal)
      const old = input.id
        ? result.items.find((i) => i.id === input.id)
        : result.items.find((i) => i.actor === actor.id && sameTarget(i.target, input.target))
      if (input.id && !old) refuse('FEEDBACK_NOT_FOUND')
      if (old && input.target && !sameTarget(old.target, input.target)) refuse('FEEDBACK_TARGET_MISMATCH')
      if (old && old.actor !== actor.id) refuse('FEEDBACK_ACTOR_MISMATCH')
      if ((old?.revision ?? null) !== input.expectedRevision) refuse('FEEDBACK_STALE')
      if (input.action === 'generate') {
        if (
          !old ||
          old.withdrawn ||
          old.target.messageSeq === null ||
          !(old.rating === 'down' || (old.rating === 'up' && old.category === 'do-again'))
        )
          refuse('FEEDBACK_GROWTH_INELIGIBLE')
        const source = old!
        if (
          result.growth.some(
            (value) => value.feedbackId === source.id && value.feedbackRevision === source.revision,
          )
        )
          return result
        let candidate = await ports.recoverCandidate(sessionId, source, signal)
        if (!candidate) {
          const rows = await ports.scan(sessionId, [
            'user/message',
            'assistant/message',
            'turn/start',
            'turn/end',
            'tool/call',
            'tool/result',
          ])
          signal.throwIfAborted()
          const range = turnRange(rows, source.target.turn)
          const evidence = range
            ? rows.filter(
                (row) =>
                  row.seq >= range.start.seq && row.seq <= range.end.seq && row.lane === range.start.lane,
              )
            : []
          if (
            !evidence.some((row) => row.seq === source.target.messageSeq && row.type === 'assistant/message')
          )
            refuse('FEEDBACK_EVIDENCE_UNAVAILABLE')
          const files = await ports.draft(sessionId, source, evidence, signal)
          signal.throwIfAborted()
          candidate = await ports.candidate(sessionId, source, files, signal)
        }
        if (
          candidate.origin.sessionKey !== sessionId ||
          candidate.origin.feedbackId !== source.id ||
          candidate.origin.feedbackRevision !== source.revision ||
          candidate.origin.messageSeq !== source.target.messageSeq
        )
          refuse('FEEDBACK_CORRUPT')
        // Once creation succeeds, retain its ledger link even if the caller cancels.
        await ports.append(
          sessionId,
          FEEDBACK_GROWTH_EVENT,
          {
            feedbackId: source.id,
            feedbackRevision: source.revision,
            messageSeq: source.target.messageSeq,
            candidateId: candidate.candidateId,
            candidateHash: candidate.candidateHash,
          },
          actor,
        )
        return list([sessionId], signal)
      }
      if (input.action === 'withdraw' && !old) refuse('FEEDBACK_NOT_FOUND')
      const target = old?.target ?? input.target
      if (!target || (target.messageSeq === null) !== (target.turn === null))
        refuse('FEEDBACK_TARGET_REQUIRED')
      if (input.action === 'put' && !input.rating) refuse('FEEDBACK_VALUE_REQUIRED')
      if (target.messageSeq !== null) {
        const rows = await ports.scan(sessionId, ['assistant/message', 'turn/start', 'turn/end'])
        const range = turnRange(rows, target.turn)
        if (
          !range ||
          !rows.some(
            (row) =>
              row.seq === target.messageSeq &&
              row.type === 'assistant/message' &&
              row.seq > range.start.seq &&
              row.seq < range.end.seq &&
              row.lane === range.start.lane,
          )
        )
          refuse('FEEDBACK_TARGET_NOT_SETTLED')
      }
      signal.throwIfAborted()
      const now = ports.now()
      const value = {
        id: old?.id ?? ports.id(),
        sessionId,
        target,
        rating: input.rating ?? old!.rating,
        category: input.category ?? old?.category ?? '',
        note: input.note ?? old?.note ?? '',
        actor: actor.id,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        withdrawn: input.action === 'withdraw',
        candidateId: old?.candidateId ?? null,
        candidateHash: old?.candidateHash ?? null,
      }
      await ports.append(sessionId, FEEDBACK_EVENT, value, actor)
      return list([sessionId], signal)
    })
  }
  return { execute }
}
