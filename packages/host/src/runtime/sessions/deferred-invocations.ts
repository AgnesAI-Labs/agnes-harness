import type { Context } from '@agnes/cordis'
import { scanAll } from '@agnes/core'
import type { ToolResult } from '@agnes/extension-api'
import {
  DEFERRED_INVOCATION_EVENT,
  DEFERRED_NOTIFICATION_EVENT,
  type DeferredInvocationLedgerPort,
  type DeferredInvocationsService,
} from '@agnes/host-providers/assemble/deferred-invocations'
import type { Actor, EventEnvelope } from '@agnes/protocol'
import type { Assembled } from '../assemble/assemble.js'
import type { HostSession } from '../lifecycle/host.js'
import { enqueueSystemInput } from './system-input.js'

const boundQueues = new WeakMap<HostSession, DeferredInvocationsService>()
const registries = new WeakMap<Context, DeferredInvocationsService>()

/** Host-only handle. The registry is not a context service, so plugins do not inherit it. */
export function rememberDeferredInvocations(root: Context, service: DeferredInvocationsService): void {
  registries.set(root, service)
}

function deferredInvocationsFor(root: Context): DeferredInvocationsService {
  const service = registries.get(root)
  if (!service) throw new Error('Deferred invocation registry is unavailable')
  return service
}

/** The generation service that bound this session. Unloading a producer does not drop the queue. */
export function deferredQueueFor(session: HostSession): DeferredInvocationsService | undefined {
  return boundQueues.get(session)
}

export function bindDeferredInvocations(a: Assembled, session: HostSession): () => void {
  const read = (types: readonly string[]) =>
    scanAll((q) => session.scan(q), {
      type: [...types],
      lane: session.lane,
      fromSeq: (session.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: session.lastSeq,
    })
  const ports: DeferredInvocationLedgerPort = {
    scan: async () =>
      (await read([DEFERRED_INVOCATION_EVENT, DEFERRED_NOTIFICATION_EVENT])) as EventEnvelope[],
    append: async (type, data, actor, sourceSeq) => {
      const { seqs } = await session.append([
        {
          type,
          data,
          actor,
          lane: session.lane,
          origin: 'system',
          trust: 'trusted',
          ignorable: true,
          ...(sourceSeq ? { sourceEventSeqs: [sourceSeq] } : {}),
        },
      ])
      if (!seqs[0]) throw new Error('Deferred invocation fact was not persisted')
      return seqs[0]
    },
    async outcome(id) {
      const rows = await read(['x/core/loop-effect', 'tool/call', 'tool/result', 'x/core/tool-response'])
      const link = [...rows]
        .reverse()
        .find(
          (row) =>
            row.type === 'x/core/loop-effect' &&
            row.origin === 'system' &&
            row.trust === 'trusted' &&
            (row.data as { invocationId?: string }).invocationId === id,
        )
      const toolUseId = (link?.data as { toolUseId?: string } | undefined)?.toolUseId
      if (!toolUseId) return {}
      const matches = (row: { data: unknown }) => (row.data as { toolUseId?: string }).toolUseId === toolUseId
      const call = rows.find((row) => row.type === 'tool/call' && matches(row))
      // Tool permission uses Core's decision register; never infer a human ticket from delivery facts.
      const decision = [...session.state.registers.decisionStates.values()]
        .reverse()
        .find(
          ({ value }) =>
            ['core/tool-permission', 'core/unknown-outcome'].includes(value.request.owner) &&
            value.request.sourcePackage === '@agnes/core' &&
            value.request.operationId === toolUseId &&
            value.request.lane === session.lane,
        )?.value
      const approvalId = decision?.handle.id
      const result = [...rows].reverse().find((row) => row.type === 'tool/result' && matches(row))
      const response = [...rows]
        .reverse()
        .find(
          (row) =>
            row.type === 'x/core/tool-response' &&
            row.origin === 'system' &&
            row.trust === 'trusted' &&
            matches(row),
        )
      const data = result?.data as
        | { content: ToolResult['content']; isError?: boolean; code?: string; structured?: unknown }
        | undefined
      return {
        ...(call ? { toolCallSeq: call.seq } : {}),
        ...(approvalId ? { approvalId } : {}),
        ...(result && data?.code !== 'TOOL_OUTCOME_UNKNOWN'
          ? {
              resultSeq: result.seq,
              result: (response?.data as { result?: ToolResult } | undefined)?.result ?? {
                content: data!.content,
                ...(data!.isError !== undefined ? { isError: data!.isError } : {}),
                ...(data!.code ? { details: { code: data!.code } } : {}),
              },
            }
          : {}),
      }
    },
    async wake(id, actor, signal) {
      if (session.op()) return
      await enqueueSystemInput(
        session,
        `deferred-wake:${id}:${session.lastTurnNumber()}`,
        {
          source: 'agnes/deferred-invocations',
          type: 'invocation-queued',
          data: { invocationId: id },
          summary: 'A deferred tool invocation is queued. Execute only its durable backend binding.',
        },
        actor,
        signal,
      )
    },
  }
  const service = deferredInvocationsFor(a.pluginTree.root)
  boundQueues.set(session, service)
  const release = service.bind(session.key, session.lane, ports)
  return () => {
    if (boundQueues.get(session) === service) boundQueues.delete(session)
    release()
  }
}
