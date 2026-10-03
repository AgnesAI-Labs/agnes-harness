import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { routingInputSchema, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type PreparedAction,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createReferenceModelAdapterFactory } from '../../../../../examples/runtime-reference/src/providers/model-adapter.js'
import { createModelAdapterFactory } from '../../../../ai/src/runtime/providers/model-adapter.js'
import { modelFixture } from '../../../../ai/test/runtime/model-fixture.js'
import { referenceModelFixture } from '../../../../ai/test/runtime/reference-model-fixture.js'
import { stableId } from '../../../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'
import {
  type RoutingRecoveryKind,
  recoverRoutingSelection,
  routingRecoverySeed,
} from './routing-recovery-source.js'

function required<T>(value: T | null): T {
  if (value === null) throw Error('Actual model provider absent')
  return value
}
function checked<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw Error(outcome.error.detailCode)
  return outcome.value
}
function json(value: unknown): JsonValue {
  const result = validateRuntime('JsonValue', value)
  if (!result.ok) throw Error('Prepared source is not plain wire JSON')
  return result.value
}
export function preparedSourceDigest(value: unknown): string {
  return canonicalJsonDigest(json(value))
}
function encode(schema: SchemaRef, value: unknown): Extract<DataRef, { kind: 'inline' }> {
  const body = boundedCanonicalJson(json(value), { maxBytes: 262144, maxDepth: 128, maxMembers: 10000 })
  if (!body.ok) throw Error('Prepared source exceeds official bounds')
  return {
    kind: 'inline',
    schema,
    value: body.value.json,
    bytes: body.value.bytes,
    digest: canonicalJsonDigest(body.value.json),
  }
}
const denied = {
  code: 'denied' as const,
  detailCode: 'prepared_native_source',
  message: 'Original preparation refused',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'prepared-source',
}

/** Restricted issuer and native evidence. It does not install a production model gateway or identity. */
export async function createPreparedModelSourceFixture(
  directory: string,
  kind: RoutingRecoveryKind,
  endpoint: string,
) {
  const defaultTemplate =
    kind === 'default'
      ? await modelFixture('openai-completions', endpoint, join(directory, 'receipt.json'))
      : null
  const referenceTemplate =
    kind === 'reference' ? await referenceModelFixture(endpoint, join(directory, 'receipt.json')) : null
  const template = required(defaultTemplate ?? referenceTemplate)
  await template.action.close('shutdown')
  await template.provider.close('shutdown')
  const context = template.context
  const sourceDB = new DatabaseSync(join(directory, 'prepared.sqlite'))
  sourceDB.exec(
    'CREATE TABLE prepared_sources(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE input_sources(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)',
  )
  const stateFile = join(directory, 'state.sqlite')
  const stamp = new Date().toISOString(),
    deadline = context.deadline
  const authority = { authorityId: 'prepared-state', tenantId: 'tenant', authorityEpoch: 1 }
  const state = new RuntimeStateDatabase({ file: stateFile, authority, now: () => Date.parse(stamp) })
  const data = encode(RuntimeSchemaRefs.StateLeaseRecordValue, {
    sessionId: 'input',
    lastWriterEpoch: 0,
    claim: null,
  })
  const runBinding = {
    bindingId: 'binding',
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  await state.createRun({
    admission: {
      ticketId: 'ticket',
      fingerprint: preparedSourceDigest({ ticket: kind }),
      releaseSetId: 'release',
      bindingId: 'binding',
      packagePinReceipt: data,
      runId: 'run',
      sessionId: 'session',
      lane: 'main',
      workspaceId: 'workspace',
      input: data,
      admittedAt: stamp,
      deadline,
      conversation: null,
    },
    scope: { kind: 'installation', installationId: 'fixture-installation' },
  })
  await state.open({
    requestId: 'writer',
    authority,
    sessionId: 'session',
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  const observer = new DatabaseSync(stateFile)
  let runRevision = 0
  const frameSources = new Map<string, typeof template.source>()
  function native(reference: DataRef, frameId: string) {
    if (
      reference.kind !== 'inline' ||
      preparedSourceDigest(reference.schema) !==
        preparedSourceDigest(RuntimeSchemaRefs.PreparedModelRequest) ||
      reference.digest !== preparedSourceDigest(reference.value)
    )
      return undefined
    const parsed = validateRuntime('PreparedModelRequest', reference.value)
    if (!parsed.ok) return undefined
    const row = sourceDB
      .prepare('SELECT body,digest FROM prepared_sources WHERE id=?')
      .get(parsed.value.preparedId)
    if (!row || typeof row.body !== 'string' || typeof row.digest !== 'string') return undefined
    const body = JSON.parse(row.body)
    if (
      preparedSourceDigest(body) !== row.digest ||
      preparedSourceDigest(body.prepared) !== reference.digest ||
      body.actionId !== frameId
    )
      return undefined
    const { signal: _signal, ...originalWire } = context
    if (preparedSourceDigest(body.context) !== preparedSourceDigest(originalWire)) return undefined
    for (const item of parsed.value.view.items) {
      const sourceId = item.provenance.sourceRefs[0]
      if (!sourceId) return undefined
      const input = sourceDB.prepare('SELECT body,digest FROM input_sources WHERE id=?').get(sourceId)
      if (!input || typeof input.body !== 'string' || typeof input.digest !== 'string') return undefined
      const retained = JSON.parse(input.body)
      if (
        preparedSourceDigest(retained) !== input.digest ||
        preparedSourceDigest(retained) !== preparedSourceDigest(item.body)
      )
        return undefined
    }
    return body
  }
  async function prepare(text: string, generation: number, predecessor: DataRef | null = null) {
    if (predecessor) {
      if (predecessor.kind !== 'inline') throw Error('Original prepared predecessor must be retained inline')
      const previous = validateRuntime('PreparedModelRequest', predecessor.value)
      if (!previous.ok) throw Error('Original prepared predecessor codec refused')
      const row = sourceDB
        .prepare('SELECT body FROM prepared_sources WHERE id=?')
        .get(previous.value.preparedId)
      if (!row || typeof row.body !== 'string') throw Error('Original prepared predecessor issuance absent')
      const retained = JSON.parse(row.body)
      if (typeof retained.actionId !== 'string' || !native(predecessor, retained.actionId))
        throw Error('Original prepared predecessor source refused')
      const action = validateRuntime('ActionRecordValue', readAction(retained.actionId))
      if (!action.ok || action.value.runId !== 'run' || action.value.intent.input.kind !== 'inline')
        throw Error('Original predecessor Action refused')
      const request = validateRuntime('ModelAdapterInvokeRequest', action.value.intent.input.value)
      if (
        !request.ok ||
        preparedSourceDigest(request.value.preparedCallRef) !== preparedSourceDigest(predecessor)
      )
        throw Error('Original predecessor Action source mismatch')
    }
    const body = checked(
      runtimeAuthorSchemas.StandardToolOutput.encode({ content: [{ type: 'text', text }] }),
    )
    const seed = routingRecoverySeed(kind)
    const oldInput = validateRuntime(
      'RoutingSelectInput',
      seed.input.kind === 'inline' ? seed.input.value : null,
    )
    if (!oldInput.ok) throw Error('Missing original routing input')
    const route = {
      ...template.source.prepared.target,
      routeRevision: generation,
      catalogRevision: generation,
      priceVersion: `fixture-price-${generation}`,
    }
    const selected = await recoverRoutingSelection({
      ...seed,
      priority: [route.routeId],
      input: checked(
        routingInputSchema.encode({ ...oldInput.value, catalogRevision: generation, allowedRoutes: [route] }),
      ),
    })
    const prepared = structuredClone(template.source.prepared)
    prepared.preparedId = `prepared-${generation}`
    prepared.target = selected.route.route
    const items = [
      {
        id: `message-${generation}`,
        kind: 'message' as const,
        body,
        sourceRefs: [],
        provenance: {
          sourceRefs: [`message-${generation}`],
          producer: prepared.ownerBinding,
          trustLabels: [],
        },
        trust: 'user' as const,
        tokenEstimate: 1,
        protected: false,
        toolPairRef: null,
        sourceRanges: [],
      },
    ]
    sourceDB
      .prepare('INSERT INTO input_sources VALUES(?,?,?)')
      .run(`message-${generation}`, JSON.stringify(body), preparedSourceDigest(body))
    const inputDigest = preparedSourceDigest(items)
    const viewBody = { ...prepared.view, viewId: `view-${generation}`, items, inputDigest }
    const { digest: _digest, ...viewWithoutDigest } = viewBody
    prepared.view = { ...viewWithoutDigest, digest: preparedSourceDigest(viewWithoutDigest) }
    prepared.inputDigest = inputDigest
    const full = validateRuntime('PreparedModelRequest', prepared)
    if (!full.ok) throw Error(`Official prepared codec refused ${JSON.stringify(full.errors)}`)
    const reference = encode(RuntimeSchemaRefs.PreparedModelRequest, full.value)
    const input = {
      view: full.value.view,
      route: full.value.target,
      outputSchema: full.value.outputSchema,
      toolCatalog: full.value.toolCatalog,
      generation: full.value.generation,
      hookResults: full.value.hookResults,
      sessionParameterRef: full.value.sessionParameterRef,
      credentialRef: full.value.credentialRef,
    }
    if (!validateRuntime('ModelPrepareRequest', input).ok) throw Error('Official prepare input refused')
    const output = {
      preparedRef: reference,
      targetSnapshot: full.value.target,
      inputDigest,
      estimatedUnits: full.value.estimatedUnits,
      mediaPlanRefs: [],
    }
    if (!validateRuntime('ModelPrepareResult', output).ok) throw Error('Official prepare result refused')
    const baseSource = structuredClone(template.source)
    const source =
      'request' in baseSource
        ? {
            ...baseSource,
            prepared: full.value,
            request: {
              ...baseSource.request,
              derivedHash: inputDigest,
              messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }],
            },
          }
        : {
            ...baseSource,
            prepared: full.value,
            body: {
              model: full.value.target.model,
              stream: true,
              max_completion_tokens: 32,
              messages: [{ role: 'user', content: text }],
            },
          }
    const invocationId = `invocation-${generation}`
    await state.admitInvocation({
      requestId: `invoke-${generation}`,
      runId: 'run',
      targetActionId: null,
      baseRevision: runRevision,
      bindingId: 'binding',
      writerEpoch: 1,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await state.closeInvocation({
      requestId: `close-${generation}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    const actionInput = encode(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input, {
      preparedCallRef: reference,
      externalIdempotencyKey: `external-${generation}`,
    })
    const intent = {
      key: `model-${generation}`,
      target: full.value.target.adapter,
      method: 'invoke',
      input: actionInput,
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      resultSchema: RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output,
      references: [],
    }
    const action: PreparedAction = { ...intent, intentFingerprint: preparedSourceDigest(intent) }
    const checkedAction = validateRuntime('PreparedAction', action)
    if (!checkedAction.ok)
      throw Error(`Official action codec refused ${JSON.stringify(checkedAction.errors)}`)
    const actionId = stableId('act', `run\0model-${generation}`)
    const { signal: _signal, ...wireContext } = context
    const nativeBody = {
      prepared: full.value,
      prepareInput: encode(RuntimeMethodSchemaRefs['agh.model'].prepare.input, input),
      prepareOutput: encode(RuntimeMethodSchemaRefs['agh.model'].prepare.output, output),
      selection: selected,
      modelConfiguration: checked(template.deployment.config.encode({})),
      modelPackageDigest: template.deployment.packageDigest,
      source,
      actionId,
      predecessor,
      context: wireContext,
    }
    const bytes = JSON.stringify(nativeBody),
      digest = preparedSourceDigest(nativeBody)
    sourceDB.prepare('INSERT INTO prepared_sources VALUES(?,?,?)').run(full.value.preparedId, bytes, digest)
    await state.advanceRun({
      commitId: `advance-${generation}`,
      guard: {
        authority,
        sessionId: 'session',
        runId: 'run',
        writerId: 'writer',
        writerEpoch: 1,
        expectedRunRevision: runRevision,
        bindingId: 'binding',
        invocationId,
        readGuards: [],
        queryUsage: null,
      },
      transition: {
        expectedRevision: runRevision,
        continuation: {
          namespace: 'agh.test',
          codecVersion: '1',
          data,
          provenance: { sourceRefs: [], producer: runBinding, trustLabels: [] },
          createdAt: stamp,
          references: [],
        },
        consumeSignals: [],
        actions: [action],
        next: { kind: 'continue' },
      },
    })
    runRevision++
    frameSources.set(actionId, source)
    return { reference, output, actionId, actionInput, prepared: full.value, selected }
  }
  function readAction(actionId: string) {
    const row = observer
      .prepare(
        'SELECT b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(`action:${actionId}`)
    if (!row || typeof row.value_json !== 'string') throw Error('Real State Action absent')
    return JSON.parse(row.value_json)
  }
  async function invoke(issued: Awaited<ReturnType<typeof prepare>>, supplied: DataRef = issued.reference) {
    const externalKey = `external-${issued.prepared.preparedId.replace('prepared-', '')}`
    const originalIdentity = template.frame.requestIdentity
    if (!originalIdentity) throw Error('Original request identity absent')
    const frame: ActionFrame = {
      ...template.frame,
      actionId: issued.actionId,
      input: encode(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input, {
        preparedCallRef: supplied,
        externalIdempotencyKey: externalKey,
      }),
      inputDigest: '',
      requestIdentity: {
        ...originalIdentity,
        idempotencyKey: externalKey,
        requestDigest: issued.prepared.inputDigest,
      },
    }
    frame.inputDigest = preparedSourceDigest(frame.input.kind === 'inline' ? frame.input.value : null)
    const current = (source: typeof template.source, currentFrame: typeof frame, call: CallContext) =>
      call === context &&
      source === frameSources.get(currentFrame.actionId) &&
      preparedSourceDigest(source) ===
        preparedSourceDigest(native(supplied, currentFrame.actionId)?.source ?? null) &&
      !call.signal.aborted
    const sourceChecks = {
      installed: (call: CallContext) => call === context,
      current,
      beforeSend: (source: typeof template.source, currentFrame: typeof frame, call: ActionContext) =>
        current(source, currentFrame, call.call),
    }
    const loadDefault = async (reference: DataRef, currentFrame: ActionFrame, call: ActionContext) => {
      const value = frameSources.get(currentFrame.actionId)
      return call.call === context && native(reference, currentFrame.actionId) && value && 'request' in value
        ? { ok: true as const, value }
        : { ok: false as const, error: denied }
    }
    const loadReference = async (reference: DataRef, currentFrame: ActionFrame, call: ActionContext) => {
      const value = frameSources.get(currentFrame.actionId)
      return call.call === context && native(reference, currentFrame.actionId) && value && 'body' in value
        ? { ok: true as const, value }
        : { ok: false as const, error: denied }
    }
    const factory = defaultTemplate
      ? createModelAdapterFactory({ ...defaultTemplate.deployment, ...sourceChecks, load: loadDefault })
      : referenceTemplate
        ? createReferenceModelAdapterFactory({
            ...referenceTemplate.deployment,
            ...sourceChecks,
            load: loadReference,
          })
        : null
    if (!factory) throw Error('Actual model factory absent')
    const provider = await factory.create(
      checked(template.deployment.config.encode({})),
      createTestServiceContainer().dependencies,
      {
        instanceId: `instance-${issued.actionId}`,
        scope: context.scope,
        bindingId: context.bindingId,
        signal: new AbortController().signal,
      },
    )
    checked(await provider.ready(context))
    const actionFactory = provider.actions?.invoke
    if (!actionFactory) throw Error('Actual model action factory absent')
    if (!('runtimeId' in context.scope)) throw Error('Original model runtime scope absent')
    const action = await actionFactory.create({
      instanceId: `leaf-${issued.actionId}`,
      actionId: issued.actionId,
      runId: 'run',
      bindingId: context.bindingId,
      scope: {
        installationId: context.scope.installationId,
        runtimeId: context.scope.runtimeId,
        kind: 'action',
        workspaceId: 'workspace',
        sessionId: 'session',
        runId: 'run',
        actionId: issued.actionId,
      },
      signal: new AbortController().signal,
    })
    if (action.kind !== 'leaf') throw Error('Model action is not a leaf')
    try {
      checked(await action.ready(context))
      return await action.execute(frame, template.call)
    } finally {
      await action.close('shutdown')
      await provider.close('shutdown')
    }
  }
  return {
    prepare,
    invoke,
    readAction,
    sourceDB,
    context,
    close: async () => {
      observer.close()
      sourceDB.close()
      await state.close()
    },
  }
}
