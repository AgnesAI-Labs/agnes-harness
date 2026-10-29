import { ScheduleRejected } from '@agnes/base/schedule'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SchedulesPort, SessionLister } from '@agnes/daemon-foundation/local/ports'
import {
  type AgentPlan,
  rpcError,
  type SchedulesHistoryParams,
  type SchedulesListParams,
  type SchedulesReceiptParams,
  type SchedulesUpsertParams,
} from '@agnes/protocol'

type Deps = {
  host?: { resolveAgent?(ref: string): Promise<AgentPlan> }
  schedules?: SchedulesPort
  lister?: SessionLister
  registry: { get(key: string): { session: unknown } | undefined }
}

/** `_agnes/v1/schedules.*`: scheduled tasks, their targets and run history. */
export function registerSchedules(
  ep: LocalEndpoint,
  deps: Deps,
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
): void {
  const schedules = (): SchedulesPort => {
    const port = deps.schedules
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
    if (sessionKey) requireOwner(method, sessionKey, c)
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
  ep.register('_agnes/v1/schedules.history', async (params, c) => {
    const query = params as SchedulesHistoryParams
    const port = schedules()
    if (!port.history) throw rpcError('CAPABILITY_DENIED', { method: 'schedules.history' })
    if (query.id) {
      const row = await port.read(query.id)
      if (!row) return { runs: [] }
      requireScheduleOwner('schedules.history', row.sessionKey, c)
    } else if (c.conn.authKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { method: 'schedules.history' })
    return scheduleCall(() => port.history!(query))
  })
  ep.register('_agnes/v1/schedules.receipt', async (params, c) => {
    const query = params as SchedulesReceiptParams
    const port = schedules()
    if (!port.receipt) throw rpcError('CAPABILITY_DENIED', { method: 'schedules.receipt' })
    const row = await port.read(query.id)
    if (!row) return { updated: false }
    requireScheduleOwner('schedules.receipt', row.sessionKey, c)
    return scheduleCall(() => port.receipt!(query))
  })
  ep.register('_agnes/v1/schedules.list', async (params, c) => {
    const query = params as SchedulesListParams
    if (query.scope === 'all') {
      if (c.conn.authKind !== 'local') throw rpcError('CAPABILITY_DENIED', { method: 'schedules.list' })
    } else if (query.sessionKey) requireOwner('schedules.list', query.sessionKey, c)
    else throw rpcError('SEMANTIC_REJECTED', { code: 'invalid_selector', reason: 'sessionKey required' })
    const workspaceSessionKeys: string[] = []
    const port = schedules()
    const bound = !query.workspace
      ? undefined
      : query.scope === 'session' && query.sessionKey
        ? [query.sessionKey]
        : await port.boundSessionKeys?.()
    if (query.workspace && deps.lister && (!bound || bound.length)) {
      let cursor: string | undefined
      do {
        const page = await deps.lister.list({
          cwd: query.workspace,
          ...(bound ? { sessionIds: bound } : {}),
          limit: 500,
          ...(cursor ? { cursor } : {}),
        })
        workspaceSessionKeys.push(...page.items.map((item) => item.sessionId))
        if (page.cursor && page.cursor === cursor)
          throw rpcError('INTERNAL_ERROR', { method: 'schedules.list' })
        cursor = page.cursor
      } while (cursor)
    }
    return scheduleCall(async () =>
      withApprovals(await port.list({ ...query, ...(query.workspace ? { workspaceSessionKeys } : {}) })),
    )
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
      if (!deps.host?.resolveAgent || input.target.kind !== 'new-session')
        throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid agent target' })
      const plan = await deps.host.resolveAgent(input.agent)
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
