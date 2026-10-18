import { hostPortRequest } from '@agnes/core'
import type { ToolContext } from '@agnes/extension-api'
import { refusedForParameters } from '../resources/management-refusal.js'
import type { PluginManageBridge, PluginManageInvocation } from '../resources/plugin-manage-port.js'
import type { Lease } from './lease.js'

export type BoundPluginManage = (
  invocation: Pick<PluginManageInvocation, 'input' | 'toolUseId' | 'sessionKey' | 'turn'>,
  signal: AbortSignal,
) => Promise<unknown>

/** Only assembly supplies provenance. Builtins use the session's durable code generation. */
export function bindPluginManage(
  bridge: PluginManageBridge,
  origin: Readonly<{
    packageId: string
    snapshotId: string | ((sessionKey: string) => string | undefined)
    rowId: string
    leaseId: string
  }>,
): BoundPluginManage {
  return (invocation, signal) => {
    const snapshotId =
      typeof origin.snapshotId === 'string' ? origin.snapshotId : origin.snapshotId(invocation.sessionKey)
    if (!snapshotId)
      throw Object.assign(new Error('Host authoring code provenance is unavailable'), {
        code: 'PLUGIN_MANAGEMENT_UNAVAILABLE',
      })
    return bridge({ ...invocation, ...origin, snapshotId }, signal)
  }
}

/** Shared by installed rows and builtin rows; the port ends with this exact tool invocation. */
export function pluginManageForCall(
  request: BoundPluginManage,
  context: ToolContext,
  lease: Lease,
  signal: AbortSignal,
  finished: () => boolean,
): NonNullable<ToolContext['pluginManage']> {
  return Object.freeze({
    request: async (input: unknown) => {
      const assertLive = () => {
        lease.assertInvocationAlive()
        if (finished()) throw new Error('plugins management invocation expired')
        signal.throwIfAborted()
        if (context.session.depth !== 0 || context.session.generationDepth > 0)
          throw Object.assign(new Error('Subagents cannot manage plugins'), { code: 'CAPABILITY_DENIED' })
      }
      assertLive()
      const value = await hostPortRequest(
        context,
        () =>
          request(
            {
              input: structuredClone(input),
              toolUseId: context.session.toolUseId,
              turn: context.session.turn ?? 0,
              sessionKey: context.session.key,
            },
            signal,
          ),
        refusedForParameters('plugin management'),
      )
      assertLive()
      return value
    },
  })
}
