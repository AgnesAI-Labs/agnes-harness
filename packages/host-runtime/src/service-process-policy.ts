import { resolveToolCallPolicy, type ServiceContext } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { HostSession } from './host.js'

/** An explicit human process request still obeys preset and plan-mode refusal. */
export async function authorizeServiceProcess(
  session: HostSession | undefined,
  identity: Pick<ServiceContext, 'actor' | 'session' | 'requestId' | 'signal'>,
  cwd: string,
): Promise<void> {
  if (!session || session.key !== identity.session?.key || cwd !== session.d.cwd)
    throw rpcError('CAPABILITY_DENIED')
  identity.signal.throwIfAborted()
  const tool = session.currentTools().snapshot(session.lastSeq).byName.get('pty_open')
  if (!tool) throw rpcError('CAPABILITY_DENIED')
  const decision = await session.d.runtime.authorize(identity.actor, 'execute', {
    kind: 'skill',
    id: 'pty_open',
  })
  if (decision.effect !== 'allow') throw rpcError('CAPABILITY_DENIED')
  const args = { cwd }
  const permission = await session.toolPolicy().decide(
    {
      sessionKey: session.key,
      cwd,
      actor: identity.actor,
      call: { id: identity.requestId, name: 'pty_open', args },
      policy: resolveToolCallPolicy(tool, args),
      tainted: false,
      fullAccess: session.yolo,
      // The authenticated human's Open action supplies approval; it cannot override policy denial.
      approvalMode: 'off',
    },
    identity.signal,
  )
  if (permission?.effect !== 'allow') throw rpcError('CAPABILITY_DENIED')
}
