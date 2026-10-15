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
/** Reconcile with native authority. Only an approval-pending proposal is retried with its original id;
 * running/terminal/unknown receipts are read without resending an effect. */
export function profileServices(host: HostProfileServices): ProfileServices {
  type Operation = { name: string; input?: Record<string, unknown>; signal?: AbortSignal }
  const operations = new Map<string, Operation>()
  return {
    async query(name, input, options) {
      options?.signal?.throwIfAborted()
      const params = inputObject(input)
      const result =
        typeof params.sessionId === 'string'
          ? await host.query(name, params, { sessionReads: [params.sessionId] })
          : await host.query(name, params)
      options?.signal?.throwIfAborted()
      return result
    },
    async effect(name, input, { operationId, signal }) {
      signal?.throwIfAborted()
      if (!operations.has(operationId) && operations.size >= 1024) throw new Error('operation-capacity')
      const params = structuredClone(inputObject(input))
      const operation: Operation = { name, input: params, ...(signal ? { signal } : {}) }
      operations.set(operationId, operation)
      const receipt = receiptFrom(await host.effect(name, params, { operationId }), operationId)
      if (receipt.state !== 'approval-required') {
        delete operation.input
        delete operation.signal
      }
      return receipt
    },
    async readOperation(operationId) {
      const operation = operations.get(operationId)
      if (!operation) throw new Error('unknown-operation-service')
      const receipt = receiptFrom(await host.readOperation(operation.name, operationId), operationId)
      if (receipt.state !== 'approval-required') {
        delete operation.input
        delete operation.signal
        return receipt
      }
      operation.signal?.throwIfAborted()
      if (!operation.input) throw new Error('operation-input-unavailable')
      const next = receiptFrom(
        await host.effect(operation.name, operation.input, { operationId }),
        operationId,
      )
      if (next.state !== 'approval-required') {
        delete operation.input
        delete operation.signal
      }
      return next
    },
  }
}
