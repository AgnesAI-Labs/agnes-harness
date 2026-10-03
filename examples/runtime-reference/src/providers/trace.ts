import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as R from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  cabinet,
  deliver,
  type RemotePort,
  referenceFactory,
  rejection,
  serial,
  unserial,
  until,
} from './billing-trace-runtime.js'

export interface ReferenceTraceDeployment {
  readonly path: string
  readonly packageDigest: string
  readonly configSchema: R.SchemaRef
  readonly capacity?: number
  consent(call: CallContext): Promise<Outcome<R.TelemetryConsent>>
  authorize(
    call: CallContext,
    method: 'record' | 'export',
    input: R.TraceRecordRequest | R.TelemetryExportRequest,
  ): Promise<boolean>
  readonly trajectory?: {
    schema: R.SchemaRef
    validate(value: R.JsonValue): boolean
    anonymize(value: R.JsonValue): R.JsonValue
  }
  readonly attributeSchema: R.SchemaRef
  validateAttributes(value: R.JsonValue): boolean
  readonly outbound: RemotePort
  lookup(
    id: string,
    input: R.TelemetryExportRequest,
    action: ActionContext,
  ): Promise<Outcome<R.ReceiptPointer | null>>
}
type TraceDocument = {
  consents: R.TelemetryConsent[]
  batches: {
    id: string
    owner: string
    fingerprint: string
    spans: R.TraceSpan[]
    result: R.TraceRecordResult
  }[]
  exports: { id: string; fingerprint: string; result: R.TelemetryExportResult | null }[]
  chains: Record<
    string,
    {
      chain: string
      sha256: string
      bytes: number
      consent: string
      prev: string | null
      networkReceipt: R.ReceiptPointer
      sourceDigest: string
      targetRef: string
    }
  >
}
function safeAnonymousTree(root: R.JsonValue): boolean {
  const remaining: R.JsonValue[] = [root]
  while (remaining.length) {
    const node = remaining.pop()
    if (typeof node === 'string') return false
    if (Array.isArray(node)) remaining.push(...node)
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) return false
        remaining.push(value)
      }
    }
  }
  return true
}
export function createReferenceTraceFactory(d: ReferenceTraceDeployment) {
  d = { ...d, outbound: { ...d.outbound, target: structuredClone(d.outbound.target) } }
  const schemas = RuntimeMethodSchemaRefs['agh.trace'],
    maximum = d.capacity ?? 256
  if (maximum < 1 || maximum > 1024 || !Number.isSafeInteger(maximum))
    throw new RangeError('invalid trace capacity')
  return referenceFactory('agh.trace', d.packageDigest, d.configSchema, () => {
    const storage = cabinet<TraceDocument>(d.path, { consents: [], batches: [], exports: [], chains: {} })
    let ordered: Promise<unknown> = Promise.resolve()
    async function consent(
      call: CallContext,
      method: 'record' | 'export',
      input: R.TraceRecordRequest | R.TelemetryExportRequest,
    ): Promise<Outcome<R.TelemetryConsent>> {
      if (call.signal.aborted || !(await until(d.authorize(call, method, input), call)))
        return rejection('denied', 'permission_absent')
      const response = await until(d.consent(call), call)
      if (!response.ok) return response
      if (!validateRuntime('TelemetryConsent', response.value).ok)
        return rejection('denied', 'telemetry_consent')
      let conflict = false
      storage.change((doc) => {
        const old = doc.consents.find((c) => c.sessionId === response.value.sessionId)
        if (old) conflict = jcs(old) !== jcs(response.value)
        else doc.consents.push(response.value)
      })
      return conflict ? rejection('conflict', 'telemetry_consent') : response
    }
    function permittedSpan(span: R.TraceSpan): boolean {
      try {
        return (
          jcs(span.attributes.schema) === jcs(d.attributeSchema) &&
          d.validateAttributes(unserial<R.JsonValue>(span.attributes, d.attributeSchema, 'JsonValue'))
        )
      } catch {
        return false
      }
    }
    async function act(
      frame: R.ActionFrame,
      ctx: ActionContext,
      probe: boolean,
    ): Promise<Outcome<R.DataRef>> {
      const input = unserial<R.TelemetryExportRequest>(
          frame.input,
          schemas.export.input,
          'TelemetryExportRequest',
        ),
        grant = await consent(ctx.call, 'export', input)
      if (!grant.ok) return grant
      if (
        jcs(grant.value) !== jcs(input.consent) ||
        !['FULL', 'ANON'].includes(grant.value.level) ||
        d.outbound.target.targetId !== input.targetRef
      )
        return rejection('denied', 'telemetry_consent')
      let packet: unknown
      if (input.kind === 'trajectory') {
        const codec = d.trajectory
        if (
          !codec ||
          input.body.kind !== 'inline' ||
          jcs(input.body.schema) !== jcs(codec.schema) ||
          input.body.digest !== canonicalJsonDigest(input.body.value) ||
          input.body.bytes !== Buffer.byteLength(jcs(input.body.value)) ||
          !codec.validate(input.body.value)
        )
          return rejection('denied', 'telemetry_body')
        const value = grant.value.level === 'ANON' ? codec.anonymize(input.body.value) : input.body.value
        if (!codec.validate(value) || (grant.value.level === 'ANON' && !safeAnonymousTree(value)))
          return rejection('denied', 'telemetry_body')
        serial(codec.schema, value)
        packet = value
      } else {
        let batch: R.TraceRecordRequest
        try {
          batch = unserial<R.TraceRecordRequest>(input.body, schemas.record.input, 'TraceRecordRequest')
        } catch {
          return rejection('invalid_input', 'telemetry_body')
        }
        if (batch.batchId !== input.batchId) return rejection('invalid_input', 'telemetry_body')
        if (batch.spans.some((s) => !permittedSpan(s))) return rejection('denied', 'trace_attributes')
        if (batch.spans.some((s) => Date.parse(s.endedAt) < Date.parse(s.startedAt)))
          return rejection('invalid_input', 'trace_time')
        const spans = batch.spans.map((original) => {
          const s =
            grant.value.level === 'ANON'
              ? {
                  ...original,
                  name: 'runtime.span',
                  traceId: canonicalJsonDigest(original.traceId).substring(0, 32),
                  spanId: canonicalJsonDigest(original.spanId).substring(0, 16),
                  parentSpanId: null,
                  attributes: serial(d.attributeSchema, {}),
                }
              : original
          const dictionary =
            s.attributes.kind === 'inline' &&
            s.attributes.value &&
            typeof s.attributes.value === 'object' &&
            !Array.isArray(s.attributes.value)
              ? s.attributes.value
              : {}
          return {
            name: s.name,
            traceId: canonicalJsonDigest(s.traceId).substring(0, 32),
            spanId: canonicalJsonDigest(s.spanId).substring(0, 16),
            ...(s.parentSpanId !== null
              ? { parentSpanId: canonicalJsonDigest(s.parentSpanId).substring(0, 16) }
              : {}),
            startTimeUnixNano: (BigInt(Date.parse(s.startedAt)) * 1000000n).toString(),
            endTimeUnixNano: (BigInt(Date.parse(s.endedAt)) * 1000000n).toString(),
            status: { code: s.outcome === 'ok' ? 1 : s.outcome === 'unknown' ? 0 : 2 },
            attributes: Object.entries(dictionary).map(([k, v]) => ({
              key: k,
              value: { stringValue: typeof v === 'string' ? v : jcs(v) },
            })),
          }
        })
        packet = { resourceSpans: [{ scopeSpans: [{ scope: { name: 'agnes.runtime' }, spans }] }] }
      }
      const contentDigest = createHash('sha256').update(jcs(packet)).digest('hex')
      const identifier = canonicalJsonDigest({
          scope: ctx.call.scope,
          session: grant.value.sessionId,
          batch: input.batchId,
        }),
        signature = canonicalJsonDigest(input)
      let fresh = false,
        mismatch = false
      const original = storage.change((doc) => {
        const match = doc.exports.find((e) => e.id === identifier)
        if (match) {
          mismatch = match.fingerprint !== signature
          return match.result
        }
        fresh = true
        doc.exports.push({ id: identifier, fingerprint: signature, result: null })
        return null
      })
      if (mismatch) return rejection('conflict', 'idempotency_conflict')
      const check = await consent(ctx.call, 'export', input)
      if (!check.ok) return check
      if (original) return { ok: true, value: serial(schemas.export.output, original) }
      try {
        let proof: R.ReceiptPointer | null = null
        if (fresh && !probe) {
          const sent = await deliver(d.outbound, packet, ctx)
          if (sent.ok && sent.value.status >= 200 && sent.value.status < 300)
            proof = {
              receiptId: identifier,
              authorityId: 'trace-egress',
              digest: canonicalJsonDigest(sent.value),
            }
        } else {
          const found = await until(d.lookup(identifier, input, ctx), ctx.call)
          if (found.ok) proof = found.value
        }
        if (proof === null || !validateRuntime('ReceiptPointer', proof).ok)
          return rejection('unknown_effect', 'effect_unknown')
        const receiptProof = proof
        const output: R.TelemetryExportResult = {
          contentDigest,
          batchId: input.batchId,
          receiptRef: proof,
          diagnosticId: null,
          state: 'sent',
        }
        storage.change((doc) => {
          const pending = doc.exports.find((e) => e.id === identifier)
          if (!pending) throw new Error('export disappeared')
          pending.result = output
          const prev = doc.chains[grant.value.sessionId]?.chain ?? null
          doc.chains[grant.value.sessionId] = {
            chain: createHash('sha256')
              .update((prev ?? '') + contentDigest)
              .digest('hex'),
            sha256: contentDigest,
            bytes: Buffer.byteLength(jcs(packet)),
            consent: grant.value.level,
            prev,
            networkReceipt: receiptProof,
            sourceDigest: grant.value.sourceDigest,
            targetRef: input.targetRef,
          }
        })
        return { ok: true, value: serial(schemas.export.output, output) }
      } catch {
        return rejection('unknown_effect', 'effect_unknown')
      }
    }
    return {
      async record(operation: R.ServiceOperation, call: CallContext): Promise<Outcome<R.DataRef>> {
        const batch = unserial<R.TraceRecordRequest>(
            operation.input,
            schemas.record.input,
            'TraceRecordRequest',
          ),
          permission = await consent(call, 'record', batch)
        if (!permission.ok) return permission
        if (batch.spans.some((s) => !permittedSpan(s))) return rejection('denied', 'trace_attributes')
        return storage.change((doc) => {
          const identifier = canonicalJsonDigest({ owner: permission.value.sessionId, batch: batch.batchId }),
            hash = canonicalJsonDigest(batch),
            old = doc.batches.find((b) => b.id === identifier)
          if (old)
            return old.fingerprint === hash
              ? { ok: true, value: serial(schemas.record.output, old.result) }
              : rejection('conflict', 'trace_queue')
          if (doc.batches.length === maximum) return rejection('quota', 'trace_queue')
          const room = maximum - doc.batches.reduce((n, b) => n + b.spans.length, 0),
            n = permission.value.level === 'DISABLED' ? 0 : Math.min(room, batch.spans.length)
          const result = { accepted: n, dropped: batch.spans.length - n }
          doc.batches.push({
            id: identifier,
            owner: permission.value.sessionId,
            fingerprint: hash,
            spans: batch.spans.slice(0, n),
            result,
          })
          return { ok: true, value: serial(schemas.record.output, result) }
        })
      },
      act(frame: R.ActionFrame, ctx: ActionContext, probe: boolean) {
        const task = ordered.then(() => act(frame, ctx, probe))
        ordered = task.catch(() => {})
        return task
      },
      owners: () =>
        storage
          .view()
          .exports.filter((e) => e.result === null)
          .map((e) => e.id),
      finish: () => storage.close(),
    }
  })
}

/** Owner-only diagnostics; this is not a new public Q method or an export action. */
export function inspectReferenceTrace(path: string, owner: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const document = JSON.parse(
      String(database.prepare('SELECT value FROM cabinet WHERE slot=1').get()?.value),
    ) as TraceDocument
    let accepted = 0,
      dropped = 0,
      cursor = 0
    const pages: { cursor: number; spans: R.TraceSpan[] }[] = []
    document.batches.forEach((batch, index) => {
      if (batch.owner === owner) {
        accepted += batch.result.accepted
        dropped += batch.result.dropped
        cursor = index + 1
        pages.push({ cursor, spans: batch.spans })
      }
    })
    return { stats: { accepted, dropped, cursor, replayFrom: 0 }, pages, chains: document.chains }
  } finally {
    database.close()
  }
}
