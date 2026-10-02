import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type DataRef, validateRuntime } from '@agnes/protocol/runtime'
import { frozenJson } from '../../ext-host/frozen-json.js'
import type { CurrentIdentity, IdentityAuthority } from './authority.js'

/** Actual human ingress owns this check and its original authentication record reference. */
export interface ApprovalAuthenticationOwner {
  current(
    authentication: unknown,
    context: CallContext,
    identity: CurrentIdentity,
  ): Readonly<{ actorRef: string; authenticationRef: DataRef }> | null
}

type Responder = Readonly<{
  actorRef: string
  evidence: Readonly<{ kind: 'human'; authenticationRef: DataRef }>
}>

/** Connects a real issued context to an opaque human proof; credential kind never implies human. */
export function createApprovalResponderBridge(ports: {
  authority: Pick<IdentityAuthority, 'current'>
  authentication: ApprovalAuthenticationOwner
}) {
  if (!ports?.authority?.current || !ports.authentication?.current)
    throw new Error('approval authentication owner absent')
  const capabilities = new WeakMap<
    object,
    {
      context: CallContext
      authentication: unknown
      identity: string
      responder: Responder
    }
  >()
  function read(context: CallContext, authentication: unknown) {
    const identity = ports.authority.current(context)
    if (!identity) return null
    const actual = ports.authentication.current(authentication, context, identity)
    if (
      !actual ||
      actual.actorRef !== identity.identity.principalRef ||
      !validateRuntime('Id', actual.actorRef).ok ||
      !validateRuntime('DataRef', actual.authenticationRef).ok
    )
      return null
    const proofSnapshot = jcs({ actorRef: actual.actorRef, authenticationRef: actual.authenticationRef })
    const responder: Responder = Object.freeze({
      actorRef: actual.actorRef,
      evidence: frozenJson({
        kind: 'human' as const,
        authenticationRef: JSON.parse(jcs(actual.authenticationRef)) as DataRef,
      }),
    })
    // Current proof owners cannot mint a capability while changing the real context's source.
    const again = ports.authority.current(context)
    const proof = again && ports.authentication.current(authentication, context, again)
    if (
      !again ||
      jcs(again) !== jcs(identity) ||
      !proof ||
      jcs({ actorRef: proof.actorRef, authenticationRef: proof.authenticationRef }) !== proofSnapshot
    )
      return null
    return { identity: jcs(identity), responder }
  }
  return Object.freeze({
    issue(context: CallContext, authentication: unknown): object | null {
      const actual = read(context, authentication)
      if (!actual) return null
      const capability = Object.freeze(Object.create(null)) as object
      capabilities.set(capability, { context, authentication, ...actual })
      return capability
    },
    currentResponder(context: CallContext, capability: unknown): Responder {
      const associated =
        capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
      const current = associated?.context === context && read(context, associated.authentication)
      if (
        !associated ||
        !current ||
        current.identity !== associated.identity ||
        jcs(current.responder) !== jcs(associated.responder)
      )
        throw new Error('actual approval responder is not current')
      return current.responder
    },
  })
}
