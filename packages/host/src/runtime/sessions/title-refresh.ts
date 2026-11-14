import type { SideCallExecutionSource } from '@agnes/core'
import {
  type AutoTitleInspection,
  type AutoTitleRefreshResult,
  redactSecrets,
  type SessionWorkTitlePort,
} from '@agnes/extension-api'
import { readSessionTitle, SESSION_TITLE_EVENT, type SessionTitleRecord } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import { TITLE_COST_EVENT, titleEffectId } from './title-accounting.js'
import type { AutoTitleEligibility } from './title-eligibility.js'
import { generateTitleWithModelSnapshot } from './title-generator.js'

export async function acceptedSessionTitle(session: HostSession) {
  let toSeq = session.lastSeq
  while (toSeq > 0) {
    const rows = await session.scan({
      type: [SESSION_TITLE_EVENT, 'session/start'],
      toSeq,
      order: 'desc',
      limit: 100,
    })
    for (const row of rows) {
      if (row.type === 'session/start') return undefined
      const record = readSessionTitle(row)
      if (record?.status === 'generated') return { record, revision: row.seq }
    }
    if (!rows.length) return undefined
    const last = rows.at(-1)
    if (!last) return undefined
    toSeq = last.seq - 1
  }
  return undefined
}

/** Conditional Host acceptance; attempts never replace the last successful title. */
export function createTitleRefresh(
  session: HostSession,
  input: {
    source: SideCallExecutionSource
    signal: AbortSignal
    eligible: AutoTitleEligibility
    spendAllowed?: () => boolean
    billingFailed?: () => void
  },
): SessionWorkTitlePort & { close(): Promise<void>; drained(): Promise<void> } {
  const identity = session.state.session
  let attempted = false
  const pending = new Set<Promise<unknown>>()
  let transport = Promise.resolve()
  const live = () => !input.signal.aborted && !session.closingOrClosed && session.state.session === identity
  const inspect = async (): Promise<AutoTitleInspection> => {
    if (!live()) return { eligible: false, reason: 'closed' }
    if (input.source.hard || input.spendAllowed?.() === false) return { eligible: false, reason: 'budget' }
    let allowed = false
    try {
      allowed = await input.eligible(session.key, input.signal)
    } catch {
      return { eligible: false, reason: 'unavailable' }
    }
    if (!live()) return { eligible: false, reason: 'closed' }
    if (!allowed) return { eligible: false, reason: 'explicit-title' }
    const title = await acceptedSessionTitle(session)
    if (!live()) return { eligible: false, reason: 'closed' }
    return title
      ? { eligible: true, title: title.record.title, revision: title.revision }
      : { eligible: false, reason: 'no-title' }
  }
  const port: SessionWorkTitlePort = {
    inspect,
    async refresh(request: Parameters<SessionWorkTitlePort['refresh']>[0]): Promise<AutoTitleRefreshResult> {
      if (
        typeof request.context !== 'string' ||
        request.context.length > 2000 ||
        !request.context.trim() ||
        !Number.isSafeInteger(request.expectedRevision)
      )
        return { status: 'unavailable' }
      const view = await inspect()
      if (!view.eligible) return { status: 'ineligible' }
      if (view.revision !== request.expectedRevision) return { status: 'stale' }
      if (attempted) return { status: 'unavailable' }
      attempted = true
      const prior = await acceptedSessionTitle(session)
      if (!prior || prior.revision !== request.expectedRevision) return { status: 'stale' }
      const refreshSource = { endSeq: input.source.endSeq, expectedRevision: request.expectedRevision }
      const effectId = titleEffectId(session, input.source.startSeq, refreshSource)
      let fromSeq = input.source.endSeq
      const throughSeq = session.lastSeq
      while (fromSeq <= throughSeq) {
        const previous = await session.scan({
          type: 'x/host/title-refresh',
          fromSeq,
          toSeq: throughSeq,
          limit: 100,
        })
        if (
          previous.some(
            (row) =>
              row.origin === 'system' &&
              row.trust === 'trusted' &&
              (row.data as { effectId?: string }).effectId === effectId,
          )
        )
          return { status: 'unavailable' }
        if (!previous.length) break
        const last = previous.at(-1)
        if (!last) break
        fromSeq = last.seq + 1
      }
      const route = session.preset.model.route.primary
      const model =
        session.preset.model.id.primary ??
        session.d.provider.models().find((entry) => entry.route === route && entry.slot === 'primary')?.id
      if (!route || !model) return { status: 'unavailable' }
      const seed: SessionTitleRecord = {
        ...prior.record,
        status: 'pending',
        turn: input.source.turn,
        startSeq: input.source.startSeq,
        route,
        model,
        prompt: redactSecrets(request.context),
        budgetCap: input.source.budgetCap,
        treeBudgetCap: input.source.treeBudgetCap,
      }
      // A generated record's title is not a field on a pending request.
      delete (seed as { title?: string }).title
      let record: SessionTitleRecord | undefined = seed
      let result: AutoTitleRefreshResult = { status: 'unavailable' }
      const save = async (next: SessionTitleRecord) => {
        if (!live()) return
        const eligibility = await inspect()
        if (!eligibility.eligible || eligibility.revision !== request.expectedRevision) {
          record = undefined
          return
        }
        await session.locked(async () => {
          if (!live()) return
          await session.append([
            session.ev(
              'x/host/title-refresh',
              {
                effectId,
                status: next.status,
                sourceTurn: input.source.turn,
                expectedRevision: request.expectedRevision,
              },
              { ignorable: true },
            ),
          ])
          record = next
        })
      }
      const generate = () =>
        generateTitleWithModelSnapshot(session, seed, {
          signal: input.signal,
          effectId,
          refresh: refreshSource,
          current: () => record,
          save,
          retainTransport(work) {
            transport = work
          },
          onError() {
            input.billingFailed?.()
          },
          accept: async (outcome, spend, proof) => {
            const eligibility = await inspect()
            return session.locked(async () => {
              const current = await acceptedSessionTitle(session)
              const same = current?.revision === request.expectedRevision
              const apply =
                live() &&
                eligibility.eligible &&
                same &&
                outcome.status === 'generated' &&
                outcome.title !== current?.record.title
              result = !same
                ? { status: 'stale' }
                : !live() || !eligibility.eligible
                  ? { status: 'ineligible' }
                  : outcome.status !== 'generated'
                    ? { status: 'unavailable' }
                    : { status: apply ? 'applied' : 'unchanged' }
              return session.append([
                session.ev('cost/ledger', spend),
                session.ev(TITLE_COST_EVENT, proof, { ignorable: true }),
                session.ev(
                  'x/host/title-refresh',
                  {
                    effectId,
                    status: result.status,
                    sourceTurn: input.source.turn,
                    expectedRevision: request.expectedRevision,
                  },
                  { ignorable: true },
                ),
                ...(apply ? [session.ev(SESSION_TITLE_EVENT, outcome, { ignorable: true })] : []),
              ])
            })
          },
        })
      try {
        await (session.d.withModelSnapshot ? session.d.withModelSnapshot(generate) : generate())
      } catch {
        input.billingFailed?.()
        return { status: 'unavailable' }
      }
      return result
    },
  }
  return Object.freeze({
    inspect,
    refresh(request: Parameters<SessionWorkTitlePort['refresh']>[0]) {
      const work = port.refresh(request)
      pending.add(work)
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      )
      return work
    },
    async close() {
      await Promise.allSettled([...pending])
    },
    drained: () => transport,
  })
}
