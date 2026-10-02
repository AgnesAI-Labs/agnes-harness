import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import type { AuditAppend, BindingRef, ScopeRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntimeErrorDetail } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { AuditConflict, openAuditStore } from '../../src/runtime/audit/store.js'
import { auditWrite } from '../../src/runtime/providers/audit.js'

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
const write = auditWrite(input, { scope, producer, authorityId: 'audit-owner' })
function testStore(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-store-'))
  try {
    run(join(dir, 'audit.db'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
describe('durable audit owner', () => {
  it('replays stable identity after restart and rejects changed complete fingerprint', () =>
    testStore((path) => {
      let store = openAuditStore(path, 'audit-owner')
      const ref = store.append(write)
      store.close()
      store = openAuditStore(path, 'audit-owner')
      expect(store.append(write)).toEqual(ref)
      const altered = auditWrite(
        {
          ...input,
          redactedPayloadRef: {
            ...input.redactedPayloadRef,
            ...(input.redactedPayloadRef.kind === 'inline'
              ? { value: { safe: 'changed' }, digest: canonicalJsonDigest({ safe: 'changed' }) }
              : {}),
          },
        },
        { scope, producer, authorityId: 'audit-owner' },
      )
      expect(altered.identity).toBe(write.identity)
      expect(() => store.append(altered)).toThrow(AuditConflict)
      expect(store.page(jcs(scope), 0, 50)).toHaveLength(1)
      store.close()
    }))
  it.each(['before-write', 'after-write', 'before-commit'] as const)(
    'rolls back fact and audit together at %s',
    (point) =>
      testStore((path) => {
        const store = openAuditStore(path, 'audit-owner', (at) => {
          if (at === point) throw new Error('injected commit failure')
        })
        expect(() => store.commitFactAndAudit('fact', { sent: true }, write)).toThrow()
        expect(store.readFact('fact')).toBeNull()
        expect(store.page(jcs(scope), 0, 50)).toHaveLength(0)
        store.close()
      }),
  )
  it('lost commit response keeps both facts and audit and permits exact replay', () =>
    testStore((path) => {
      const store = openAuditStore(path, 'audit-owner', (point) => {
        if (point === 'after-commit') throw new Error('response lost')
      })
      expect(() => store.commitFactAndAudit('fact', { sent: true }, write)).toThrow()
      store.close()
      const recovered = openAuditStore(path, 'audit-owner')
      expect(recovered.readFact('fact')).toEqual({ sent: true })
      const receipt = recovered.commitFactAndAudit('fact', { sent: true }, write)
      expect(recovered.append(write)).toEqual(receipt)
      recovered.close()
    }))
  it('retains source outbox until destination inbox+audit commits and ack loss is replay safe', () =>
    testStore((path) => {
      const source = openAuditStore(path, 'audit-owner')
      const destination = openAuditStore(`${path}.destination`, 'audit-owner')
      source.commitFactAndIntent('fact', { sent: true }, 'delivery', write)
      expect(source.pending()).toHaveLength(1)
      const ref = destination.acceptDelivery('delivery', write, 'source-owner')
      expect(destination.acceptDelivery('delivery', write, 'source-owner')).toEqual(ref)
      expect(destination.page(jcs(scope), 0, 50)).toHaveLength(1)
      expect(source.pending()).toHaveLength(1)
      expect(() =>
        destination.acceptDelivery('delivery', { ...write, fingerprint: 'c'.repeat(64) }, 'source-owner'),
      ).toThrow(AuditConflict)
      source.acknowledge('delivery', write.fingerprint)
      expect(source.pending()).toHaveLength(0)
      source.close()
      destination.close()
    }))
  it('persists export intent once and never treats restored pending as first send', () =>
    testStore((path) => {
      let store = openAuditStore(path, 'audit-owner')
      expect(store.prepareExport('export', 'a'.repeat(64), { target: 'archive' }).created).toBe(true)
      store.close()
      store = openAuditStore(path, 'audit-owner')
      expect(store.prepareExport('export', 'a'.repeat(64), { target: 'archive' }).created).toBe(false)
      store.close()
    }))
  it('rejects authority takeover of an existing durable owner', () =>
    testStore((path) => {
      const store = openAuditStore(path, 'audit-owner')
      store.close()
      expect(() => openAuditStore(path, 'other-owner')).toThrow(AuditConflict)
    }))
})

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
import {
  type AuditContractDriver,
  type AuditContractInstance,
  runAuditContractScenario,
} from '@agnes/extension-api/testkit'
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
function contractDriver(reference: boolean, options: AuditTestOptions = {}): AuditContractDriver {
  const dir = mkdtempSync(join(tmpdir(), 'audit-public-'))
  const remote = new DatabaseSync(join(dir, 'remote.db'))
  remote.exec(
    'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE archives(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
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
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
describe.each([false, true])('public audit contract reference=%s', (reference) => {
  it.each(['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)(
    '%s uses the selected public provider',
    async (scenario) => {
      const rows = await runAuditContractScenario(contractDriver(reference), scenario)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.passed)).toBe(true)
    },
  )
})

async function withConsumer(
  reference: boolean,
  options: AuditTestOptions,
  run: (
    fixture: AuditContractInstance,
    service: import('@agnes/extension-api/runtime').ServiceProvider,
  ) => Promise<void>,
) {
  const driver = contractDriver(reference, options),
    fixture = await driver.open()
  const service = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  try {
    await run(fixture, service)
  } finally {
    await service.close('shutdown')
    await driver.close()
  }
}
const controlRequest = (fixture: AuditContractInstance, data = fixture.appendInput) => ({
  target: {
    bindingId: fixture.factoryContext.bindingId,
    contract: 'agh.audit',
    logicalName: fixture.factory.descriptor.logicalName,
    providerId: fixture.factory.descriptor.providerId,
  },
  method: 'append',
  input: data,
})
async function selectedAction(
  fixture: AuditContractInstance,
  service: import('@agnes/extension-api/runtime').ServiceProvider,
) {
  const action = await service.actions?.export?.create({
    instanceId: 'export-instance',
    actionId: fixture.exportFrame.actionId,
    runId: fixture.exportFrame.runId,
    bindingId: fixture.factoryContext.bindingId,
    scope: fixture.factoryContext.scope,
    signal: fixture.call.signal,
  })
  if (action?.kind !== 'leaf') throw new Error('export action missing')
  return action
}
describe.each([false, true])('audit consumer security and recovery reference=%s', (reference) => {
  it('mandatory append failure blocks new business effects', () =>
    withConsumer(reference, { storageFailure: true }, async (fixture, service) => {
      let effects = 0
      const appended = await service.control?.(controlRequest(fixture), fixture.call)
      if (appended?.ok) effects++
      expect(appended?.ok).toBe(false)
      expect(effects).toBe(0)
      expect(fixture.archiveDeliveries()).toBe(0)
    }))
  it('rejects unredacted credential payload without calling egress', () =>
    withConsumer(reference, { unredacted: true }, async (fixture, service) => {
      const result = await service.control?.(controlRequest(fixture), fixture.call)
      expect(result?.ok).toBe(false)
      expect(fixture.archiveDeliveries()).toBe(0)
    }))
  it('rejects changed DataRef digest and another workspace without effect', () =>
    withConsumer(reference, {}, async (fixture, service) => {
      if (fixture.appendInput.kind !== 'inline') throw new Error('fixture requires inline')
      expect(
        (
          await service.control?.(
            controlRequest(fixture, { ...fixture.appendInput, digest: 'e'.repeat(64) }),
            fixture.call,
          )
        )?.ok,
      ).toBe(false)
      const wrong = { ...fixture.call, scope: { ...scope, workspaceId: 'another' } }
      expect((await service.control?.(controlRequest(fixture), wrong))?.ok).toBe(false)
      expect(fixture.archiveDeliveries()).toBe(0)
    }))
  it('refuses mismatched captured context before claiming absent export is safely retryable', () =>
    withConsumer(reference, {}, async (fixture, service) => {
      const action = await selectedAction(fixture, service)
      const frame = {
        ...fixture.exportFrame,
        context: { ...fixture.exportFrame.context, deadline: '2099-01-01T00:00:00.000Z' },
      }
      const result = await action.reconcile(frame, [], fixture.actionContext(fixture.call))
      expect(result.kind).toBe('unknown')
      expect(fixture.archiveDeliveries()).toBe(0)
      await action.close('completed')
    }))
  it('rechecks export target authorization and does not send on denial', () =>
    withConsumer(reference, { denyExport: true }, async (fixture, service) => {
      expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
      const action = await selectedAction(fixture, service)
      try {
        const result = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
        expect(result.outcome).toBe('failed')
        expect(fixture.archiveDeliveries()).toBe(0)
      } finally {
        await action.close('completed')
      }
    }))
  it.each(['throw', 'returned-failure', 'reconcile-failure'] as const)(
    'returns durable unknown owner after %s, retains intent, and never resends after cold restart',
    async (kind) => {
      const driver = contractDriver(reference, {
        sendUnknown: kind === 'throw',
        sendReturnedFailure: kind !== 'throw',
        reconcileReturnedFailure: kind === 'reconcile-failure',
      })
      let fixture = await driver.open()
      let service = await fixture.factory.create(
        fixture.configuration,
        fixture.dependencies,
        fixture.factoryContext,
      )
      try {
        expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
        let action = await selectedAction(fixture, service)
        const first = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
        expect(first.outcome).toBe('unknown_effect')
        expect(first.error?.retryAdvice.kind).toBe('reconcile')
        expect(validateRuntimeErrorDetail(first.error).ok).toBe(true)
        expect(first.error?.retryAdvice).toEqual({
          kind: 'reconcile',
          ownerRef: { kind: 'action', id: fixture.exportFrame.actionId },
        })
        expect(fixture.archiveDeliveries()).toBe(1)
        const drain = await service.drain(fixture.call.deadline, fixture.call)
        expect(drain.ok && drain.value.state).toBe('blocked')
        expect(drain.ok && drain.value.durableOwnerRefs.length).toBe(1)
        await action.close('shutdown')
        await service.close('shutdown')
        fixture = await fixture.restart()
        service = await fixture.factory.create(
          fixture.configuration,
          fixture.dependencies,
          fixture.factoryContext,
        )
        action = await selectedAction(fixture, service)
        const resumed = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
        expect(resumed.outcome).toBe(kind === 'returned-failure' ? 'succeeded' : 'unknown_effect')
        expect(fixture.archiveDeliveries()).toBe(1)
        await action.close('shutdown')
      } finally {
        await service.close('shutdown')
        await driver.close()
      }
    },
  )
  it('rechecks current authorization after payload read before releasing a completed receipt', async () => {
    let revokeNow = false
    const driver = contractDriver(reference, { revokeAfterPayload: () => revokeNow })
    const fixture = await driver.open()
    const service = await fixture.factory.create(
      fixture.configuration,
      fixture.dependencies,
      fixture.factoryContext,
    )
    const action = await selectedAction(fixture, service)
    try {
      expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
      expect((await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))).outcome).toBe(
        'succeeded',
      )
      revokeNow = true
      const repeated = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
      expect(repeated.outcome).toBe('failed')
      expect(repeated.result).toBeUndefined()
      expect(fixture.archiveDeliveries()).toBe(1)
    } finally {
      await action.close('shutdown')
      await service.close('shutdown')
      await driver.close()
    }
  })
  it('keeps original output on repeated export and closes only the action instance', () =>
    withConsumer(reference, {}, async (fixture, service) => {
      expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
      const action = await selectedAction(fixture, service)
      const first = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
      const second = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
      expect(jcs(first)).toBe(jcs(second))
      expect(fixture.archiveDeliveries()).toBe(1)
      await action.close('completed')
      expect((await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))).outcome).toBe(
        'failed',
      )
      expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
    }))
})

it.each([false, true])(
  'locks source owner through duplicate delivery and restart reference=%s',
  (reference) =>
    testStore((path) => {
      const open = reference ? openReferenceAuditStore : openAuditStore
      let destination = open(path, 'audit-owner')
      destination.acceptDelivery('delivery', write, 'verified-source')
      destination.close()
      destination = open(path, 'audit-owner')
      try {
        expect(() => destination.acceptDelivery('delivery', write, 'changed-source')).toThrow()
        expect(destination.acceptDelivery('delivery', write, 'verified-source')).toEqual(
          destination.append(write),
        )
        expect(destination.page(jcs(scope), 0, 50)).toHaveLength(1)
      } finally {
        destination.close()
      }
    }),
)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerAuditContract } from '@agnes/extension-api/testkit'
import type { BuildIdentity } from '../../../extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../extension-api/testkit/runtime/harness.js'

it('registers both real audit suites and rejects a missing reference registration', async () => {
  const root = new URL('../../../../', import.meta.url)
  const hash = (path: string) =>
    createHash('sha256')
      .update(readFileSync(new URL(path, root)))
      .digest('hex')
  const sourceFiles = [
    'packages/host/src/runtime/providers/audit.ts',
    'packages/host/src/runtime/audit/store.ts',
    'packages/host/src/runtime/audit/redaction.ts',
    'examples/runtime-reference/src/providers/audit.ts',
    'examples/runtime-reference/src/providers/audit-store.ts',
    'packages/extension-api/testkit/runtime/contracts/audit.ts',
  ]
  const buildDigest = createHash('sha256')
    .update(jcs(sourceFiles.map((path) => ({ path, sha256: hash(path) }))))
    .digest('hex')
  const build: BuildIdentity = {
    codeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    buildDigest,
    lockDigest: hash('pnpm-lock.yaml'),
    specVersion: 'runtime-prototype-api.v1',
    sdkVersion: JSON.parse(readFileSync(new URL('packages/extension-api/package.json', root), 'utf8'))
      .version,
    sdkDigest: hash('packages/extension-api/src/runtime/public-api.ts'),
    platform: `${process.platform}/${process.arch}/node${process.versions.node}`,
  }
  const binding = (reference: boolean) => ({
    providerId: reference ? 'reference' : 'default',
    providerDigest: hash(
      reference
        ? 'examples/runtime-reference/src/providers/audit.ts'
        : 'packages/host/src/runtime/providers/audit.ts',
    ),
    build,
    configDigest: configCodec.ref.digest,
    releaseSetDigest: buildDigest,
    consumer: 'durable-audit-public-provider-fixture',
    command: 'vitest run packages/host/test/runtime/audit.test.ts',
    driver: () => contractDriver(reference),
  })
  const harness = createConformanceHarness()
  registerAuditContract(harness, binding(false))
  registerAuditContract(harness, binding(true))
  const request = {
    contracts: ['agh.audit'],
    providers: ['default', 'reference'],
    command: 'audit-contract-suite',
    clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
  }
  const report = await harness.run(request)
  expect(report.status).toBe('passed')
  expect(report.assertions).toHaveLength(12)
  expect(report.failures).toHaveLength(0)
  const missing = createConformanceHarness()
  registerAuditContract(missing, binding(false))
  const refused = await missing.run(request)
  expect(refused.status).toBe('failed')
  expect(refused.failures.some((row) => row.code === 'missing-evidence')).toBe(true)
})

it.each([false, true])('bounded append timeout never calls business effects reference=%s', (reference) =>
  withConsumer(reference, { hangPayload: true }, async (fixture, service) => {
    const started = Date.now()
    const result = await service.control?.(controlRequest(fixture), fixture.call)
    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(fixture.archiveDeliveries()).toBe(0)
  }),
)
it.each([false, true])(
  'bounded archive deadline retains unknown without blind retry reference=%s',
  (reference) =>
    withConsumer(reference, { hangSend: true }, async (fixture, service) => {
      expect((await service.control?.(controlRequest(fixture), fixture.call))?.ok).toBe(true)
      const action = await selectedAction(fixture, service)
      try {
        const result = await action.execute(fixture.exportFrame, fixture.actionContext(fixture.call))
        expect(result.outcome).toBe('unknown_effect')
        expect(fixture.archiveDeliveries()).toBe(1)
        const drained = await service.drain(fixture.call.deadline, fixture.call)
        expect(drained.ok && drained.value.state).toBe('blocked')
      } finally {
        await action.close('shutdown')
      }
    }),
)

it.each([false, true])(
  'rejects altered payload with an unchanged supplied fingerprint reference=%s',
  (reference) =>
    testStore((path) => {
      const store = reference
        ? openReferenceAuditStore(path, 'audit-owner')
        : openAuditStore(path, 'audit-owner')
      try {
        const damaged = { ...write, input: { ...write.input, operation: 'changed-operation' } }
        expect(() => store.append(damaged)).toThrow()
        expect(store.page(jcs(scope), 0, 50)).toHaveLength(0)
      } finally {
        store.close()
      }
    }),
)

it.each([false, true])('refuses corrupted persisted receipts after cold restart reference=%s', (reference) =>
  testStore((path) => {
    let store = reference ? openReferenceAuditStore(path, 'audit-owner') : openAuditStore(path, 'audit-owner')
    store.append(write)
    store.close()
    const db = new DatabaseSync(path)
    if (reference) {
      db.prepare("UPDATE facts SET value=json_set(value,'$.receipt.digest',?) WHERE tag='audit'").run(
        'c'.repeat(64),
      )
    } else {
      db.prepare("UPDATE audit_rows SET receipt=json_set(receipt,'$.digest',?)").run('c'.repeat(64))
    }
    db.close()
    store = reference ? openReferenceAuditStore(path, 'audit-owner') : openAuditStore(path, 'audit-owner')
    try {
      expect(() => store.page(jcs(scope), 0, 50)).toThrow()
    } finally {
      store.close()
    }
  }),
)

it.each([false, true])(
  'rejects malformed outbox fingerprint without committing the source fact reference=%s',
  (reference) =>
    testStore((path) => {
      const store = reference
        ? openReferenceAuditStore(path, 'audit-owner')
        : openAuditStore(path, 'audit-owner')
      try {
        expect(() =>
          store.commitFactAndIntent('source-fact', { sent: true }, 'delivery', {
            ...write,
            input: { ...input, operation: 'tampered' },
          }),
        ).toThrow()
        expect(store.readFact('source-fact')).toBeNull()
        expect(store.pending()).toHaveLength(0)
      } finally {
        store.close()
      }
    }),
)

it.each([false, true])(
  'rejects reused delivery with a different stable producer identity reference=%s',
  (reference) =>
    testStore((path) => {
      const store = reference
        ? openReferenceAuditStore(path, 'audit-owner')
        : openAuditStore(path, 'audit-owner')
      try {
        const second = auditWrite(input, {
          scope,
          producer: { ...producer, bindingId: 'second-producer' },
          authorityId: 'audit-owner',
        })
        expect(second.fingerprint).toBe(write.fingerprint)
        expect(second.identity).not.toBe(write.identity)
        store.commitFactAndIntent('first-fact', { producer: 'first' }, 'delivery', write)
        expect(() =>
          store.commitFactAndIntent('second-fact', { producer: 'second' }, 'delivery', second),
        ).toThrow()
        expect(store.readFact('second-fact')).toBeNull()
        expect(store.pending()[0]?.write).toEqual(write)
      } finally {
        store.close()
      }
    }),
)
it.each([false, true])(
  'preserves the original source fact binding for an exact audit delivery reference=%s',
  (reference) =>
    testStore((path) => {
      const store = reference
        ? openReferenceAuditStore(path, 'audit-owner')
        : openAuditStore(path, 'audit-owner')
      try {
        store.commitFactAndIntent('first-fact', { producer: 'first' }, 'delivery', write)
        expect(() =>
          store.commitFactAndIntent('second-fact', { producer: 'second' }, 'delivery', write),
        ).toThrow()
        expect(store.readFact('second-fact')).toBeNull()
        store.commitFactAndIntent('first-fact', { producer: 'first' }, 'delivery', write)
        expect(store.pending()).toHaveLength(1)
      } finally {
        store.close()
      }
    }),
)
