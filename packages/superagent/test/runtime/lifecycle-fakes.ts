/** Fakes of the session adapter, session control and composed app, and a ticket builder, for the lifecycle tests. */
import type { Assignment, Ticket } from '../../src/core/index.js'
import type { SessionAdapter, SuperagentApp } from '../../src/runtime/contracts.js'
import type { SessionControl } from '../../src/runtime/lifecycle.js'

export const AT = '2026-11-14T00:00:00.000Z'
export const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString()
export const workerKey = (ticketId: string) => `superagent:worker:${ticketId}`
export const ORCHESTRATOR = 'superagent:orchestrator'

/** An open ticket whose latest assignment `a1` runs, with `fields` over the defaults. */
export function runningTicket(
  id: string,
  assignment: Partial<Assignment> = {},
  fields: Partial<Ticket> = {},
): Ticket {
  return {
    id,
    title: id,
    decisionId: `d-${id}`,
    mandate: {
      strength: 'explicit',
      policyVersion: '',
      basis: { via: 'listed' },
      actor: { source: 'x', id: '' },
      scope: '',
    },
    channels: [],
    assignments: [{ id: `a-${id}`, state: 'running', createdAt: AT, startedAt: AT, ...assignment }],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: '', triggerIds: [] },
    execution: { name: id, directory: `/work/${id}`, assignment: 'do it' },
    ...fields,
  }
}

type SessionState = Awaited<ReturnType<SessionAdapter['state']>>
/** A Session as the fakes keep it; `onCancel` runs when its turn is cancelled. */
export interface FakeSession extends SessionState {
  onCancel?: () => void
}

export function fakeSessions(log: string[], sessions: Map<string, FakeSession>): SessionAdapter {
  const get = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`no session ${id}`)
    return session
  }
  return {
    async ensureOrchestrator() {
      log.push('ensureOrchestrator')
      return ORCHESTRATOR
    },
    async ensureWorker(ticket) {
      log.push(`ensureWorker ${ticket.id}`)
      return workerKey(ticket.id)
    },
    async cancel(id) {
      log.push(`cancel ${id}`)
      const session = get(id)
      session.running = false
      session.onCancel?.()
    },
    async state(id) {
      log.push(`state ${id}`)
      const { running, pending, jobs } = get(id)
      return { running, pending: pending.map((item) => ({ ...item })), jobs }
    },
    async dropPending(id, itemIds) {
      log.push(`drop ${id} ${itemIds.join(',')}`)
      const session = get(id)
      session.pending = session.pending.filter((item) => !itemIds.includes(item.itemId))
    },
  }
}

export function fakeControl(log: string[], sessions: Map<string, FakeSession>): SessionControl {
  return {
    async sendNow(id, itemId) {
      log.push(`sendNow ${id} ${itemId}`)
      const session = sessions.get(id)!
      session.pending = session.pending.filter((item) => item.itemId !== itemId)
      session.running = true
    },
    async killAgentJobs(id) {
      log.push(`kill ${id}`)
      const session = sessions.get(id)!
      const killed = session.jobs
      session.jobs = 0
      return killed
    },
    async removeWorkspaces(dirs) {
      log.push(`removeWorkspaces ${dirs.join(',')}`)
      return dirs.length
    },
  }
}

/** A composed app that logs its calls; `polls` counts Source polls, which run while it is started. */
export function fakeApp(log: string[], sessionIds: () => string[]) {
  let started = false
  const app: SuperagentApp & { polls: number; poll(): void } = {
    polls: 0,
    poll() {
      if (started) app.polls++
    },
    async start() {
      log.push('app.start')
      started = true
    },
    async stop(reason) {
      log.push(`app.stop ${reason}`)
      started = false
    },
    executor: {
      sessionIds,
      start: () => log.push('executor.start'),
      deliver: () => log.push('executor.deliver'),
      stop: () => log.push('executor.stop'),
    },
    engine: {
      assignmentInterrupted(ticketId, assignmentId) {
        log.push(`interrupted ${ticketId} ${assignmentId}`)
      },
    },
  }
  return app
}
