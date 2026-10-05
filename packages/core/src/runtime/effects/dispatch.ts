import type { CallContext, EffectPorts } from '@agnes/extension-api/runtime'
import {
  canonicalJsonDigest,
  type EffectResult,
  type EffectsDispatchRequest,
  type EffectsDispatchResult,
  type ExternalRequestRef,
} from '@agnes/protocol/runtime'
import type { EffectsAuthority } from './authority.js'
import { captureEffectExecution, recordEffectCompletion } from './completion.js'

export class EffectUncertain extends Error {
  constructor(readonly attempt: import('@agnes/protocol/runtime').AttemptRef) {
    super('Effect outcome requires original attempt reconciliation')
  }
}
const digest = (value: unknown) => canonicalJsonDigest(value as never)
export async function dispatchCommittedEffect(
  authority: EffectsAuthority,
  request: EffectsDispatchRequest,
  context: CallContext,
  current: (staticOnly?: boolean) => void,
  trackPending?: (task: Promise<unknown>) => void,
): Promise<EffectsDispatchResult> {
  current()
  await authority.checkCurrent(context)
  current()
  const original = await authority.readCommitted(request, context)
  current()
  const originalDigest = digest(original)
  const admitted = await authority.admit(original, request, context)
  current()
  if (originalDigest !== digest(original) || admitted.original !== original)
    throw new Error('Committed action source changed')
  authority.assertOriginal(admitted, context)
  current()
  if (admitted.state.status === 'unknown' || admitted.state.status === 'settled') return admitted.state
  if (admitted.state.status === 'running') {
    try {
      return await authority.unknown(admitted, admitted.externalRequests)
    } catch {
      throw new EffectUncertain(admitted.attempt)
    }
  }
  const unknown = async (completed?: EffectResult) => {
    try {
      return await authority.unknown(admitted, external, completed)
    } catch {
      throw new EffectUncertain(admitted.attempt)
    }
  }
  const identity = digest(admitted.requestIdentity)
  const frame = digest(admitted.frame)
  const leaf = admitted.leaf
  const ports = admitted.context.effects
  const invokeDescriptor = Object.getOwnPropertyDescriptor(ports, 'invoke')
  if (!invokeDescriptor || !('value' in invokeDescriptor) || typeof invokeDescriptor.value !== 'function')
    throw new Error('Primitive port requires an own data method')
  const invoke: EffectPorts['invoke'] = invokeDescriptor.value
  const external: ExternalRequestRef[] = []
  let entered = false
  let reserved = false
  let portFailed = false
  let accepting = true
  const pending = new Set<Promise<unknown>>()
  const staticFence = (staticOnly = false) => {
    current(staticOnly)
    const deadline = Date.parse(context.deadline)
    const now = staticOnly ? deadline : Date.parse(authority.now())
    if (
      !Number.isFinite(deadline) ||
      !Number.isFinite(now) ||
      !accepting ||
      context.signal.aborted ||
      (!staticOnly && deadline <= now)
    )
      throw new Error('Effect invocation closed')
    if (
      admitted.leaf !== leaf ||
      admitted.context.effects !== ports ||
      Object.getOwnPropertyDescriptor(ports, 'invoke')?.value !== invoke ||
      !('value' in (Object.getOwnPropertyDescriptor(ports, 'invoke') ?? {})) ||
      identity !== digest(admitted.requestIdentity) ||
      frame !== digest(admitted.frame)
    )
      throw new Error('Effect source changed')
  }
  const fence = () => {
    staticFence()
    authority.assertOriginal(admitted, context)
    staticFence()
  }
  const restricted: EffectPorts = {
    async invoke(call, callContext) {
      fence()
      if (reserved) throw new Error('Single effect already admitted')
      reserved = true
      if (callContext !== admitted.context.call) throw new Error('Foreign leaf context')
      const callDigest = digest(call)
      const reference = authority.external(admitted, call)
      const referenceDigest = digest(reference)
      const task = (async () => {
        await authority.markRunning(admitted, reference)
        fence()
        if (digest(call) !== callDigest || digest(reference) !== referenceDigest)
          throw new Error('Physical request changed')
        authority.assertSend(admitted, call, callContext)
        staticFence(true)
        if (digest(call) !== callDigest || digest(reference) !== referenceDigest)
          throw new Error('Physical request changed')
        // Port entry is conservative evidence of possible effect; failure is never proof of no effect.
        entered = true
        external.push(reference)
        return invoke.call(ports, call, callContext)
      })()
      pending.add(task)
      trackPending?.(task)
      try {
        return await task
      } catch (cause) {
        portFailed = true
        throw cause
      } finally {
        pending.delete(task)
      }
    },
    async stream() {
      throw new Error('Streaming is not installed')
    },
    async upload() {
      throw new Error('Upload is not installed')
    },
  }
  let result: EffectResult
  try {
    fence()
    const execution = captureEffectExecution(leaf, authority, admitted)
    result = await Reflect.apply(execution.execute, leaf, [
      admitted.frame,
      { ...admitted.context, effects: restricted },
    ])
    recordEffectCompletion(authority, admitted, result, execution)
    accepting = false
    // Durable unknown evidence must not wait for an unresponsive original transport.
    if (result.outcome === 'unknown_effect' || (entered && portFailed)) return unknown(result)
    await Promise.allSettled([...pending])
  } catch (cause) {
    accepting = false
    if (entered) return unknown()
    await Promise.allSettled([...pending])
    throw cause
  }
  // Real late receipts remain evidence after cancellation/revocation. Intake owns its own current role.
  if (entered && portFailed) return unknown(result)
  try {
    return await authority.intake(admitted, result)
  } catch (cause) {
    if (!entered) throw cause
    return unknown(result)
  }
}
