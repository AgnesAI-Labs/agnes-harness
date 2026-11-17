import {
  CoreError,
  createSessionWorkSideCall,
  type Event,
  type Kernel,
  type SideCallExecutionSource,
} from '@agnes/core'
import {
  redactSecrets,
  type SessionWorkMessage,
  type SessionWorkObservation,
  type SessionWorkRegistration,
  unavailableProjections,
} from '@agnes/extension-api'
import type { KernelPorts, SessionWorkMeta } from '@agnes/host-extensions/ext-host/ports'
import { readSessionTitle } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import type { AutoTitleEligibility } from './title-eligibility.js'
import { acceptedSessionTitle, createTitleRefresh } from './title-refresh.js'

type Registration = {
  definition: SessionWorkRegistration
  meta: SessionWorkMeta
  controller: AbortController
}
const registries = new WeakMap<Kernel, SessionWorkRegistry>()
export function sessionWorkFor(kernel: Kernel): SessionWorkRegistry {
  let registry = registries.get(kernel)
  if (!registry) {
    registry = new SessionWorkRegistry()
    registries.set(kernel, registry)
  }
  return registry
}

function messageOf(row: Event): SessionWorkMessage | undefined {
  if (!['user/message', 'assistant/message'].includes(row.type)) return undefined
  const data = row.data as {
    content?: Array<{ type: string; text?: string }>
    kind?: SessionWorkMessage['kind']
    stopReason?: SessionWorkMessage['stopReason']
    system?: unknown
  }
  const text = (kind: string) =>
    redactSecrets(
      (data.content ?? [])
        .filter((part) => part.type === kind && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n'),
    )
  const operator =
    row.type === 'user/message' &&
    row.origin === 'principal' &&
    row.trust === 'trusted' &&
    !data.system &&
    !['agent', 'extension', 'system'].includes(row.actor.role)
  return Object.freeze({
    role: row.type === 'user/message' ? 'user' : 'assistant',
    origin: row.origin === 'principal' || row.origin === 'model' ? row.origin : 'system',
    attribution: operator ? 'operator' : row.origin === 'system' ? 'system' : 'agent',
    ...(data.kind ? { kind: data.kind } : {}),
    ...(data.stopReason ? { stopReason: data.stopReason } : {}),
    text: text('text'),
    ...(row.type === 'assistant/message' ? { thinking: text('thinking') } : {}),
  })
}

async function whileLive(work: Promise<void>, signal: AbortSignal): Promise<void> {
  let cancel!: () => void
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve
  })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) cancel()
    await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Registrations are volatile and owned by live rows. Each session observes only newly committed data. */
class SessionWorkRegistry {
  private readonly registrations = new Set<Registration>()
  readonly register: NonNullable<KernelPorts['sessionWork']>['register'] = (definition, meta) => {
    const entry = { definition, meta, controller: new AbortController() }
    this.registrations.add(entry)
    return () => {
      entry.controller.abort()
      this.registrations.delete(entry)
    }
  }

  async start(session: HostSession, eligible: AutoTitleEligibility) {
    if (session.lane !== 'main' || session.generationDepth > 0) return { close: async () => {} }
    const ref = Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot })
    const lifetime = new AbortController()
    let cancellation = new AbortController()
    const active = new Map<Registration, Promise<void>>()
    const dispatched = new Map<Registration, number>()
    let pending: SideCallExecutionSource | undefined
    let current: Omit<SideCallExecutionSource, 'endSeq' | 'lastAssistantSeq'> | undefined
    let generated = Boolean(await acceptedSessionTitle(session))
    let observations = Promise.resolve()
    const report = () => session.d.logger.warn('session background work failed', { sessionKey: session.key })
    const notify = (event: SessionWorkObservation) => {
      Object.freeze(event)
      const recipients = [...this.registrations]
      observations = observations.then(() => {
        for (const entry of recipients) {
          if (entry.controller.signal.aborted || entry.meta.authority?.check() === false) continue
          try {
            entry.definition.observe(event)
          } catch {
            report()
          }
        }
      })
    }
    const launch = () => {
      if (!pending || session.isRunning || session.op() || lifetime.signal.aborted) return
      const source = pending
      pending = undefined
      if (source.hard || !generated) return
      for (const entry of this.registrations) {
        if (active.has(entry) || dispatched.get(entry) === source.endSeq || entry.controller.signal.aborted)
          continue
        dispatched.set(entry, source.endSeq)
        const controller = new AbortController()
        const signal = AbortSignal.any([
          lifetime.signal,
          cancellation.signal,
          entry.controller.signal,
          controller.signal,
          ...(entry.meta.authority ? [entry.meta.authority.signal] : []),
        ])
        const current = () => {
          if (signal.aborted || entry.meta.authority?.check() === false) {
            controller.abort()
            return false
          }
          return true
        }
        let transport = Promise.resolve()
        const work = observations
          .then(async () => {
            if (!current() || session.closingOrClosed) return
            const final = (
              await session.scan({
                fromSeq: source.lastAssistantSeq,
                toSeq: source.lastAssistantSeq,
                limit: 1,
              })
            )[0]
            if (
              final?.type !== 'assistant/message' ||
              (final.data as { stopReason?: string }).stopReason !== 'end_turn' ||
              signal.aborted
            )
              return
            const sideCall = createSessionWorkSideCall(session, {
              caller: entry.meta.pluginRowId ?? entry.meta.source,
              source,
              signal,
            })
            const guardedSideCall = {
              ...sideCall,
              prepare: (async (...args) => {
                if (!current()) throw new CoreError('E_CLOSED', 'Background authority revoked')
                return sideCall.prepare(...args)
              }) as typeof sideCall.prepare,
              invoke: (async (...args) => {
                if (!current()) throw new CoreError('E_CLOSED', 'Background authority revoked')
                return sideCall.invoke(...args)
              }) as typeof sideCall.invoke,
            }
            const title = entry.meta.autoTitle
              ? createTitleRefresh(session, {
                  source,
                  signal,
                  eligible,
                  current,
                  spendAllowed: sideCall.spendAllowed,
                  billingFailed: sideCall.billingFailed,
                })
              : undefined
            try {
              await whileLive(
                Promise.resolve().then(() =>
                  entry.definition.run({
                    session: ref,
                    signal,
                    boundary: {
                      turn: source.turn,
                      startSeq: source.startSeq,
                      endSeq: source.endSeq,
                      lastAssistantSeq: source.lastAssistantSeq,
                    },
                    sideCall: guardedSideCall,
                    projections: unavailableProjections,
                    ...(title ? { title } : {}),
                  }),
                ),
                signal,
              )
            } finally {
              controller.abort()
              await sideCall.close()
              await title?.close()
              transport = Promise.all([sideCall.drained(), title?.drained()]).then(() => undefined)
            }
          })
          .catch(report)
          .finally(() => {
            void transport.finally(() => active.delete(entry))
          })
        active.set(entry, work)
      }
    }
    const off = session.onAppended((rows) => {
      for (const row of rows) {
        if ((row.lane ?? 'main') !== session.lane) continue
        const title = readSessionTitle(row)
        if (title?.status === 'generated') generated = true
        if (row.type === 'turn/start') {
          const turn = (row.data as { turn: number }).turn
          const override = rows.find(
            (item) => item.type === 'x/core/turn-budget' && (item.data as { turn: number }).turn === turn,
          )?.data as { creditsCap: number | null; hard?: boolean } | undefined
          current = {
            turn,
            startSeq: row.seq,
            budgetCap: override ? override.creditsCap : session.preset.budget.perRequestCap,
            treeBudgetCap: session.preset.treeBudgetCredits,
            hard: override?.hard === true,
          }
        }
        if (
          row.type === 'x/core/turn-budget' &&
          current &&
          (row.data as { turn?: number }).turn === current.turn
        ) {
          const budget = row.data as { creditsCap: number | null; hard?: boolean }
          current = { ...current, budgetCap: budget.creditsCap, hard: budget.hard === true }
        }
        if (row.type === 'session/start') {
          lifetime.abort()
          notify({ kind: 'reset', session: ref, seq: row.seq, hasGeneratedTitle: false })
        }
        if (row.type === 'user/message' || row.type === 'assistant/message') {
          // Copy lazily after the commit callback, preserving order and never exposing provider state.
          const recipients = [...this.registrations]
          if (!recipients.length) continue
          const hasGeneratedTitle = generated
          observations = observations.then(() => {
            const message = messageOf(row)
            if (!message) return
            for (const entry of recipients)
              if (!entry.controller.signal.aborted && entry.meta.authority?.check() !== false) {
                try {
                  entry.definition.observe(
                    Object.freeze({
                      kind: 'message',
                      session: ref,
                      seq: row.seq,
                      hasGeneratedTitle,
                      message,
                    }),
                  )
                } catch {
                  report()
                }
              }
          })
        }
        if (row.type === 'turn/end' && current) {
          const data = row.data as { reason: string; lastAssistantSeq: number | null }
          if (data.reason === 'completed' && typeof data.lastAssistantSeq === 'number') {
            pending = { ...current, endSeq: row.seq, lastAssistantSeq: data.lastAssistantSeq }
            queueMicrotask(launch)
          }
          current = undefined
        }
      }
    })
    const offSettled = session.onRunSettled(() => queueMicrotask(launch))
    const offCancel = session.onCancelled(() => {
      cancellation.abort()
      cancellation = new AbortController()
      pending = undefined
    })
    return {
      async close() {
        lifetime.abort()
        off()
        offSettled()
        offCancel()
        notify({ kind: 'close', session: ref, seq: session.lastSeq, hasGeneratedTitle: generated })
        await observations
        await Promise.allSettled([...active.values()])
      },
    }
  }
}
