import type { HostSession, PluginManageInvocation } from '@agnes/host'
import type { JsonValue } from '@agnes/protocol'
import type { SharedSessionChannel } from './shared-session-channel.js'

/** Only the Host can stamp this private-channel decision; plugin/model arguments cannot supply it. */
export async function requestPluginManage(
  session: HostSession | undefined,
  input: PluginManageInvocation,
  signal: AbortSignal,
  channel: Pick<SharedSessionChannel, 'request' | 'currentSessionKey'>,
): Promise<unknown> {
  signal.throwIfAborted()
  if (input.sessionKey !== channel.currentSessionKey()) throw new Error('Plugin management session mismatch')
  const args = input.input as { action?: unknown } | null
  if (args?.action !== 'test' && args?.action !== 'candidate.test')
    return channel.request('plugin-manage', input, signal)
  if (!session || session.key !== input.sessionKey) throw new Error('Candidate test session is not open')
  // The resolved preset, command floor and plan wrapper own permission. Other presets retain the
  // existing human test gate even if they allow ordinary tools or approvals.mode is off.
  let candidateTestPolicy: 'allow' | 'ask' = 'ask'
  if (session.preset.approval.policy === 'full-access') {
    const decision = await session.toolPolicy().decide(
      {
        sessionKey: session.key,
        workspaceRoot: session.workspaceRoot,
        cwd: session.d.cwd,
        actor: session.d.actor,
        call: { id: input.toolUseId, name: 'plugin_candidate_test', args: input.input as JsonValue },
        policy: {
          isReadOnly: false,
          isDestructive: false,
          replay: 'never',
          requiresApproval: 'always',
          approvalScopes: ['plugin.test'],
        },
        tainted: false,
        fullAccess: session.yolo,
        approvalMode: session.d.approvalMode ?? 'manual',
      },
      signal,
    )
    if (decision.effect === 'allow' && !decision.approval) candidateTestPolicy = 'allow'
  }
  signal.throwIfAborted()
  return channel.request('plugin-manage', { ...input, candidateTestPolicy }, signal)
}
