import { createHash, randomUUID } from 'node:crypto'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { ProfileActivations } from './activation.js'

export interface PluginWakeBinding {
  producerVersion?: string
  producerPackageId?: string
  actorOrg?: string
  bindingId: string
  producerOwner: string
  producerIntegrity: string
  profileId: string
  activationId: string
  sessionId: string
  laneId: string
  generationId: string
  actorId: string
}
/** Durable target facts only. Jobs own delivery; sessions own atomic input deduplication. */
export class ProfileWakeBindings {
  constructor(
    private readonly store: PersistenceMetadataNamespace,
    private readonly activations: ProfileActivations,
  ) {}
  bind(
    input: Omit<PluginWakeBinding, 'bindingId' | 'activationId'>,
    operationId?: string,
  ): { bindingId: string } {
    const activationId = this.activations.require(input.producerOwner, input.producerIntegrity)
    const bindingId = operationId
      ? createHash('sha256')
          .update(JSON.stringify([input.producerOwner, input.sessionId, input.laneId, operationId]))
          .digest('hex')
      : randomUUID()
    const previous = this.store.get(bindingId) as PluginWakeBinding | undefined
    if (previous) {
      if (
        previous.activationId !== activationId ||
        previous.generationId !== input.generationId ||
        previous.producerIntegrity !== input.producerIntegrity
      )
        throw rpcError('CAPABILITY_DENIED')
      return { bindingId }
    }
    if (this.store.entries().length >= 10000) throw rpcError('OVERLOADED')
    this.store.set(bindingId, { ...input, activationId, bindingId })
    return { bindingId }
  }
  read(bindingId: string): PluginWakeBinding {
    if (typeof bindingId !== 'string' || bindingId.length > 256) throw rpcError('INVALID_PARAMS')
    const binding = this.store.get(bindingId) as PluginWakeBinding | undefined
    if (!binding) throw rpcError('CAPABILITY_DENIED')
    return structuredClone(binding)
  }
  require(bindingId: string): PluginWakeBinding {
    const binding = this.read(bindingId)
    this.activations.require(binding.producerOwner, binding.producerIntegrity, binding.activationId)
    if (this.store.get(`revoked:${binding.sessionId}`) === true) throw rpcError('CAPABILITY_DENIED')
    return binding
  }
  revokeSession(sessionId: string): void {
    this.store.set(`revoked:${sessionId}`, true)
  }
}
