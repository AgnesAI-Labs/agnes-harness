import type { JsonValue } from '@agnes/protocol'
import { asJson, record, text } from './model.js'
import type { HostProfileServices, ProfileServices, Receipt } from './ports.js'

function inputObject(input: JsonValue): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-service-input')
  return input
}
export function receiptFrom(value: unknown, operationId: string): Receipt {
  const receipt = record(value),
    state = text(receipt.state)
  if (receipt.operationId !== operationId) throw new Error('invalid-operation-receipt')
  if (state === 'approval-required') return { state, operationId }
  if (state === 'running') return { state, operationId }
  if (state === 'completed') return { state, operationId, output: asJson(receipt.output ?? null) }
  if (state === 'refused' || state === 'cancelled' || state === 'unknown')
    return { state, operationId, code: text(receipt.code) || state }
  throw new Error('invalid-operation-receipt')
}
/** Retain the service association for read-only reconciliation; never repeat an effect dispatch. */
export function profileServices(host: HostProfileServices): ProfileServices {
  const operations = new Map<string, string>()
  return {
    async query(name, input, options) {
      options?.signal?.throwIfAborted()
      const result = await host.query(name, inputObject(input))
      options?.signal?.throwIfAborted()
      return result
    },
    async effect(name, input, { operationId, signal }) {
      signal?.throwIfAborted()
      operations.set(operationId, name)
      return receiptFrom(await host.effect(name, inputObject(input), { operationId }), operationId)
    },
    async readOperation(operationId) {
      const name = operations.get(operationId)
      if (!name) throw new Error('unknown-operation-service')
      return receiptFrom(await host.readOperation(name, operationId), operationId)
    },
  }
}
