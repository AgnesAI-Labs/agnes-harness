import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { DeferredInvocationReceipt, IntelligentUiFactory } from '@agnes/extension-api'
import {
  jcs,
  rpcError,
  UiActionParams,
  UiCloseParams,
  UiReadParams,
  UiRenderParams,
  UiUpdateParams,
  validateAgainst,
  X_AGNES_UI_LIMITS,
  type UiActionReceipt,
  type UiRefusal,
  type UiSurfaceRecord,
} from '@agnes/protocol'
import { foldUiEvent, initialUiState, type ActionRecord, type UiState } from './state.js'
import { bindArguments, bounded, json, validateSurface } from './validation.js'

const unfinished = (record: ActionRecord) =>
  ['received', 'executing', 'pending-approval'].includes(record.receipt.status)
const terminal = (record: ActionRecord) => ['rejected', 'succeeded', 'failed'].includes(record.receipt.status)
const stale = (closed = false, revision?: number): UiRefusal => ({
  reason: closed ? 'closed' : 'stale',
  code: closed ? 'UI_CLOSED' : 'UI_STALE',
  message: 'data changed, please re-confirm',
  ...(revision ? { currentRevision: revision } : {}),
})
const invalid = (message: string): UiRefusal => ({
  reason: 'invalid',
  code: 'UI_INVALID',
  message: message.slice(0, 1024),
})
const unauthorized = (): UiRefusal => ({
  reason: 'unauthorized',
  code: 'UI_UNAUTHORIZED',
  message: 'The declared tool was denied by the existing tool policy.',
})
export const createIntelligentUiService: IntelligentUiFactory = (ports) => {
  let tail = Promise.resolve()
  const serial = <T>(work: () => Promise<T>) => {
    const result = tail.then(work, work)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const cursorSecret = randomBytes(32)
  const state = async (through = ports.lastSeq) => {
    let value = initialUiState()
    for (const row of await ports.scan()) if (row.seq <= through) value = foldUiEvent(value, row)
    return value
  }
  const append = async (name: string, value: unknown, sourceSeq?: number) =>
    ports.append(name, json(value), sourceSeq)
  const boundSession = (id: string) => {
    if (id !== ports.session.key) throw rpcError('CAPABILITY_DENIED')
  }
  const blocked = (value: UiState, id: string) =>
    Object.values(value.actions).some(
      (action) =>
        action.request.surfaceId === id && (unfinished(action) || action.receipt.failure?.outcomeUnknown),
    )
  const delivery = async (record: ActionRecord, signal: AbortSignal) => {
    if (!terminal(record) || record.deliveredSeq) return
    const receipt = record.receipt
    const inboxSeq = await ports.deliver(
      `ui-result:${receipt.commandId}`,
      'Intelligent UI action result: ' + JSON.stringify(receipt),
      record.actor,
      signal,
    )
    await append(
      'action.delivered',
      { commandId: receipt.commandId, receiptSeq: receipt.seq, inboxSeq },
      receipt.seq,
    )
  }
  const queue = async (record: ActionRecord, signal: AbortSignal) => {
    if (record.invocation && unfinished(record)) {
      try {
        await ports.queue.enqueue({ ...record.invocation, sourceSeq: record.receivedSeq }, signal)
      } catch (error) {
        signal.throwIfAborted()
        // A failed wake after admission must keep the original queued invocation executable.
        const admitted = await ports.queue.read(record.invocation.id, signal)
        if (
          admitted &&
          jcs(admitted.invocation) === jcs({ ...record.invocation, sourceSeq: record.receivedSeq })
        )
          return
        await append(
          'action.failed',
          {
            commandId: record.request.commandId,
            receipt: {
              ...record.receipt,
              status: 'failed',
              failure: {
                code: 'UI_NOT_DISPATCHED',
                message: 'Invocation admission failed before dispatch',
                retryable: true,
                outcomeUnknown: false,
              },
            },
          },
          record.receipt.seq,
        )
        await delivery((await state()).actions[record.request.commandId]!, signal)
      }
    }
  }
  const recover = async (signal: AbortSignal) => {
    // Producer callbacks have their own serialization; do not notify while holding this serial lock.
    const value = await state()
    for (const record of Object.values(value.actions)) {
      if (record.receipt.status === 'received') {
        if (record.invocation) await queue(record, signal)
        else await refusal(record, record.refusalPending ?? invalid('Interrupted action validation'), signal)
      }
      if (terminal(record)) await delivery(record, signal)
    }
    return state()
  }
  const storeSurface = async (name: string, record: UiSurfaceRecord, value: UiState, reason?: string) => {
    // Projection byte budget includes current snapshots and a bounded receipt page.
    const surfaces = { ...value.surfaces, [record.surface.id]: record }
    bounded(Object.fromEntries(Object.entries(surfaces).filter(([, item]) => item.status === 'open')), X_AGNES_UI_LIMITS.projectionBytes - 65536, 20)
    await append(name, { record, ...(reason ? { reason } : {}) }, record.updatedSeq || undefined)
    return (await state()).surfaces[record.surface.id]!
  }
  const refusal = async (record: ActionRecord, reason: UiRefusal, signal: AbortSignal) => {
    if (!record.receivedSeq) {
      record.refusalPending = reason
      record.receivedSeq = await append('action.received', { record })
    }
    record.receipt = { ...record.receipt, status: 'rejected', refusal: reason }
    await append('action.rejected', { record }, record.receivedSeq || undefined)
    const persisted = (await state()).actions[record.request.commandId]!
    await delivery(persisted, signal)
    return persisted.receipt
  }
  const changed = (receipt: DeferredInvocationReceipt, signal: AbortSignal) =>
    serial(async () => {
      signal.throwIfAborted()
      const value = await state()
      const record = Object.values(value.actions).find(
        (item) => item.receipt.invocationId === receipt.invocation.id,
      )
      if (
        !record ||
        !record.invocation ||
        jcs({ ...record.invocation, sourceSeq: record.receivedSeq }) !== jcs(receipt.invocation)
      )
        throw new Error('Unbound UI invocation receipt')
      if (receipt.state === 'queued') return
      if (record.deferredSeq === receipt.seq || terminal(record)) {
        await delivery(record, signal)
        return
      }
      const text = receipt.result?.content
        .filter((item) => item.type === 'text')
        .map((item) => (item as { text: string }).text)
        .join('\n')
        .slice(0, 4096)
      const denied =
        receipt.state === 'failed' &&
        [
          'CAPABILITY_DENIED',
          'HOOK_DENIED',
          'AUTHZ_DENIED',
          'POLICY_DENIED',
          'APPROVAL_REJECTED',
          'APPROVAL_TIMEOUT',
          'APPROVAL_UNAVAILABLE',
          'SANDBOX_UNAVAILABLE',
          'E_FS_DENIED',
        ].includes(receipt.error?.code ?? '')
      const next: UiActionReceipt = {
        ...record.receipt,
        status: denied ? 'rejected' : receipt.state,
        ...(receipt.approvalId ? { approvalId: receipt.approvalId } : {}),
        ...(receipt.resultSeq ? { resultSeq: receipt.resultSeq } : {}),
        ...(text ? { summary: text } : {}),
        ...(denied ? { refusal: unauthorized() } : receipt.error ? { failure: receipt.error } : {}),
      }
      if (denied) {
        await append(
          'action.rejected',
          { record: { ...record, deferredSeq: receipt.seq, receipt: next } },
          record.receipt.seq,
        )
      } else
        await append(
          `action.${next.status}`,
          { commandId: record.request.commandId, deferredSeq: receipt.seq, receipt: next },
          record.receipt.seq,
        )
      await delivery((await state()).actions[record.request.commandId]!, signal)
    })
  return {
    render: (input, signal) =>
      serial(async () => {
        signal.throwIfAborted()
        if (!validateAgainst(UiRenderParams, input).ok) throw rpcError('INVALID_PARAMS')
        validateSurface(input.surface, ports)
        const value = await state(),
          old = value.surfaces[input.surface.id]
        if (old || input.surface.revision !== 1) throw rpcError('SEMANTIC_REJECTED', { code: 'UI_STALE' })
        if (
          Object.values(value.surfaces).filter((item) => item.status === 'open').length >=
          X_AGNES_UI_LIMITS.liveSurfaces
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'UI_LIMIT' })
        return storeSurface(
          'surface.opened',
          {
            surface: structuredClone(input.surface),
            status: 'open',
            createdSeq: 0,
            updatedSeq: 0,
            owner: ports.owner,
            lane: ports.session.lane,
            taskId: ports.taskId,
          },
          value,
        )
      }),
    update: (input, signal) =>
      serial(async () => {
        signal.throwIfAborted()
        if (!validateAgainst(UiUpdateParams, input).ok) throw rpcError('INVALID_PARAMS')
        validateSurface(input.surface, ports)
        const value = await state(),
          old = value.surfaces[input.surfaceId]
        if (
          !old ||
          old.status !== 'open' ||
          old.surface.revision !== input.expectedRevision ||
          input.surface.id !== input.surfaceId ||
          input.surface.revision !== input.expectedRevision + 1
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'UI_STALE' })
        if (blocked(value, input.surfaceId)) throw rpcError('SEMANTIC_REJECTED', { code: 'UI_BUSY' })
        return storeSurface('surface.updated', { ...old, surface: structuredClone(input.surface) }, value)
      }),
    close: (input, signal) =>
      serial(async () => {
        signal.throwIfAborted()
        if (!validateAgainst(UiCloseParams, input).ok) throw rpcError('INVALID_PARAMS')
        const value = await state(),
          old = value.surfaces[input.surfaceId]
        if (!old || old.surface.revision !== input.expectedRevision)
          throw rpcError('SEMANTIC_REJECTED', { code: 'UI_STALE' })
        if (old.status === 'closed') return old
        if (blocked(value, input.surfaceId)) throw rpcError('SEMANTIC_REJECTED', { code: 'UI_BUSY' })
        return storeSurface('surface.closed', { ...old, status: 'closed' }, value, input.reason)
      }),
    action: (input, actor, signal) =>
      serial(async () => {
        signal.throwIfAborted()
        bounded(input, X_AGNES_UI_LIMITS.actionBytes)
        if (!validateAgainst(UiActionParams, input).ok) throw rpcError('INVALID_PARAMS')
        boundSession(input.sessionId)
        const request = structuredClone(input),
          value = await state(),
          old = value.actions[request.commandId]
        if (old) {
          if (jcs(old.request) !== jcs(request) || old.actor.id !== actor.id || old.actor.org !== actor.org)
            throw rpcError('SEMANTIC_REJECTED', { code: 'UI_COMMAND_CONFLICT', reason: 'duplicate' })
          await queue(old, signal)
          await delivery(old, signal)
          return { ...(await state()).actions[request.commandId]!.receipt, duplicate: true }
        }
        const recent = Object.values(value.actions).filter((item) => item.receivedAt > ports.now() - 60000)
        if (
          recent.length >= X_AGNES_UI_LIMITS.newCommandsPerMinute ||
          Object.values(value.actions).filter(unfinished).length >=
            X_AGNES_UI_LIMITS.pendingCommandsPerSession
        )
          throw rpcError('OVERLOADED', { code: 'UI_RATE_LIMIT', retryAfterMs: 60000 })
        const record: ActionRecord = {
          request,
          actor: structuredClone(actor),
          receivedAt: ports.now(),
          receivedSeq: 0,
          receipt: {
            sessionId: request.sessionId,
            surfaceId: request.surfaceId,
            revision: request.revision,
            actionId: request.actionId,
            commandId: request.commandId,
            status: 'received',
            seq: 1,
            duplicate: false,
            ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          },
        }
        const surface = value.surfaces[request.surfaceId]
        if (!surface || surface.surface.revision !== request.revision || surface.status === 'closed')
          return refusal(record, stale(surface?.status === 'closed', surface?.surface.revision), signal)
        if (
          !ports.supportsDeferredInvocations ||
          surface.owner !== ports.owner ||
          surface.lane !== ports.session.lane
        )
          return refusal(record, unauthorized(), signal)
        if (request.retryOf) {
          const prior = value.actions[request.retryOf]
          if (
            !prior ||
            prior.receipt.status !== 'failed' ||
            !prior.receipt.failure?.retryable ||
            prior.receipt.failure.outcomeUnknown ||
            prior.request.surfaceId !== request.surfaceId ||
            prior.request.actionId !== request.actionId ||
            Object.values(value.actions).some((item) => item.request.retryOf === request.retryOf)
          )
            return refusal(record, invalid('Original action cannot be retried'), signal)
        }
        if (blocked(value, request.surfaceId))
          throw rpcError('OVERLOADED', { code: 'UI_BUSY', reason: 'surface has an unfinished action' })
        let args
        try {
          args = bindArguments(surface.surface, request, ports)
        } catch (error) {
          return refusal(
            record,
            invalid(error instanceof Error ? error.message : 'Invalid UI action'),
            signal,
          )
        }
        const action = surface.surface.actions.find((item) => item.id === request.actionId)!
        const id =
          'ui:' +
          createHash('sha256')
            .update(
              jcs({ surfaceId: request.surfaceId, revision: request.revision, commandId: request.commandId }),
            )
            .digest('hex')
        record.taskId = surface.taskId
        record.surfaceSeq = surface.updatedSeq
        record.receipt.invocationId = id
        record.invocation = {
          id,
          sessionKey: ports.session.key,
          lane: ports.session.lane,
          source: ports.owner,
          sourceSeq: 1,
          actor: record.actor,
          tool: action.tool,
          args,
        }
        await append('action.received', { record }, surface.updatedSeq)
        const persisted = (await state()).actions[request.commandId]!
        if (request.retryOf)
          await append(
            'action.retried',
            { commandId: request.commandId, retryOf: request.retryOf },
            persisted.receivedSeq,
          )
        await queue(persisted, signal)
        return (await state()).actions[request.commandId]!.receipt
      }),
    read: async (input, signal) => {
      if (!validateAgainst(UiReadParams, input).ok) throw rpcError('INVALID_PARAMS')
      boundSession(input.sessionId)
      await serial(() => recover(signal))
      await ports.queue.notify(signal)
      return serial(async () => {
        signal.throwIfAborted()
        const filter = createHash('sha256').update(jcs({ surfaceId: input.surfaceId ?? null, commandId: input.commandId ?? null, limit: input.limit ?? 16 })).digest('hex')
        let watermark = ports.lastSeq, offset = 0, expires = ports.now() + 60000
        if (input.cursor) {
          const [body, signature, extra] = input.cursor.split('.')
          if (!body || !signature || extra || createHmac('sha256', cursorSecret).update(body).digest('base64url') !== signature)
            throw rpcError('INVALID_PARAMS', { reason: 'UI cursor invalid' })
          const cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { w: number; o: number; e: number; f: string }
          if (!Number.isSafeInteger(cursor.w) || cursor.w < 0 || cursor.w > ports.lastSeq || !Number.isSafeInteger(cursor.o) || cursor.o < 1 || !Number.isSafeInteger(cursor.e) || cursor.e <= ports.now() || cursor.f !== filter)
            throw rpcError('INVALID_PARAMS', { reason: 'UI cursor expired or filter changed' })
          watermark = cursor.w; offset = cursor.o; expires = cursor.e
        }
        const value = await state(watermark),
          all = Object.values(value.surfaces)
            .filter((item) => input.surfaceId ? item.surface.id === input.surfaceId : item.status === 'open')
            .sort((a, b) => a.createdSeq - b.createdSeq)
        const limit = input.limit ?? 16,
          surfaces = all.slice(offset, offset + limit)
        // One bounded receipt page per snapshot, never duplicated on subsequent surface pages.
        const actions = offset ? [] : Object.values(value.actions)
          .filter((item) => (!input.commandId || item.request.commandId === input.commandId) && (!input.surfaceId || item.request.surfaceId === input.surfaceId))
          .sort((a, b) => Number(unfinished(b)) - Number(unfinished(a)) || b.receipt.seq - a.receipt.seq)
          .slice(0, 64).map((item) => item.receipt)
        while (Buffer.byteLength(JSON.stringify(actions)) > 64512 && actions.length) actions.pop()
        const next = offset + limit < all.length ? Buffer.from(jcs({ w: watermark, o: offset + limit, e: expires, f: filter })).toString('base64url') : undefined
        const result = {
          sessionId: ports.session.key,
          lastSeq: watermark,
          surfaces, actions,
          ...(next ? { nextCursor: next + '.' + createHmac('sha256', cursorSecret).update(next).digest('base64url') } : {}),
        }
        bounded(result, X_AGNES_UI_LIMITS.projectionBytes, 20)
        return result
      })
    },
    validate: async (invocation, signal) => {
      signal.throwIfAborted()
      if (!ports.supportsDeferredInvocations)
        throw new Error('Pinned Loop does not drain deferred invocations')
      const value = await state(),
        record = Object.values(value.actions).find((item) => item.receipt.invocationId === invocation.id)
      if (
        !record?.invocation ||
        !unfinished(record) ||
        jcs({ ...record.invocation, sourceSeq: record.receivedSeq }) !== jcs(invocation)
      )
        throw new Error('UI invocation is not bound to its durable request')
      const surface = value.surfaces[record.request.surfaceId]
      if (
        !surface ||
        surface.taskId !== record.taskId ||
        surface.updatedSeq !== record.surfaceSeq ||
        surface.status !== 'open' ||
        surface.surface.revision !== record.request.revision ||
        jcs(bindArguments(surface.surface, record.request, ports)) !== jcs(invocation.args)
      )
        throw new Error('UI invocation validation is stale')
    },
    changed,
  }
}
