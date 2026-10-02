import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type RecordOwner, validateRuntime } from '@agnes/protocol/runtime'
import { frozenJson } from '../../ext-host/frozen-json.js'
import { refuse } from '../state/refusal.js'
import type { RuntimeApprovalJointOwner } from '../state/transactions.js'
import { type ApprovalAuthenticationOwner, createApprovalResponderBridge } from './approval-responder.js'
import type { IdentityAuthority } from './authority.js'

type Lifecycle = {
  ready(): void | Promise<void>
  current(): boolean
}

/** These are installed Host owners, never fields of a transport request. */
export type ApprovalOwnerSources = {
  identity: Pick<IdentityAuthority, 'current'>
  authentication: ApprovalAuthenticationOwner & { ready(): void | Promise<void>; sourceCurrent(): boolean }
  selection: Lifecycle & {
    readonly owner: RecordOwner
    assertJoint: RuntimeApprovalJointOwner['assertJoint']
  }
  policy: Lifecycle & {
    ask: RuntimeApprovalJointOwner['ask']
    verifyAuthorizationPreparation: NonNullable<RuntimeApprovalJointOwner['verifyAuthorizationPreparation']>
    verifyApprovalAsk: NonNullable<RuntimeApprovalJointOwner['verifyApprovalAsk']>
  }
}

function synchronous<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
    refuse('denied', 'approval_owner', 'approval source must finish synchronously')
  return value
}

/** Composes the existing identity and joint State ports without installing another authority. */
export function createApprovalOwnerInstallation(sources: ApprovalOwnerSources) {
  let phase: 'new' | 'starting' | 'ready' | 'failed' | 'closed' = 'new'
  const closed = () => phase === 'closed'
  let starting: Promise<void> | undefined
  let owner: RecordOwner | undefined
  let bridge: ReturnType<typeof createApprovalResponderBridge> | undefined

  function present() {
    if (
      !sources?.identity?.current ||
      !sources.authentication?.ready ||
      !sources.authentication.current ||
      !sources.authentication.sourceCurrent ||
      !sources.selection?.ready ||
      !sources.selection.current ||
      !sources.selection.assertJoint ||
      !sources.policy?.ready ||
      !sources.policy.current ||
      !sources.policy.ask ||
      !sources.policy.verifyAuthorizationPreparation ||
      !sources.policy.verifyApprovalAsk ||
      !validateRuntime('RecordOwner', sources.selection.owner).ok ||
      sources.selection.owner.ownerBinding.contract !== 'agh.interaction'
    )
      refuse('denied', 'approval_owner', 'actual approval installation sources are missing')
  }
  function relation(expectedPhase: typeof phase) {
    if (
      phase !== expectedPhase ||
      sources.identity !== originalSources.identity ||
      sources.authentication !== originalSources.authentication ||
      sources.selection !== originalSources.selection ||
      sources.policy !== originalSources.policy ||
      (owner && jcs(sources.selection.owner) !== jcs(owner))
    )
      refuse(
        'denied',
        'approval_owner',
        'approval installation source objects were replaced or lifecycle changed',
      )
  }
  function currentSources() {
    if (phase !== 'starting' && phase !== 'ready')
      refuse('denied', 'approval_owner', 'approval installation is not current')
    present()
    const expectedPhase = phase
    relation(expectedPhase)
    for (const check of [
      () => originalSources.selection.current(),
      () => originalSources.authentication.sourceCurrent(),
      () => originalSources.policy.current(),
    ]) {
      const result = synchronous(check())
      relation(expectedPhase)
      if (result !== true)
        refuse('denied', 'approval_owner', 'actual approval installation sources are no longer current')
    }
  }
  const originalSources = {
    identity: sources?.identity,
    authentication: sources?.authentication,
    selection: sources?.selection,
    policy: sources?.policy,
  }
  function current(context?: CallContext) {
    if (phase !== 'ready') refuse('denied', 'approval_owner', 'approval installation is not ready')
    if (!owner || !bridge) refuse('denied', 'approval_owner', 'approval installation sources are absent')
    currentSources()
    if (context) {
      const identity = sources.identity.current(context)
      if (
        !identity ||
        !owner ||
        context.bindingId !== owner.ownerBinding.bindingId ||
        jcs(context.scope) !== jcs(owner.scope)
      )
        refuse('denied', 'approval_current', 'approval call has no actual current identity')
      currentSources()
    }
    return { owner, bridge }
  }
  function finish(context: CallContext) {
    if (phase !== 'ready') refuse('denied', 'approval_owner', 'approval installation is not ready')
    relation('ready')
    const identity = sources.identity.current(context)
    if (
      !identity ||
      !owner ||
      context.bindingId !== owner.ownerBinding.bindingId ||
      jcs(context.scope) !== jcs(owner.scope)
    )
      refuse('denied', 'approval_current', 'approval call has no actual current identity')
    relation('ready')
  }
  const joint: RuntimeApprovalJointOwner = Object.freeze({
    get owner() {
      return current().owner
    },
    assertJoint(context, authority, sessionId) {
      current(context)
      if (synchronous(sources.selection.assertJoint(context, authority, sessionId)) !== undefined)
        refuse('denied', 'approval_owner', 'approval joint qualification must finish synchronously')
      current(context)
      finish(context)
    },
    currentResponder(context, capability) {
      current(context)
      const result = current(context).bridge.currentResponder(context, capability)
      current(context)
      const again = bridge?.currentResponder(context, capability)
      if (!again || jcs(again) !== jcs(result))
        refuse('denied', 'approval_current', 'approval human source changed')
      finish(context)
      return result
    },
    ask(context, preparation, interaction) {
      current(context)
      const result = synchronous(sources.policy.ask(context, preparation, interaction))
      current(context)
      finish(context)
      return result
    },
    verifyAuthorizationPreparation(preparation, action, guard) {
      current()
      const result = synchronous(sources.policy.verifyAuthorizationPreparation(preparation, action, guard))
      current()
      return result
    },
    verifyApprovalAsk(command, action, guard) {
      current()
      const result = synchronous(sources.policy.verifyApprovalAsk(command, action, guard))
      current()
      return result
    },
  })
  return Object.freeze({
    joint,
    ready(): Promise<void> {
      if (phase === 'ready') {
        try {
          currentSources()
          return Promise.resolve()
        } catch (error) {
          phase = 'failed'
          return Promise.reject(error)
        }
      }
      if (phase === 'starting' && starting) return starting
      if (phase !== 'new') return Promise.reject(new Error('approval installation cannot become ready'))
      phase = 'starting'
      starting = (async () => {
        try {
          currentSources()
          owner = frozenJson(sources.selection.owner)
          for (const source of [sources.selection, sources.authentication, sources.policy]) {
            await source.ready()
            if (phase !== 'starting') throw new Error('approval installation closed during readiness')
            currentSources()
          }
          bridge = createApprovalResponderBridge({
            authority: sources.identity,
            authentication: sources.authentication,
          })
          currentSources()
          phase = 'ready'
        } catch (error) {
          if (!closed()) phase = 'failed'
          bridge = undefined
          throw error
        }
      })()
      return starting
    },
    issueResponder(context: CallContext, authentication: unknown): object | null {
      current(context)
      const capability = current(context).bridge.issue(context, authentication)
      current(context)
      if (capability) bridge?.currentResponder(context, capability)
      finish(context)
      return capability
    },
    close(): void {
      phase = 'closed'
      bridge = undefined
    },
  })
}
