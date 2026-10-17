import { type createSchedulesPort, ScheduleRejected } from '@agnes/base/schedule'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import type { SchedulingBridge } from '@agnes/extension-api'
import { rpcError, SchedulesControlParams, ScheduleTarget, validateAgainst } from '@agnes/protocol'

type SchedulerPort = ReturnType<typeof createSchedulesPort>

/** Session authority is provided by Host admission, never by a plugin's request payload. */
export function createSchedulingBridge(port: SchedulerPort): SchedulingBridge {
  return async (session, operation, raw, signal) => {
    signal.throwIfAborted()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw rpcError('INVALID_PARAMS')
    const input = raw as Record<string, unknown>
    const owned = (id: string) => {
      const row = port.catalog.read(id)
      const owner = row?.target.kind === 'session' ? row.target.sessionKey : row?.origin
      return owner === session.key ? row : undefined
    }
    const id = typeof input.id === 'string' ? input.id : ''
    try {
      switch (operation) {
        case 'list':
          return {
            ...(await port.list({
              scope: 'session',
              sessionKey: session.key,
              includeArchived: input.includeArchived === true,
            })),
            ...(typeof input.recentDeliverySince === 'number' && Number.isFinite(input.recentDeliverySince)
              ? { recentDelivery: port.catalog.recentDelivery(session.key, input.recentDeliverySince) }
              : {}),
          }
        case 'get':
          return owned(id)
        case 'runs':
          return owned(id)?.runs ?? []
        case 'archive':
          return owned(id) ? port.archive({ id }) : { deleted: false }
        case 'control':
          if (!validateAgainst(SchedulesControlParams, raw).ok) throw rpcError('INVALID_PARAMS')
          return owned(id)
            ? port.control(raw as Parameters<SchedulerPort['control']>[0])
            : { updated: false, code: 'schedule_not_found' }
        case 'upsert': {
          if (input.id !== undefined && !owned(id)) return { updated: false, code: 'schedule_not_found' }
          const target =
            input.target ?? (id ? owned(id)?.target : { kind: 'session', sessionKey: session.key })
          if (!validateAgainst(ScheduleTarget, target).ok) throw rpcError('INVALID_PARAMS')
          const checked = target as import('@agnes/protocol').ScheduleTarget
          if (
            (checked.kind === 'session' && checked.sessionKey !== session.key) ||
            (checked.kind === 'new-session' && checked.cwd !== session.workspaceRoot)
          )
            throw rpcError('CAPABILITY_DENIED')
          // Project only public fields. owner/origin supplied by the caller are never forwarded.
          return await port.upsert(
            {
              ...(id ? { id } : {}),
              title: input.title,
              prompt: input.prompt,
              selector: input.selector,
              target: checked,
              origin: session.key,
              owner: session.key,
            },
            signal,
          )
        }
        default:
          throw rpcError('INVALID_PARAMS')
      }
    } catch (error) {
      if (error instanceof ScheduleRejected)
        throw rpcError('SEMANTIC_REJECTED', { code: error.code, reason: error.message })
      throw error
    }
  }
}

/** Internal worker requests retain their channel session and its persisted workspace binding. */
export async function callWorkerScheduling(
  port: SchedulerPort | undefined,
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>,
  sessionKey: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!port) throw rpcError('CAPABILITY_DENIED')
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw rpcError('INVALID_PARAMS')
  const p = params as { operation: Parameters<SchedulingBridge>[1]; input: unknown; workspaceRoot?: unknown }
  const binding = await workspaces.restoreBinding(sessionKey)
  if (binding.canonicalRoot !== p.workspaceRoot) throw rpcError('CAPABILITY_DENIED')
  return createSchedulingBridge(port)(
    { key: sessionKey, workspaceRoot: binding.canonicalRoot },
    p.operation,
    p.input,
    signal,
  )
}
