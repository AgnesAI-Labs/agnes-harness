import { randomUUID } from 'node:crypto'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { inspectJsonData } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import type { BatchClient } from './batch.js'

/** Host-owned row identity; no authority or owner selector is accepted from command arguments. */
const extension = pluginRowSource('ext:agnes.batch')
const queries = new Set(['status', 'results', 'list'])
/** Profile services bind actor, source, current activation and native approval on the server. */
export function scopedBatchClient(
  client: Pick<NodeClient, 'extensions'>,
  close: () => Promise<void>,
): BatchClient {
  return {
    async call(verb, input, options) {
      if (!['start', 'status', 'results', 'cancel', 'resume', 'list', 'export'].includes(verb))
        throw new Error('Invalid batch service')
      const checked = inspectJsonData(input, 64 * 1024)
      if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
        throw new Error('Invalid batch request')
      const operationId = queries.has(verb)
        ? undefined
        : (options?.operationId ??
          (verb === 'start' ? `batch.start:${String(input.id)}` : `batch.${verb}:${randomUUID()}`))
      const result = await client.extensions.callScoped({
        extension,
        service: `batch.${verb}`,
        input: checked.value,
        ...(operationId ? { operationId } : {}),
      })
      if (!('state' in result)) return result.output
      if (result.state === 'completed') return result.output
      // Native receipt is evidence, never permission to retry an unknown business effect.
      return { operation: result, ...(input.id ? { batchId: input.id } : {}) }
    },
    close,
  }
}
