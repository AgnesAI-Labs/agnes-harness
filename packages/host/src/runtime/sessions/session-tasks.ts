import { randomUUID } from 'node:crypto'
import {
  applyBeforeRequestPatches,
  type ChildControlStore,
  type CostLedger,
  capToMicrocredits,
  chargeToMicrocredits,
  conservativeModelCredits,
  createEnvelopeCache,
  deriveRequest,
  hasChildControl,
  type SessionImpl,
  toProviderRequest,
} from '@agnes/core'
import type { SessionTasks } from '@agnes/host-extensions/assemble/packages'
import type { InferenceEvent } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import { askSideQuestion, SideQuestionError } from './session-side-question.js'

type Messages = Parameters<SessionTasks['generate']>[1]['messages']
const clip = (value: string, length: number) =>
  Array.from(value.slice(0, length * 2))
    .slice(0, length)
    .join('')

/** These tasks are optional, bounded and volatile. The only durable output is auxiliary usage. */
export function createSessionTasks(
  resolve: (ref: Parameters<SessionTasks['watch']>[0]) => SessionImpl | undefined,
): SessionTasks {
  const current = async (s: SessionImpl, turn: number) => {
    const [end, start] = await s.scan({
      type: ['turn/start', 'turn/end'],
      lane: s.lane,
      order: 'desc',
      limit: 2,
    })
    return (
      !s.closingOrClosed &&
      !s.op() &&
      !s.isRunning &&
      end?.type === 'turn/end' &&
      start?.type === 'turn/start' &&
      (start.data as { turn: number }).turn === turn &&
      (end.data as { reason: string }).reason === 'completed' &&
      typeof (end.data as { lastAssistantSeq: number | null }).lastAssistantSeq === 'number'
    )
  }
  return {
    watch(ref, listener) {
      const s = resolve(ref)
      if (!s) throw new Error('session unavailable')
      let alive = true
      let epoch = 0
      let turn: number | undefined
      const off = s.onAppended((events) => {
        for (const row of events) {
          if ((row.lane ?? 'main') !== ref.lane || !['turn/start', 'turn/end'].includes(row.type)) continue
          const data = row.data as { turn?: number; reason?: string; lastAssistantSeq?: number | null }
          if (row.type === 'turn/start') turn = data.turn
          if (turn === undefined) continue
          const completedTurn = turn
          const revision = ++epoch
          const reason = row.type === 'turn/start' ? 'running' : (data.reason ?? 'failed')
          listener({ turn: completedTurn, reason: reason === 'completed' ? 'pending' : reason, messages: [] })
          if (reason !== 'completed' || typeof data.lastAssistantSeq !== 'number') continue
          // Leave the commit callback and its phase lock before reading or starting model IO.
          void Promise.resolve()
            .then(async () => {
              const rows = await s.scan({
                type: ['user/message', 'assistant/message'],
                lane: s.lane,
                order: 'desc',
                limit: 6,
              })
              const messages: Messages = rows.reverse().flatMap((event) => {
                const content = (event.data as { content?: Array<{ type: string; text?: string }> }).content
                const text = clip(
                  (content ?? [])
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text ?? '')
                    .join('\n'),
                  800,
                )
                return text
                  ? [
                      {
                        role: event.type === 'user/message' ? ('user' as const) : ('assistant' as const),
                        content: [{ type: 'text' as const, text }],
                      },
                    ]
                  : []
              })
              const deadline = Date.now() + 5000
              while (alive && epoch === revision && s.isRunning && Date.now() < deadline)
                await new Promise<void>((resolve) => setTimeout(resolve, 25))
              if (alive && epoch === revision && (await current(s, completedTurn)))
                listener({ turn: completedTurn, reason, messages })
            })
            .catch(() => undefined)
        }
      })
      return () => {
        alive = false
        epoch++
        off()
      }
    },
    async generate(ref, input, signal) {
      const s = resolve(ref)
      if (!s) throw new Error('session unavailable')
      const work = async () => {
        if (signal.aborted || !(await current(s, input.turn))) return
        const route = s.preset.model.route.fast
        const modelId = s.preset.model.id.fast
        // No primary fallback: this operation needs a configured auxiliary model.
        if (!route || !modelId) return
        const model = s.d.provider.models().find((m) => m.route === route && m.id === modelId)
        if (!model) return
        const overrides = await s.scan({ type: 'x/core/turn-budget', order: 'desc', limit: 1 })
        const override = overrides[0]?.data as
          | { turn?: number; hard?: boolean; creditsCap?: number | null }
          | undefined
        if (override?.turn === input.turn && override.hard) return
        const budgetCap =
          override?.turn === input.turn
            ? (override.creditsCap ?? s.preset.budget.perRequestCap)
            : s.preset.budget.perRequestCap
        const maxTokens = 128
        let derived = deriveRequest({
          kind: 'summary',
          merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
          harnessEntries: [],
          surface: [],
          disclosed: [],
          model: { slot: 'fast', route, model: modelId },
          contract: s.d.contractForModel?.({ route, model: modelId }) ?? s.d.contract,
          nonce: randomUUID().replaceAll('-', ''),
          envelopeNonceFor: () => undefined,
          envelopeCache: createEnvelopeCache(),
          summaryPlan: {
            system: clip(input.system, 2000),
            instruction: JSON.stringify(
              input.messages
                .slice(-6)
                .map((m) => ({ ...m, content: m.content.map((b) => ({ ...b, text: clip(b.text, 800) })) })),
            ),
          },
        })
        derived = applyBeforeRequestPatches(derived, [
          { ext: 'host:auxiliary', patch: { maxTokens: Math.min(maxTokens, model.maxTokens) } },
        ])
        const wire = toProviderRequest(derived.request, {
          sessionKey: `aux:${randomUUID()}`,
          derivedHash: derived.header.derived_hash,
        })
        const tokens = new TextEncoder().encode(JSON.stringify(wire)).byteLength + maxTokens
        const projected = await abortable(
          s.d.runtime.billingProjected({ tokensEstimate: tokens, model: modelId }),
          signal,
        )
        const hold = Math.max(projected.credits, conservativeModelCredits(tokens, maxTokens, model.cost))
        if (
          !Number.isFinite(hold) ||
          (budgetCap !== null && hold > budgetCap) ||
          signal.aborted ||
          !(await current(s, input.turn))
        )
          return
        const effectId = `aux:${input.label}:${randomUUID()}`
        let permit: { store: ChildControlStore; id: string } | undefined
        if (s.preset.treeBudgetCredits !== null) {
          const store = s.d.log.storage
          if (!hasChildControl(store)) return
          const start = (await s.scan({ type: 'turn/start', lane: s.lane, order: 'desc', limit: 1 }))[0]
          if (!start) return
          const rootTaskId = `${s.key}:${s.lane}:${start.seq}`
          const scope = await store.ensureRootScope(rootTaskId, capToMicrocredits(s.preset.treeBudgetCredits))
          const reserved = await store.reserve({
            rootTaskId,
            scopeIds: [scope.scopeId],
            qMicro: chargeToMicrocredits(hold),
            effectId,
            requestHash: derived.header.derived_hash,
            writerGeneration: (await store.writerGeneration?.(rootTaskId)) ?? 1,
          })
          if (!reserved.ok) return
          permit = { store, id: reserved.permitId }
          if (signal.aborted || !(await current(s, input.turn))) {
            await store.releaseReservation(permit.id)
            return
          }
        }
        let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
        let text = ''
        let completed = false
        try {
          const iterator = s.d.provider
            .infer(wire, { signal, toolNames: [], retry: false })
            [Symbol.asyncIterator]()
          try {
            while (!signal.aborted) {
              const next = await abortable(iterator.next(), signal)
              if (next.done) break
              const event = next.value
              if (event.type === 'usage') usage = event
              if (event.type === 'text_delta') text += event.delta
              if (signal.aborted || text.length > 1024) break
              if (event.type === 'done') {
                completed = event.reason === 'stop'
                break
              }
              if (event.type === 'error' || event.type === 'toolcall_end' || event.type === 'deviation') break
            }
          } finally {
            void iterator.return?.().catch(() => undefined)
          }
        } finally {
          const spend: CostLedger = {
            purpose: 'side-call',
            sourceTurn: input.turn,
            effectId,
            model: modelId,
            route,
            tokens: usage?.tokens ?? {
              input: tokens,
              output: Math.ceil(text.length / 4),
              cacheRead: 0,
              cacheWrite: 0,
            },
            creditSource: usage?.creditSource ?? 'estimated',
            ...(usage?.credits === undefined ? {} : { credits: usage.credits }),
            ...(usage?.billing ? { billing: usage.billing } : {}),
            ...(!completed ? { interrupted: true } : {}),
          }
          const appended = await s.locked(() => s.append([s.ev('cost/ledger', spend)]))
          if (permit)
            await permit.store.settleOrigin({
              permitId: permit.id,
              originSessionKey: s.key,
              originCostSeq: appended.firstSeq,
              actualMicro: usage?.credits === undefined ? null : chargeToMicrocredits(usage.credits),
              complete: usage?.credits !== undefined,
              creditSource: usage?.creditSource ?? 'unknown',
            })
          const recorded = await s.d.runtime.billingRecord({
            ...spend,
            sessionKey: s.key,
            lane: s.lane,
            turn: input.turn,
            step: 0,
          })
          if (!recorded) completed = false
        }
        if (completed && !signal.aborted && (await current(s, input.turn))) return text
      }
      return s.d.withModelSnapshot ? s.d.withModelSnapshot(work) : work()
    },
    async review(ref, input, signal) {
      const s = resolve(ref)
      if (!s) throw new Error('session unavailable')
      try {
        // The side question's conversation view stops before an open turn, so carry that turn's
        // user request here; without it the reviewer cannot judge what the user actually asked for.
        const [request] = await s.scan({ type: 'user/message', lane: s.lane, order: 'desc', limit: 1 })
        const asked = clip(
          ((request?.data as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n'),
          800,
        )
        const data = asked ? `Latest user request:\n${asked}\n\n${input.data}` : input.data
        const answer = await askSideQuestion(s as unknown as HostSession, clip(data, 6000), {
          slots: ['verifier', 'fast'],
          system: clip(input.system, 2000),
          maxTokens: 300,
          label: input.label,
          timeoutMs: input.timeoutMs ?? 15_000,
          signal,
        })
        return answer.text
      } catch (error) {
        // Unavailable, over budget, timed out or failed all mean "no review this time".
        if (error instanceof SideQuestionError) return undefined
        throw error
      }
    },
  }
}

/** An uncooperative adapter must not hold the background task open after its deadline. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('auxiliary cancelled'))
  })
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
