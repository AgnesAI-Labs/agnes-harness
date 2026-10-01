import { createHash } from 'node:crypto'
import type {
  ActionContext,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type ActionFrame,
  type AuditAppend,
  type AuditExportRequest,
  type BindingRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  type ProviderDescriptor,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  type SchemaRef,
  type ScopeRef,
  validateRuntime,
} from '@agnes/protocol/runtime'

import { AuditConflict, type AuditStore, type AuditWrite } from './audit-store.js'

export type AuditAuthorization = {
  readonly producer: BindingRef
  readonly scope: ScopeRef
  readonly authorityId: string
}
/** Trusted deployment ports; none are exposed to ordinary BoundService consumers. */
export type AuditDeployment = {
  readonly store: AuditStore
  readonly config: AuthorSchema<EmptyAuthorConfig>
  readonly packageDigest: string
  readonly payloadCodecs: readonly { readonly ref: SchemaRef; parse(value: unknown): Outcome<JsonValue> }[]
  authorize(
    context: CallContext,
    operation: 'append' | 'export',
    input: AuditAppend | AuditExportRequest,
  ): Promise<Outcome<AuditAuthorization>>
  resolvePayload(ref: DataRef, context: CallContext): Promise<Outcome<JsonValue>>
  sendArchive(
    id: string,
    target: string,
    records: readonly AuditAppend[],
    context: ActionContext,
  ): Promise<Outcome<DataRef>>
  reconcileArchive(id: string, target: string, context: ActionContext): Promise<Outcome<DataRef | null>>
}

const refs = RuntimeMethodSchemaRefs['agh.audit']
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const same = (a: unknown, b: unknown) => jcs(a) === jcs(b)
const fail = (code: RuntimeError['code'], detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Audit request refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'audit-provider',
  },
})
function within(parent: ScopeRef, child: ScopeRef): boolean {
  const levels = ['installation', 'runtime', 'workspace', 'session', 'run', 'action']
  return (
    levels.indexOf(child.kind) >= levels.indexOf(parent.kind) &&
    Object.entries(parent).every(
      ([key, value]) => key === 'kind' || (child as unknown as Record<string, unknown>)[key] === value,
    )
  )
}
function bounded<T>(invoke: () => Promise<T>, context: CallContext): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const remaining = Date.parse(context.deadline) - Date.now()
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value as T)
    }
    const abort = () => finish(new Error('audit invocation cancelled'))
    const timer = setTimeout(
      () => finish(new Error('audit invocation deadline')),
      Math.max(0, Math.min(remaining, 2147483647)),
    )
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted || remaining <= 0 || !Number.isFinite(remaining)) {
      abort()
      return
    }
    Promise.resolve()
      .then(() => {
        if (settled) throw new Error('audit invocation cancelled')
        return invoke()
      })
      .then(
        (value) => finish(null, value),
        (error) => finish(error),
      )
  })
}
function decode<T>(ref: DataRef, schema: SchemaRef, name: Parameters<typeof validateRuntime>[0]): Outcome<T> {
  const safe = boundedCanonicalJson(ref, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES + 4096,
    maxDepth: 128,
    maxMembers: 10000,
  })
  if (!safe.ok || !validateRuntime('DataRef', safe.value.json).ok) return fail('invalid_input', 'audit_input')
  ref = safe.value.json as DataRef
  if (
    ref.kind !== 'inline' ||
    ref.bytes > MAX_AUTHOR_INLINE_BYTES ||
    !same(ref.schema, schema) ||
    canonicalJsonDigest(ref.value) !== ref.digest ||
    Buffer.byteLength(jcs(ref.value)) !== ref.bytes
  )
    return fail('invalid_input', 'audit_input')
  const checked = validateRuntime(name, ref.value)
  return checked.ok ? { ok: true, value: checked.value as T } : fail('invalid_input', 'audit_input')
}
function encode(schema: SchemaRef, value: JsonValue): DataRef {
  return {
    kind: 'inline',
    schema,
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(jcs(value)),
  }
}
export function auditWrite(input: AuditAppend, grant: AuditAuthorization): AuditWrite {
  const scopeKey = jcs(grant.scope)
  const identity = digest({
    producer: grant.producer,
    scope: grant.scope,
    authorityId: grant.authorityId,
    causationRef: input.causationRef,
    subjectRef: input.subjectRef,
    operation: input.operation,
    outcomeRef: input.outcomeRef,
  })
  return { identity, scopeKey, fingerprint: digest(input), input }
}

export function createReferenceAuditFactory(deployment: AuditDeployment): ProviderFactory<ServiceProvider> {
  const descriptor: ProviderDescriptor = {
    providerId: 'agh.reference/audit',
    contract: 'agh.audit',
    major: 1,
    logicalName: 'reference',
    packageVersion: '1.0.0',
    packageDigest: deployment.packageDigest,
    features: [],
    scope: 'workspace',
    configSchema: deployment.config.ref,
    requires: [],
    capabilities: [],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'append',
        kind: 'control',
        inputSchema: refs.append.input,
        outputSchema: refs.append.output,
        requiredCapabilities: [],
        retrySafety: 'idempotent',
      },
      {
        method: 'export',
        kind: 'action',
        inputSchema: refs.export.input,
        outputSchema: refs.export.output,
        requiredCapabilities: [],
        retrySafety: 'reconcile-first',
      },
    ],
  }
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      if (
        !same(descriptor.configSchema, deployment.config.ref) ||
        config.kind !== 'inline' ||
        !same(config.schema, deployment.config.ref) ||
        canonicalJsonDigest(config.value) !== config.digest ||
        Buffer.byteLength(jcs(config.value)) !== config.bytes ||
        !deployment.config.parse(config.value).ok
      )
        throw new TypeError('invalid audit configuration')
      return createReferenceAuditProvider(deployment, factory, descriptor)
    },
  }
}

function createReferenceAuditProvider(
  deployment: AuditDeployment,
  factory: FactoryContext,
  descriptor: ProviderDescriptor,
): ServiceProvider {
  let closed = false,
    draining = false
  const active = new Set<string>()
  const available = (context: CallContext): Outcome<true> => {
    if (factory.signal.aborted || context.signal.aborted) return fail('cancelled', 'audit_cancelled')
    if (closed || draining) return fail('denied', 'blocked')
    if (context.bindingId !== factory.bindingId || !within(factory.scope, context.scope))
      return fail('denied', 'permission_absent')
    if (!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= Date.now())
      return fail('timeout', 'deadline')
    return { ok: true, value: true }
  }
  const authorized = async (
    context: CallContext,
    op: 'append' | 'export',
    input: AuditAppend | AuditExportRequest,
  ): Promise<Outcome<AuditAuthorization>> => {
    const gate = available(context)
    if (!gate.ok) return gate
    const grant = await bounded(() => deployment.authorize(context, op, input), context)
    if (!grant.ok) return grant
    if (
      !validateRuntime('BindingRef', grant.value.producer).ok ||
      !validateRuntime('ScopeRef', grant.value.scope).ok ||
      !same(context.scope, grant.value.scope) ||
      !within(factory.scope, grant.value.scope) ||
      grant.value.authorityId !== deployment.store.authorityId
    )
      return fail('denied', 'permission_absent')
    const late = available(context)
    return late.ok ? grant : late
  }
  const payload = async (input: AuditAppend, context: CallContext): Promise<Outcome<true>> => {
    const codec = deployment.payloadCodecs.find((codec) => same(codec.ref, input.redactedPayloadRef.schema))
    if (!codec) return fail('denied', 'permission_absent')
    const value = await bounded(() => deployment.resolvePayload(input.redactedPayloadRef, context), context)
    if (!value.ok) return value
    const parsed = codec.parse(value.value)
    if (!parsed.ok) return parsed
    if (
      input.redactedPayloadRef.kind === 'inline' &&
      (canonicalJsonDigest(value.value) !== input.redactedPayloadRef.digest ||
        Buffer.byteLength(jcs(value.value)) !== input.redactedPayloadRef.bytes)
    )
      return fail('invalid_input', 'audit_payload')
    if (!same(value.value, redactAuditPayload(value.value))) return fail('denied', 'audit_unredacted_payload')
    return { ok: true, value: true }
  }
  const error = (caught: unknown) => {
    if (caught instanceof AuditConflict) return fail('conflict', 'idempotency_conflict')
    if (caught instanceof Error && caught.message === 'audit invocation deadline')
      return fail('timeout', 'deadline')
    if (caught instanceof Error && caught.message === 'audit invocation cancelled')
      return fail('cancelled', 'audit_cancelled')
    return fail('internal', 'audit_storage')
  }
  const exportAction = async (
    frame: ActionFrame,
    context: ActionContext,
    reconcile: boolean,
  ): Promise<EffectResult> => {
    const refused = (result: Outcome<never>): EffectResult => ({
      outcome: context.call.signal.aborted ? 'cancelled' : 'failed',
      ...(!result.ok ? { error: result.error } : {}),
      externalRequests: [],
      usage: [],
      references: [],
    })
    if (
      !validateRuntime('ActionFrame', frame).ok ||
      frame.method !== 'export' ||
      frame.bindingId !== factory.bindingId ||
      frame.invocationId !== context.call.invocationId ||
      !same(frame.context, {
        principalRef: context.call.principalRef,
        scope: context.call.scope,
        bindingId: context.call.bindingId,
        invocationId: context.call.invocationId,
        deadline: context.call.deadline,
        traceRef: context.call.traceRef,
        authorizationRef: context.call.authorizationRef,
      }) ||
      frame.inputDigest !== (frame.input.kind === 'inline' ? frame.input.digest : '')
    )
      return refused(fail('invalid_input', 'audit_input'))
    const parsed = decode<AuditExportRequest>(frame.input, refs.export.input, 'AuditExportRequest')
    if (!parsed.ok) return refused(parsed)
    if (parsed.value.limit < 1 || parsed.value.limit > 500) return refused(fail('quota', 'audit_page_limit'))
    const grant = await authorized(context.call, 'export', parsed.value)
    if (!grant.ok) return refused(grant)
    const cursor = parsed.value.cursor === null ? 0 : Number(parsed.value.cursor)
    if (!Number.isSafeInteger(cursor) || cursor < 0) return refused(fail('invalid_input', 'audit_cursor'))
    const id = digest({ binding: factory.bindingId, scope: factory.scope, actionId: frame.actionId })
    active.add(frame.invocationId)
    let sending = false
    const unknown = (): EffectResult => ({
      outcome: 'unknown_effect',
      error: {
        code: 'unknown_effect',
        detailCode: 'effect_unknown',
        message: 'Audit archive remains pending',
        retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'action', id: frame.actionId } },
        diagnosticId: 'audit-export',
      },
      externalRequests: [],
      usage: [],
      references: [],
    })
    try {
      const rows = deployment.store.page(jcs(grant.value.scope), cursor, parsed.value.limit)
      const records: AuditAppend[] = []
      for (const row of rows) {
        const checked = await payload(row.input, context.call)
        if (!checked.ok) return refused(checked)
        records.push(row.input)
      }
      const fingerprint = digest(parsed.value)
      const intent = deployment.store.prepareExport(id, fingerprint, {
        request: parsed.value,
        records,
        checkpoint: String(rows.at(-1)?.sequence ?? cursor),
      })
      const saved = JSON.parse(intent.body) as {
        request: AuditExportRequest
        records: AuditAppend[]
        checkpoint: string
      }
      for (const record of saved.records) {
        const permission = await payload(record, context.call)
        if (!permission.ok) return refused(permission)
      }
      const now = await authorized(context.call, 'export', parsed.value)
      if (!now.ok) return refused(now)
      if (intent.receipt !== null)
        return {
          outcome: 'succeeded',
          result: encode(refs.export.output, JSON.parse(intent.receipt)),
          externalRequests: [],
          usage: [],
          references: [],
        }
      // A persisted pending intent may already have been sent. Never automatically send it again.
      const first = intent.created && !reconcile
      sending = true
      const delivery = first
        ? await bounded(
            () => deployment.sendArchive(id, parsed.value.targetRef, saved.records, context),
            context.call,
          )
        : await bounded(() => deployment.reconcileArchive(id, parsed.value.targetRef, context), context.call)
      // An error result alone cannot prove that this durable intent was never sent.
      if (!delivery.ok) return unknown()
      if (delivery.value === null)
        return {
          outcome: 'unknown_effect',
          error: {
            code: 'unknown_effect',
            detailCode: 'effect_unknown',
            message: 'Audit archive remains pending',
            retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'action', id: frame.actionId } },
            diagnosticId: 'audit-export',
          },
          externalRequests: [],
          usage: [],
          references: [],
        }
      if (
        !validateRuntime('DataRef', delivery.value).ok ||
        (delivery.value.kind === 'inline' &&
          (!same(delivery.value.value, redactAuditPayload(delivery.value.value)) ||
            canonicalJsonDigest(delivery.value.value) !== delivery.value.digest ||
            Buffer.byteLength(jcs(delivery.value.value)) !== delivery.value.bytes))
      )
        throw new Error('invalid audit archive receipt')
      const result = { checkpoint: saved.checkpoint, archiveReceipt: delivery.value }
      deployment.store.completeExport(id, fingerprint, result)
      return {
        outcome: 'succeeded',
        result: encode(refs.export.output, result),
        externalRequests: [],
        usage: [],
        references: [],
      }
    } catch (caught) {
      return sending ? unknown() : refused(error(caught))
    } finally {
      active.delete(frame.invocationId)
      if (closed && active.size === 0) deployment.store.close()
    }
  }
  const lifecycle = {
    async ready(context: CallContext): Promise<Outcome<void>> {
      const gate = available(context)
      return gate.ok ? { ok: true, value: undefined } : gate
    },
    async health(context: CallContext): Promise<Outcome<import('@agnes/protocol/runtime').Health>> {
      const gate = available(context)
      return gate.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : gate
    },
    async drain(
      _deadline: string,
      _context: CallContext,
    ): Promise<Outcome<import('@agnes/protocol/runtime').DrainResult>> {
      draining = true
      return {
        ok: true,
        value: {
          state: active.size || deployment.store.pendingOwnerIds().length ? 'blocked' : 'drained',
          activeInvocationIds: [...active],
          durableOwnerRefs: deployment.store
            .pendingOwnerIds()
            .map((id) => ({ kind: 'reconciliation' as const, id })),
          diagnosticIds: [],
        },
      }
    },
    async close() {
      closed = true
      if (active.size === 0) deployment.store.close()
    },
  }
  return {
    ...lifecycle,
    async control(request, context) {
      if (
        request.method !== 'append' ||
        request.target.bindingId !== factory.bindingId ||
        request.target.providerId !== descriptor.providerId ||
        request.target.contract !== 'agh.audit' ||
        request.target.logicalName !== descriptor.logicalName
      )
        return fail('invalid_input', 'audit_operation')
      const input = decode<AuditAppend>(request.input, refs.append.input, 'AuditAppend')
      if (!input.ok) return input
      active.add(context.invocationId)
      try {
        const grant = await authorized(context, 'append', input.value)
        if (!grant.ok) return grant
        const read = await payload(input.value, context)
        if (!read.ok) return read
        const latest = await authorized(context, 'append', input.value)
        if (!latest.ok) return latest
        const auditRef = deployment.store.append(auditWrite(input.value, latest.value))
        return { ok: true, value: encode(refs.append.output, { auditRef }) }
      } catch (caught) {
        return error(caught)
      } finally {
        active.delete(context.invocationId)
        if (closed && active.size === 0) deployment.store.close()
      }
    },
    actions: {
      export: {
        kind: 'leaf',
        recovery: 'R2',
        stateCodec: null,
        async create(scope) {
          if (scope.bindingId !== factory.bindingId || !within(factory.scope, scope.scope))
            throw new TypeError('audit action scope mismatch')
          let actionClosed = false
          return {
            ...lifecycle,
            close: async () => {
              actionClosed = true
            },
            kind: 'leaf',
            effectSemantics: 'receipt-query',
            executionUnit: 'single-effect',
            execute: async (frame, context): Promise<EffectResult> => {
              if (
                actionClosed ||
                scope.signal.aborted ||
                frame.actionId !== scope.actionId ||
                frame.runId !== scope.runId
              ) {
                const error = fail('denied', 'blocked')
                return {
                  outcome: 'failed',
                  ...(!error.ok ? { error: error.error } : {}),
                  externalRequests: [],
                  usage: [],
                  references: [],
                }
              }
              return exportAction(frame, context, false)
            },
            reconcile: async (frame, _evidence, context) => {
              if (
                actionClosed ||
                scope.signal.aborted ||
                frame.actionId !== scope.actionId ||
                frame.runId !== scope.runId ||
                !validateRuntime('ActionFrame', frame).ok ||
                frame.method !== 'export' ||
                frame.bindingId !== factory.bindingId ||
                frame.invocationId !== context.call.invocationId ||
                !same(frame.context, {
                  principalRef: context.call.principalRef,
                  scope: context.call.scope,
                  bindingId: context.call.bindingId,
                  invocationId: context.call.invocationId,
                  deadline: context.call.deadline,
                  traceRef: context.call.traceRef,
                  authorizationRef: context.call.authorizationRef,
                }) ||
                frame.input.kind !== 'inline' ||
                frame.inputDigest !== frame.input.digest
              )
                return {
                  kind: 'unknown',
                  evidence: encode(refs.export.output, { checkpoint: '0', archiveReceipt: null }),
                  reason: 'Audit reconcile frame refused',
                }

              const parsed = decode<AuditExportRequest>(frame.input, refs.export.input, 'AuditExportRequest')
              if (!parsed.ok)
                return {
                  kind: 'unknown',
                  evidence: encode(refs.export.output, { checkpoint: '0', archiveReceipt: null }),
                  reason: 'Audit reconcile request refused',
                }
              const grant = await authorized(context.call, 'export', parsed.value)
              if (!grant.ok)
                return {
                  kind: 'unknown',
                  evidence: encode(refs.export.output, { checkpoint: '0', archiveReceipt: null }),
                  reason: 'Audit reconcile authorization refused',
                }
              const identity = digest({
                binding: factory.bindingId,
                scope: factory.scope,
                actionId: frame.actionId,
              })
              if (!deployment.store.readExport(identity))
                return {
                  kind: 'not_found',
                  evidence: encode(refs.export.output, { checkpoint: '0', archiveReceipt: null }),
                  safeToRetry: true,
                }
              const result = await exportAction(frame, context, true)
              return result.outcome === 'succeeded' && result.result
                ? { kind: 'resolved', evidence: result.result, result }
                : {
                    kind: 'unknown',
                    evidence: encode(refs.export.output, { checkpoint: '0', archiveReceipt: null }),
                    reason: 'Audit archive remains unresolved',
                  }
            },
          }
        },
      },
    },
  }
}

const sensitive = /credential|authorization|cookie|password|secret|token|signature|private.?key|oauth|claims/i
const secretText =
  /(?:bearer\s+\S+|secret:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|[?&](?:access_token|code|password)=)/i
/** Mandatory baseline. It also runs again at export; deployment redactors may only tighten it. */
function redactAuditPayload(value: JsonValue): JsonValue {
  if (typeof value === 'string') return secretText.test(value) ? '<redacted>' : value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactAuditPayload)
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitive.test(key) ? '<redacted>' : redactAuditPayload(child),
    ]),
  )
}
