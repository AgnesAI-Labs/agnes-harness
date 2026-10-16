import type { ExtensionAckParams, ExtensionCallParams, ExtensionCallResult } from '@agnes/protocol'
import type { Client } from './client.js'

export type ExtensionClient = Readonly<{
  /** Calls one manifest-declared Service. Actor, source grants, and credentials stay daemon-owned. */
  readonly wakes: Readonly<{
    enqueue(
      input: import('@agnes/protocol').BoundWakeEnqueueParams,
    ): Promise<import('@agnes/protocol').BoundWakeReceipt>
    read(wakeId: string): Promise<import('@agnes/protocol').BoundWakeReceipt>
  }>
  callScoped(
    params: import('@agnes/protocol').ProfileServiceCallParams,
  ): Promise<import('@agnes/protocol').ProfileServiceCallResult>
  readOperation(
    params: import('@agnes/protocol').ProfileServiceOperationParams,
  ): Promise<import('@agnes/protocol').ProfileServiceReceipt>
  call(params: ExtensionCallParams): Promise<ExtensionCallResult>
}>

/** Node-only Service façade. It deliberately exposes no arbitrary RPC method or auth material. */
export function createExtensionClient(client: Client): ExtensionClient {
  return Object.freeze({
    wakes: Object.freeze({
      enqueue: (input: import('@agnes/protocol').BoundWakeEnqueueParams) =>
        client.call<import('@agnes/protocol').BoundWakeReceipt>('_agnes/v1/extension.wakes.enqueue', input),
      read: (wakeId: string) =>
        client.call<import('@agnes/protocol').BoundWakeReceipt>('_agnes/v1/extension.wakes.read', { wakeId }),
    }),
    callScoped: (params) => client.call('_agnes/v1/extension.callScoped', params),
    readOperation: (params) => client.call('_agnes/v1/extension.readOperation', params),
    call: async (params: ExtensionCallParams): Promise<ExtensionCallResult> => {
      const result = await client.call<ExtensionCallResult>('_agnes/v1/extension.call', params)
      if (params.commandId) {
        const receipt: ExtensionAckParams = {
          extension: params.extension,
          service: params.service,
          commandId: params.commandId,
        }
        // Await the acknowledgement: if delivery fails, the caller sees a retryable client error.
        // Retrying the same commandId replays the daemon receipt and cannot execute the effect twice.
        await client.call('_agnes/v1/extension.ack', receipt)
      }
      return result
    },
  })
}
