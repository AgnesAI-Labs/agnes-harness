import type { PackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { CommandQueue } from '@agnes/daemon-rpc/local/command-queue'
import { executeJournaledEffect } from '@agnes/daemon-rpc/local/methods/extensions'
import { ActivationInProgressError, type ExtensionActivationBarrier } from '@agnes/host'
import {
  type ClientModuleEffectCallParams,
  type ExtensionCallParams,
  type ExtensionCallResult,
  rpcError,
} from '@agnes/protocol'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { supervisorHostFacade } from './host-facade.js'
import { workerClientServices } from './service-worker.js'

export function createClientDispatch(
  state: AssemblyBase & StoresState & WorkersState,
  lifetime: AssemblyLifetime,
) {
  const { o, activationBarrier, journal, pool } = state
  const commandQueue = new CommandQueue(undefined, (depth) => o.observability?.queueDepth(depth))
  const queueDrain = { promise: Promise.resolve() }
  lifetime.own({
    stop: () => {
      queueDrain.promise = commandQueue.close()
    },
    drain: () => queueDrain.promise,
    dispose: () => undefined,
  })

  const hostFacade = supervisorHostFacade(o.profile, activationBarrier, pool)
  const host = hostFacade.host
  const services = workerClientServices(pool, () => host.profile)
  const dispatchClientEffect = async (
    input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
    authority: PackageAdminAuthority,
  ): Promise<ExtensionCallResult> => {
    const params: ExtensionCallParams & { commandId: string } = {
      sessionId: input.sessionId,
      extension: input.extension,
      service: input.service,
      commandId: input.commandId,
      input: input.input,
    }
    const credential = Object.freeze({
      kind: 'surface-service' as const,
      source: 'client-web',
      subjectCredential: Object.freeze({ kind: 'local' }),
      grants: Object.freeze([{ extension: input.extension, name: input.service, range: '*' }]),
    })
    let invocation: ReturnType<ExtensionActivationBarrier['admit']>
    try {
      invocation = activationBarrier.admit('service')
    } catch (error) {
      if (error instanceof ActivationInProgressError)
        throw rpcError('OVERLOADED', { reason: error.reason, operationId: error.operationId })
      throw error
    }
    return await invocation.run(async () => {
      const inspection = await services.inspectService(params, credential)
      if (inspection.kind !== 'effect') throw rpcError('CAPABILITY_DENIED')
      const serviceId = `service:client-web:${input.extension}/${input.service}`
      return await executeJournaledEffect({
        journal,
        commandQueue,
        callService: services.callService,
        params,
        credential,
        signal: new AbortController().signal,
        serviceId,
        identity: {
          principalId: authority.principalId,
          clientId: authority.clientId,
          sessionId: `client-module:${input.rowId}:${input.sessionId}`,
          commandId: input.commandId,
        },
        bindingKind: 'client-module.effect',
      })
    })
  }

  return { commandQueue, hostFacade, host, services, dispatchClientEffect }
}

export type DispatchState = ReturnType<typeof createClientDispatch>
