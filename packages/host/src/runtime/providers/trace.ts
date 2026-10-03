import { createHash } from 'node:crypto'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { openTraceQueue, TraceConflict } from '../trace/export-queue.js'
import {
  inline,
  type ManagedOutbound,
  providerFactory,
  read,
  refused,
  send,
  wait,
} from '../trace/provider-support.js'

/** Trusted assembly inputs. Session consent is obtained from the owning authority, never the request. */
export type TraceDeployment = {
  path: string
  packageDigest: string
  configSchema: W.SchemaRef
  capacity?: number
  consent(context: CallContext): Promise<Outcome<W.TelemetryConsent>>
  authorize(
    context: CallContext,
    method: 'record' | 'export',
    input: W.TraceRecordRequest | W.TelemetryExportRequest,
  ): Promise<boolean>
  trajectory?: {
    schema: W.SchemaRef
    validate(value: W.JsonValue): boolean
    anonymize(value: W.JsonValue): W.JsonValue
  }
  attributeSchema: W.SchemaRef
  validateAttributes(value: W.JsonValue): boolean
  outbound: ManagedOutbound
  /** Only a host-verified external receipt may resolve an already pending export. */
  lookup(
    id: string,
    request: W.TelemetryExportRequest,
    context: ActionContext,
  ): Promise<Outcome<W.ReceiptPointer | null>>
}
function anonymousTrajectory(value: W.JsonValue): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true
  if (Array.isArray(value)) return value.every(anonymousTrajectory)
  return (
    typeof value === 'object' &&
    Object.entries(value).every(
      ([key, item]) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) && anonymousTrajectory(item),
    )
  )
}
export function createTraceFactory(deployment: TraceDeployment) {
  deployment = {
    ...deployment,
    outbound: { ...deployment.outbound, target: structuredClone(deployment.outbound.target) },
  }
  const refs = RuntimeMethodSchemaRefs['agh.trace']
  return providerFactory('agh.trace', deployment.packageDigest, deployment.configSchema, () => {
    const queue = openTraceQueue(deployment.path, deployment.capacity)
    let tail: Promise<unknown> = Promise.resolve()
    async function permit(
      call: CallContext,
      method: 'record' | 'export',
      input: W.TraceRecordRequest | W.TelemetryExportRequest,
    ) {
      if (!(await wait(deployment.authorize(call, method, input), call)) || call.signal.aborted)
        return refused('denied', 'permission_absent')
      const c = await wait(deployment.consent(call), call)
      if (!c.ok) return c
      try {
        return { ok: true as const, value: queue.freeze(c.value) }
      } catch (e) {
        return refused(e instanceof TraceConflict ? 'conflict' : 'denied', 'telemetry_consent')
      }
    }
    async function exportBatch(
      frame: W.ActionFrame,
      context: ActionContext,
      lookupOnly: boolean,
    ): Promise<Outcome<W.DataRef>> {
      const decoded = read<W.TelemetryExportRequest>(frame.input, refs.export.input, 'TelemetryExportRequest')
      if (!decoded.ok) return decoded
      const request = decoded.value,
        grant = await permit(context.call, 'export', request)
      if (!grant.ok) return grant
      const consent = grant.value
      if (
        jcs(consent) !== jcs(request.consent) ||
        !['ANON', 'FULL'].includes(consent.level) ||
        request.targetRef !== deployment.outbound.target.targetId
      )
        return refused('denied', 'telemetry_consent')
      // Opaque bytes and arbitrary user content never acquire an ANON export permission.
      let payload: unknown
      if (request.kind === 'trajectory') {
        const codec = deployment.trajectory
        if (
          !codec ||
          request.body.kind !== 'inline' ||
          jcs(request.body.schema) !== jcs(codec.schema) ||
          request.body.digest !== canonicalJsonDigest(request.body.value) ||
          request.body.bytes !== Buffer.byteLength(jcs(request.body.value)) ||
          !codec.validate(request.body.value)
        )
          return refused('denied', 'telemetry_body')
        const projected = consent.level === 'ANON' ? codec.anonymize(request.body.value) : request.body.value
        if (!codec.validate(projected) || (consent.level === 'ANON' && !anonymousTrajectory(projected)))
          return refused('denied', 'telemetry_body')
        inline(codec.schema, projected)
        payload = projected
      } else {
        const body = read<W.TraceRecordRequest>(request.body, refs.record.input, 'TraceRecordRequest')
        if (!body.ok || body.value.batchId !== request.batchId)
          return refused('invalid_input', 'telemetry_body')
        const projection: W.TraceSpan[] = []
        for (const span of body.value.spans) {
          const attributes = span.attributes
          if (
            attributes.kind !== 'inline' ||
            attributes.digest !== canonicalJsonDigest(attributes.value) ||
            attributes.bytes !== Buffer.byteLength(jcs(attributes.value)) ||
            jcs(attributes.schema) !== jcs(deployment.attributeSchema) ||
            !deployment.validateAttributes(attributes.value)
          )
            return refused('denied', 'trace_attributes')
          if (Date.parse(span.endedAt) < Date.parse(span.startedAt))
            return refused('invalid_input', 'trace_time')
          projection.push(
            consent.level === 'ANON'
              ? {
                  ...span,
                  traceId: canonicalJsonDigest(span.traceId).slice(0, 32),
                  spanId: canonicalJsonDigest(span.spanId).slice(0, 16),
                  parentSpanId: null,
                  name: 'runtime.span',
                  attributes: inline(deployment.attributeSchema, {}),
                }
              : span,
          )
        }
        payload = {
          resourceSpans: [
            {
              scopeSpans: [
                {
                  scope: { name: 'agnes.runtime' },
                  spans: projection.map((s) => ({
                    traceId: canonicalJsonDigest(s.traceId).slice(0, 32),
                    spanId: canonicalJsonDigest(s.spanId).slice(0, 16),
                    ...(s.parentSpanId === null
                      ? {}
                      : { parentSpanId: canonicalJsonDigest(s.parentSpanId).slice(0, 16) }),
                    name: s.name,
                    startTimeUnixNano: String(BigInt(Date.parse(s.startedAt)) * 1000000n),
                    endTimeUnixNano: String(BigInt(Date.parse(s.endedAt)) * 1000000n),
                    attributes:
                      s.attributes.kind === 'inline' &&
                      s.attributes.value !== null &&
                      typeof s.attributes.value === 'object' &&
                      !Array.isArray(s.attributes.value)
                        ? Object.entries(s.attributes.value).map(([key, value]) => ({
                            key,
                            value: { stringValue: typeof value === 'string' ? value : jcs(value) },
                          }))
                        : [],
                    status: { code: s.outcome === 'ok' ? 1 : s.outcome === 'unknown' ? 0 : 2 },
                  })),
                },
              ],
            },
          ],
        }
      }
      const id = canonicalJsonDigest({
          scope: context.call.scope,
          session: consent.sessionId,
          batch: request.batchId,
        }),
        fingerprint = canonicalJsonDigest(request),
        contentDigest = createHash('sha256').update(jcs(payload)).digest('hex')
      let entered = false
      try {
        const intent = queue.prepare(id, fingerprint, payload)
        const now = await permit(context.call, 'export', request)
        if (!now.ok) return now
        if (intent.result) return { ok: true, value: inline(refs.export.output, intent.result) }
        entered = true
        let pointer: W.ReceiptPointer | null = null
        if (intent.created && !lookupOnly) {
          const output = await send(deployment.outbound, payload, context)
          if (!output.ok || output.value.status < 200 || output.value.status >= 300)
            return refused('unknown_effect', 'effect_unknown')
          pointer = { authorityId: 'trace-egress', receiptId: id, digest: canonicalJsonDigest(output.value) }
        } else {
          const proof = await wait(deployment.lookup(id, request, context), context.call)
          if (proof.ok) pointer = proof.value
        }
        if (!pointer || !validateRuntime('ReceiptPointer', pointer).ok)
          return refused('unknown_effect', 'effect_unknown')
        const prev = queue.chain(consent.sessionId)?.chain ?? null,
          receipt = {
            sha256: contentDigest,
            bytes: Buffer.byteLength(jcs(payload)),
            consent: consent.level,
            prev,
            chain: createHash('sha256')
              .update((prev ?? '') + contentDigest)
              .digest('hex'),
            networkReceipt: pointer,
            sourceDigest: consent.sourceDigest,
            targetRef: request.targetRef,
          }
        const result: W.TelemetryExportResult = {
          batchId: request.batchId,
          state: 'sent',
          receiptRef: pointer,
          contentDigest,
          diagnosticId: null,
        }
        queue.complete(id, consent.sessionId, result, receipt)
        return { ok: true, value: inline(refs.export.output, result) }
      } catch (e) {
        return refused(
          entered ? 'unknown_effect' : e instanceof TraceConflict ? 'conflict' : 'internal',
          entered ? 'effect_unknown' : 'idempotency_conflict',
        )
      }
    }
    return {
      async observe(operation: W.ServiceOperation, call: CallContext): Promise<Outcome<W.DataRef>> {
        const decoded = read<W.TraceRecordRequest>(operation.input, refs.record.input, 'TraceRecordRequest')
        if (!decoded.ok) return decoded
        const permission = await permit(call, 'record', decoded.value)
        if (!permission.ok) return permission
        for (const s of decoded.value.spans)
          if (
            s.attributes.kind !== 'inline' ||
            s.attributes.digest !== canonicalJsonDigest(s.attributes.value) ||
            s.attributes.bytes !== Buffer.byteLength(jcs(s.attributes.value)) ||
            jcs(s.attributes.schema) !== jcs(deployment.attributeSchema) ||
            !deployment.validateAttributes(s.attributes.value)
          )
            return refused('denied', 'trace_attributes')
        try {
          return {
            ok: true,
            value: inline(
              refs.record.output,
              queue.record(permission.value.sessionId, decoded.value, permission.value.level === 'DISABLED'),
            ),
          }
        } catch (e) {
          return refused(
            e instanceof TraceConflict ? 'conflict' : e instanceof RangeError ? 'quota' : 'internal',
            'trace_queue',
          )
        }
      },
      execute(frame: W.ActionFrame, context: ActionContext, lookupOnly: boolean) {
        const task = tail.then(() => exportBatch(frame, context, lookupOnly))
        tail = task.catch(() => {})
        return task
      },
      pending: () => queue.pending(),
      close: () => queue.close(),
    }
  })
}
