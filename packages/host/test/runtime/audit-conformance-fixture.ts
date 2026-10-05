import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import type { AuditAppend, BindingRef, ScopeRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { openAuditStore } from '../../src/runtime/audit/store.js'

const scope: ScopeRef = {
  kind: 'workspace',
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
const producer: BindingRef = {
  bindingId: 'producer-binding',
  contract: 'agh.policy',
  logicalName: 'default',
  providerId: 'producer',
}
const payload = { safe: 'approved' }
const input: AuditAppend = {
  subjectRef: { kind: 'event', authorityId: 'source', eventId: 'subject' },
  operation: 'allow',
  outcomeRef: { authorityId: 'source', receiptId: 'outcome', digest: 'a'.repeat(64) },
  causationRef: { kind: 'event', authorityId: 'source', eventId: 'cause' },
  redactedPayloadRef: {
    kind: 'inline',
    schema: { typeId: 'example/payload@1', revision: 1, digest: 'b'.repeat(64) },
    value: payload,
    digest: canonicalJsonDigest(payload),
    bytes: Buffer.byteLength(jcs(payload)),
  },
}

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  type ActionContext,
  type CallContext,
  defineGeneratedAuthorSchema,
  type FactoryContext,
  type Outcome,
  runtimeAuthorSchemas,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import type { AuditContractDriver, AuditContractInstance } from '@agnes/extension-api/testkit'
import {
  type ActionFrame,
  type DataRef,
  type JsonValue,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
} from '@agnes/protocol/runtime'
import { createReferenceAuditFactory } from '../../../../examples/runtime-reference/src/providers/audit.js'
import { openReferenceAuditStore } from '../../../../examples/runtime-reference/src/providers/audit-store.js'
import { validateOwnedAuthorSchemaSource } from '../../../protocol/src/runtime/author-schema-source.js'
import { generateAuthorSchemaModule } from '../../../protocol/tools/gen-author-schema-types.js'
import { type AuditDeployment, createAuditFactory } from '../../src/runtime/providers/audit.js'

const rawConfig = JSON.parse(
  readFileSync(new URL('../../../protocol/schema/runtime/empty-config.schema.json', import.meta.url), 'utf8'),
)
const { $schema, $id: _id, ...shape } = rawConfig
const checkedConfig = validateOwnedAuthorSchemaSource({
  ownerPackageId: 'agnes-audit-fixture',
  name: 'AuditConfig',
  typeId: 'agnes-audit-fixture/config@1',
  revision: 1,
  document: {
    $schema,
    $ref: '#/$defs/AuditConfig',
    $defs: { AuditConfig: { ...shape, required: shape.required ?? [] } },
  },
})
const generatedText = generateAuthorSchemaModule('AuditConfig', checkedConfig.source, checkedConfig.document)
const configSource = JSON.parse(
  generatedText.match(/__createGeneratedSchema__<[^>]+>\((.+)\)/)?.[1] ?? 'null',
)
const configCodec = defineGeneratedAuthorSchema<Readonly<Record<string, never>>>(configSource)
const failure = (): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode: 'permission_absent',
    message: 'fixture denied',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'audit-fixture',
  },
})
const ref = (schema: DataRef['schema'], value: JsonValue): DataRef => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: Buffer.byteLength(jcs(value)),
})
const dependencies: ScopedDependencies = {
  get: failure,
  async openScope() {
    return failure()
  },
  async close() {},
}
const fixturePayload = { content: [], structured: { decision: 'allowed' } }
const safeInput: AuditAppend = {
  ...input,
  redactedPayloadRef: ref(RuntimeSchemaRefs.StandardToolOutput, fixturePayload),
}
type AuditTestOptions = {
  directory?: string
  retainOnClose?: boolean
  sendUnknown?: boolean
  denyExport?: boolean
  storageFailure?: boolean
  unredacted?: boolean
  hangPayload?: boolean
  revokeAfterPayload?: () => boolean
  sendReturnedFailure?: boolean
  reconcileReturnedFailure?: boolean
  hangSend?: boolean
}
export function auditContractDriver(reference: boolean, options: AuditTestOptions = {}): AuditContractDriver {
  const dir = options.directory ?? mkdtempSync(join(tmpdir(), 'audit-public-'))
  const remote = new DatabaseSync(join(dir, 'remote.db'))
  remote.exec(
    'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
  )
  let generation = 0
  let exportRevoked = false
  let deliveries = 0,
    store: ReturnType<typeof openAuditStore> | ReturnType<typeof openReferenceAuditStore> | undefined
  const trusted = new WeakSet<object>()
  const call = (): CallContext => {
    const context: CallContext = {
      principalRef: 'actor',
      scope,
      bindingId: 'audit-binding',
      invocationId: `invocation-${generation}`,
      deadline: new Date(Date.now() + (options.hangPayload || options.hangSend ? 250 : 60000)).toISOString(),
      traceRef: 'trace',
      authorizationRef: 'auth',
      signal: new AbortController().signal,
    }
    trusted.add(context)
    return context
  }
  async function open(): Promise<AuditContractInstance> {
    generation++
    store = reference
      ? openReferenceAuditStore(join(dir, 'owner.db'), 'audit-owner', (point) => {
          if (options.storageFailure && point === 'before-commit') throw new Error('disk full')
        })
      : openAuditStore(join(dir, 'owner.db'), 'audit-owner', (point) => {
          if (options.storageFailure && point === 'before-commit') throw new Error('disk full')
        })
    const grant = { scope, producer, authorityId: 'audit-owner' }
    const deployment: AuditDeployment = {
      store,
      config: configCodec,
      packageDigest: 'd'.repeat(64),
      payloadCodecs: [runtimeAuthorSchemas.StandardToolOutput],
      async authorize(context, operation) {
        return trusted.has(context) && !(operation === 'export' && (options.denyExport || exportRevoked))
          ? { ok: true, value: grant }
          : failure()
      },
      async resolvePayload(reference, context) {
        if (options.hangPayload) return new Promise<Outcome<JsonValue>>(() => {})
        const permitted = trusted.has(context)
        if (options.revokeAfterPayload?.()) exportRevoked = true
        return permitted && reference.kind === 'inline' ? { ok: true, value: reference.value } : failure()
      },
      async sendArchive(id, target, records) {
        deliveries++
        if (options.hangSend) return new Promise<Outcome<DataRef>>(() => {})
        if (options.sendUnknown) throw new Error('connection lost after send')
        remote.prepare('INSERT OR IGNORE INTO archives VALUES (?,?)').run(id, jcs({ target, records }))
        if (options.sendReturnedFailure) return failure()
        return {
          ok: true,
          value: ref(RuntimeSchemaRefs.StandardToolOutput, { content: [], structured: { id, target } }),
        }
      },
      async reconcileArchive(id, target) {
        const row = remote.prepare('SELECT body FROM archives WHERE id=?').get(id)
        if (options.reconcileReturnedFailure) return failure()
        return {
          ok: true,
          value: row
            ? ref(RuntimeSchemaRefs.StandardToolOutput, { content: [], structured: { id, target } })
            : null,
        }
      },
    }
    const factory = reference ? createReferenceAuditFactory(deployment) : createAuditFactory(deployment)
    const configuration = configCodec.encode({})
    if (!configuration.ok) throw new Error('config encoding failed')
    const context = call(),
      factoryContext: FactoryContext = {
        instanceId: 'instance',
        scope,
        bindingId: 'audit-binding',
        signal: new AbortController().signal,
      }
    const request = ref(RuntimeMethodSchemaRefs['agh.audit'].export.input, {
      cursor: null,
      limit: 50,
      targetRef: 'private-archive',
    })
    const { signal: _signal, ...wireContext } = context
    const page = { items: [], snapshot: 'snapshot', nextCursor: null, complete: true }
    const frame: ActionFrame = {
      actionId: 'export-action',
      parentActionId: null,
      runId: 'run',
      bindingId: 'audit-binding',
      method: 'export',
      input: request,
      inputDigest: request.kind === 'inline' ? request.digest : '',
      attemptId: 'attempt',
      attemptNumber: 1,
      invocationId: context.invocationId,
      requestIdentity: null,
      providerRevision: 1,
      continuation: null,
      signals: page,
      receipts: page,
      signalHighWater: 0,
      snapshot: 'snapshot',
      observedAt: new Date().toISOString(),
      context: wireContext,
      actionTimebox: { defaultTimeoutMs: 5000, maxDeadline: context.deadline },
    }
    return {
      factory,
      configuration: configuration.value,
      dependencies,
      factoryContext,
      call: context,
      append: safeInput,
      appendInput: ref(
        RuntimeMethodSchemaRefs['agh.audit'].append.input,
        options.unredacted
          ? {
              ...safeInput,
              redactedPayloadRef: ref(RuntimeSchemaRefs.StandardToolOutput, {
                content: [],
                structured: { token: 'sensitive credential' },
              }),
            }
          : safeInput,
      ),
      exportFrame: frame,
      actionContext(context): ActionContext {
        return {
          call: context,
          effects: {
            async invoke() {
              return failure()
            },
            async stream() {
              return failure()
            },
            async upload() {
              return failure()
            },
          },
          async progress() {
            return failure()
          },
        }
      },
      wrongCall: () => ({ ...context, authorizationRef: 'fake' }),
      restart: open,
      archiveDeliveries: () => deliveries,
    }
  }
  return {
    open,
    async close() {
      store?.close()
      remote.close()
      if (!options.retainOnClose) rmSync(dir, { recursive: true, force: true })
    },
  }
}
