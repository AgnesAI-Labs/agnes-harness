import type { Event } from '@agnes/core'
import { readSessionTitle, SESSION_TITLE_EVENT, type SessionTitleRecord } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import { recoverTitleCosts, TITLE_COST_EVENT, titleEffectId } from './title-accounting.js'
import { bounded, generateTitleWithModelSnapshot } from './title-generator.js'

export { normalizeSessionTitle } from './title-generator.js'

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join('')
const plainText = (data: unknown): string => {
  const content = (data as { content?: Array<{ type?: string; text?: string }> } | null)?.content
  return Array.isArray(content)
    ? content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    : ''
}

/** A same-named extension event must not hide trusted, persisted metadata. */
export async function loadSessionTitle(
  session: Pick<HostSession, 'scan' | 'lastSeq'>,
  fromSeq: number,
): Promise<SessionTitleRecord | undefined> {
  let toSeq = session.lastSeq
  while (toSeq >= fromSeq) {
    const rows = await session.scan({ type: SESSION_TITLE_EVENT, fromSeq, toSeq, order: 'desc', limit: 100 })
    if (!rows.length) return undefined
    for (const row of rows) {
      const title = readSessionTitle(row)
      if (title) return title
    }
    toSeq = (rows.at(-1)?.seq ?? fromSeq) - 1
  }
  return undefined
}

/** One queue per Host, with no unbounded parallel model requests inside that process. */
export function createTitleQueue(): (work: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve()
  return (work) => {
    const next = tail.then(work)
    tail = next.catch(() => undefined)
    return next
  }
}

export async function startSessionTitle(
  session: HostSession,
  options: {
    schedule: (work: () => Promise<void>) => Promise<void>
    onError: (error: unknown) => void
    timeoutMs?: number
  },
): Promise<{ close(): Promise<void> }> {
  const stopped = new AbortController()
  let writes = Promise.resolve()
  let active: Promise<void> | undefined
  let record: SessionTitleRecord | undefined
  let currentTurn: number | undefined
  let eligible = false
  let firstPrompt = ''
  let titleLocale: SessionTitleRecord['titleLocale']
  let started = false
  const submit = (work: () => Promise<void>) => {
    writes = writes
      .then(async () => {
        if (!stopped.signal.aborted) await work()
      })
      .catch(options.onError)
  }
  const save = async (next: SessionTitleRecord) => {
    if (stopped.signal.aborted || session.closingOrClosed) return
    await session.locked(async () => {
      if (stopped.signal.aborted || session.closingOrClosed || record?.status === 'generated') return
      await session.append([session.ev(SESSION_TITLE_EVENT, next, { ignorable: true })])
      record = next
    })
  }

  async function generate(seed: SessionTitleRecord): Promise<void> {
    const work = () => generateWithModelSnapshot(seed)
    return session.d.withModelSnapshot ? session.d.withModelSnapshot(work) : work()
  }
  async function generateWithModelSnapshot(seed: SessionTitleRecord): Promise<void> {
    return generateTitleWithModelSnapshot(session, seed, {
      signal: stopped.signal,
      effectId: titleEffectId(session, seed.startSeq),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      current: () => record,
      save,
      onError: options.onError,
      accept: (outcome, spend, proof) =>
        session.locked(async () => {
          const replace = record?.status !== 'generated'
          const appended = await session.append([
            session.ev('cost/ledger', spend),
            session.ev(TITLE_COST_EVENT, proof, { ignorable: true }),
            ...(replace ? [session.ev(SESSION_TITLE_EVENT, outcome, { ignorable: true })] : []),
          ])
          if (replace) record = outcome
          return appended
        }),
    })
  }

  function observe(events: Event[], replay = false): void {
    for (const event of events) {
      if ((event.lane ?? 'main') !== 'main') continue
      const title = readSessionTitle(event)
      if (title) {
        record = title
        continue
      }
      if (event.type === 'user/message' && eligible && !replay) {
        firstPrompt = clip(plainText(event.data), 3000)
        const locale = (event.data as { titleLocale?: unknown }).titleLocale
        titleLocale = locale === 'en' || locale === 'zh-CN' ? locale : undefined
      }
      if (event.type === 'turn/start') {
        const data = event.data as { turn: number; trigger: string; continues?: { turn: number } }
        if (record?.status === 'pending' && data.continues?.turn === currentTurn) currentTurn = data.turn
        else if (eligible && !replay) {
          eligible = false
          if (data.trigger !== 'prompt' || !firstPrompt.trim()) continue
          const route = session.preset.model.route.primary
          const model =
            session.preset.model.id.primary ??
            session.d.provider.models().find((m) => m.route === route && m.slot === 'primary')?.id
          if (!route || !model) continue
          currentTurn = data.turn
          const pending: SessionTitleRecord = {
            status: 'pending',
            turn: data.turn,
            startSeq: event.seq,
            route,
            model,
            prompt: firstPrompt,
            ...(titleLocale ? { titleLocale } : {}),
            budgetCap: session.preset.budget.perRequestCap,
            treeBudgetCap: session.preset.treeBudgetCredits,
          }
          const override = events.find(
            (row) => row.type === 'x/core/turn-budget' && (row.data as { turn?: number }).turn === data.turn,
          )
          // A hard-bounded turn cannot authorize a separate, asynchronously billed title request.
          if ((override?.data as { hard?: boolean } | undefined)?.hard) continue
          if (override) pending.budgetCap = (override.data as { creditsCap: number | null }).creditsCap
          record = pending
          submit(() => save(pending))
        } else if (record?.status === 'pending' && data.turn === record.turn) currentTurn = data.turn
        else currentTurn = undefined
      }
      if (event.type !== 'turn/end' || record?.status !== 'pending' || currentTurn === undefined || started)
        continue
      const reason = (event.data as { reason: string }).reason
      if (reason === 'parked') continue
      started = true
      const seed = record
      if (reason !== 'completed') {
        submit(() => save({ ...seed, status: 'failed', reason }))
        continue
      }
      // Yield beyond the commit notification and phase lock; never await model IO in the run path.
      submit(async () => {
        void options
          .schedule(async () => {
            if (stopped.signal.aborted) return
            active = generate(seed).catch(async (error: unknown) => {
              options.onError(error)
              if (record?.status === 'pending')
                await save({ ...seed, status: 'failed', reason: 'setup-failed' }).catch(options.onError)
            })
            await active
          })
          .catch(options.onError)
      })
    }
  }

  const start = (await session.scan({ type: 'session/start', order: 'desc', limit: 1 }))[0]
  if (session.lane !== 'main' || session.generationDepth > 0 || !start)
    return { close: async () => undefined }
  record = await loadSessionTitle(session, start.seq)
  // Recovery scans all title generations; it never launches a model or replaces an accepted title.
  let recovering = true
  active = bounded(
    recoverTitleCosts(session, start.seq, () => recovering && !stopped.signal.aborted, options.onError),
    stopped.signal,
    options.timeoutMs ?? 30_000,
  )
    .finally(() => {
      recovering = false
    })
    .catch(options.onError)
  eligible =
    !record && (await session.scan({ type: 'user/message', fromSeq: start.seq, limit: 1 })).length === 0
  if (record?.status === 'pending') {
    currentTurn = record.turn
    let fromSeq = record.startSeq
    const toSeq = session.lastSeq
    while (fromSeq <= toSeq) {
      const rows = await session.scan({ fromSeq, toSeq, limit: 200 })
      if (!rows.length) break
      observe(rows, true)
      fromSeq = (rows.at(-1)?.seq ?? toSeq) + 1
    }
  }
  const off = session.d.log.observeCommitted(
    ['user/message', 'turn/start', 'turn/end', 'x/core/turn-budget', SESSION_TITLE_EVENT],
    observe,
  )
  return {
    async close() {
      stopped.abort()
      off()
      await writes
      // A queued task sees stopped and does nothing; it must not delay this session behind another model.
      if (active) await active
    },
  }
}
