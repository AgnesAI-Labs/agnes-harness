import type { HostSession, PluginManageInvocation } from '@agnes/host'
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
  signal.throwIfAborted()
  const candidateTestSandbox = session.commandSandboxPolicy?.()
  if (!candidateTestSandbox) throw new Error('Candidate test sandbox policy is unavailable')
  return channel.request('plugin-manage', { ...input, candidateTestSandbox }, signal)
}
