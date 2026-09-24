import type { ExtensionAckParams, ExtensionCallParams, ExtensionCallResult } from '@agnes/protocol'
import type { Client } from './client.js'

export type ExtensionClient = Readonly<{
  /** Calls one manifest-declared Service. Actor, source grants, and credentials stay daemon-owned. */
  call(params: ExtensionCallParams): Promise<ExtensionCallResult>
}>

/** Node-only Service façade. It deliberately exposes no arbitrary RPC method or auth material. */
export function createExtensionClient(client: Client): ExtensionClient {
  return Object.freeze({
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
