import { ScheduleRejected } from '@agnes/base/schedule'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SchedulesPort } from '@agnes/daemon-foundation/local/ports'
import { type AgentPlan, rpcError, type SchedulesUpsertParams } from '@agnes/protocol'

type Deps = {
  resolveAgent?(ref: string): Promise<AgentPlan>
  schedules(): SchedulesPort | undefined
  requireOwner(method: string, sessionId: string, c: CallContext): void
  registry: { get(key: string): { session: unknown } | undefined }
}

/** `_agnes/v1/schedules.*`: scheduled tasks, their targets and run history. */
export function registerSchedules(ep: LocalEndpoint, deps: Deps): void {
  const schedules = (): SchedulesPort => {
    const port = deps.schedules()
    if (!port) throw rpcError('CAPABILITY_DENIED', { method: 'schedules' })
    return port
  }
  const scheduleCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ScheduleRejected)
        throw rpcError('SEMANTIC_REJECTED', { code: error.code, reason: error.message })
      throw error
    }
  }
  /** A task bound to a session is that session's owner's; one with no session is the local owner's. */
  const requireScheduleOwner = (method: string, sessionKey: string | undefined, c: CallContext) => {
    if (sessionKey) deps.requireOwner(method, sessionKey, c)
    else if (c.conn.authKind !== 'local') throw rpcError('CAPABILITY_DENIED', { method })
  }
  /** A run still in progress is shown as waiting for approval while its session has an open request. */
  const awaitingApproval = async (sessionKey: string): Promise<boolean> => {
    const entry = deps.registry.get(sessionKey)
    if (!entry) return false
    const session = entry.session as unknown as {
      decisions?: { list(): Promise<{ result?: unknown; consumption?: unknown; invalidation?: unknown }[]> }
      listDecisions?(): Promise<{ result?: unknown; consumption?: unknown; invalidation?: unknown }[]>
    }
    try {
      const values = session.decisions ? await session.decisions.list() : await session.listDecisions?.()
      return (values ?? []).some((value) => !value.result && !value.consumption && !value.invalidation)
    } catch {
      return false
    }
  }
  const withApprovals = async (value: { schedules: unknown[] }) => {
    for (const row of value.schedules as { runs?: { outcome: string; sessionKey?: string }[] }[]) {
      const run = row.runs?.at(-1)
      if (run?.outcome === 'running' && run.sessionKey && (await awaitingApproval(run.sessionKey)))
        run.outcome = 'waiting_approval'
    }
    return value
  }
  ep.register('_agnes/v1/schedules.list', async (params, c) => {
    const query = params as { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }
    if (query.scope === 'all') {
      if (c.conn.authKind !== 'local') throw rpcError('CAPABILITY_DENIED', { method: 'schedules.list' })
    } else if (query.sessionKey) deps.requireOwner('schedules.list', query.sessionKey, c)
    else throw rpcError('SEMANTIC_REJECTED', { code: 'invalid_selector', reason: 'sessionKey required' })
    return scheduleCall(async () => withApprovals(await schedules().list(query)))
  })
  ep.register('_agnes/v1/schedules.upsert', async (params, c) => {
    const body = params as { id?: string; target?: { kind?: string; sessionKey?: string } }
    if (body.id) {
      const row = await schedules().read(body.id)
      if (row) requireScheduleOwner('schedules.upsert', row.sessionKey, c)
    }
    requireScheduleOwner(
      'schedules.upsert',
      body.target?.kind === 'session' ? body.target.sessionKey : undefined,
      c,
    )
    const input = params as SchedulesUpsertParams
    if (input.agent) {
      if (!deps.resolveAgent || input.target.kind !== 'new-session')
        throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid agent target' })
      const plan = await deps.resolveAgent(input.agent)
      for (const field of ['loop', 'bundles', 'preset', 'model'] as const) {
        const supplied = input.target[field]
        if (supplied !== undefined && JSON.stringify(supplied) !== JSON.stringify(plan[field]))
          throw rpcError('SEMANTIC_REJECTED', { reason: 'agent selection changed', field })
      }
      const { agent: _agent, ...request } = input
      return scheduleCall(() =>
        schedules().upsert({
          ...request,
          target: {
            kind: 'new-session',
            cwd: input.target.kind === 'new-session' ? input.target.cwd : '',
            ...(input.target.unattendedApproval
              ? { unattendedApproval: input.target.unattendedApproval }
              : {}),
            loop: plan.loop,
            bundles: plan.bundles,
            preset: plan.preset,
            model: plan.model,
          },
        }),
      )
    }
    return scheduleCall(() => schedules().upsert(params))
  })
  ep.register('_agnes/v1/schedules.archive', async (params, c) => {
    const id = (params as { id: string }).id
    const row = await schedules().read(id)
    if (!row) return { deleted: false }
    try {
      requireScheduleOwner('schedules.archive', row.sessionKey, c)
    } catch {
      return { deleted: false }
    }
    return scheduleCall(() => schedules().archive({ id }))
  })
  ep.register('_agnes/v1/schedules.control', async (params, c) => {
    const body = params as { id: string; action: 'run' | 'pause' | 'resume' }
    const row = await schedules().read(body.id)
    if (!row) return { updated: false, code: 'schedule_not_found' }
    try {
      requireScheduleOwner('schedules.control', row.sessionKey, c)
    } catch {
      return { updated: false, code: 'schedule_not_found' }
    }
    return scheduleCall(() => schedules().control({ id: body.id, action: body.action }))
  })
}
