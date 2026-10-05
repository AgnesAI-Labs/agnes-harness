import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { refusal } from '../../src/runtime/model/prepared-call.js'
import {
  createDefaultModelFactory,
  type IssuanceEntry,
  type ModelDeployment,
  type RevisionBinding,
} from '../../src/runtime/providers/model.js'
import { callContext, fixtureAdapter, fixtureCatalog, fixtureOwner, fixtureWire } from './model-fixture.js'

export function inlineRef(schema: W.SchemaRef, value: unknown): W.DataRef {
  return {
    kind: 'inline',
    schema,
    value: value as W.JsonValue,
    digest: canonicalJsonDigest(value as never),
    bytes: new TextEncoder().encode(JSON.stringify(value)).length,
  }
}
export type Counters = { recorded: IssuanceEntry[]; revisions: RevisionBinding[]; network: number }
export function fakeDeployment(over: Partial<ModelDeployment> = {}) {
  const counters: Counters = { recorded: [], revisions: [], network: 0 }
  const ledger = new Map<string, IssuanceEntry>()
  const bindings = new Map<string, string>()
  const config = defineGeneratedAuthorSchema<Record<string, never>>({
    ownerPackageId: '@fixture/model',
    name: 'RuntimeEmptyConfig',
    typeId: '@fixture/model/empty@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/RuntimeEmptyConfig',
      $defs: {
        RuntimeEmptyConfig: {
          type: 'object',
          additionalProperties: false,
          properties: {},
          required: [],
          maxProperties: 0,
        },
      },
    },
  })
  const deployment: ModelDeployment = {
    packageDigest: 'f'.repeat(64),
    config,
    secrets: null,
    state: {
      bindingId: 'state',
      contract: 'agh.state',
      logicalName: 'default',
      providerId: 'agh.default/state',
    },
    current: () => true,
    catalog: { capture: () => ({ ok: true, value: fixtureCatalog() }) },
    prices: { version: (target) => target.priceVersion },
    wire: { resolve: async () => ({ ok: true, value: fixtureWire }) },
    adapters: {
      select: (target) =>
        target.bindingId === fixtureAdapter.bindingId
          ? { binding: fixtureAdapter, packageDigest: 'package-1' }
          : null,
    },
    issuance: {
      record: (entry) => {
        counters.recorded.push(entry)
        ledger.set(entry.preparedDigest, entry)
        return { ok: true, value: undefined }
      },
      read: (digest) => ledger.get(digest),
      bindRevision: (binding) => {
        counters.revisions.push(binding)
        const key = `${binding.routeId}\0${binding.routeRevision}\0${binding.catalogRevision}`
        const prior = bindings.get(key)
        if (prior !== undefined && prior !== binding.selectionDigest)
          return refusal('conflict', 'model_revision_conflict')
        bindings.set(key, binding.selectionDigest)
        return { ok: true, value: undefined }
      },
    },
    bridge: { ready: () => ({ ok: true, value: undefined }) },
    ...over,
  }
  return { deployment, counters, ledger, bindings }
}
export async function openModel(over: Partial<ModelDeployment> = {}) {
  const fake = fakeDeployment(over)
  const factory = createDefaultModelFactory(fake.deployment)
  const config = fake.deployment.config.encode({})
  if (!config.ok) throw new Error('fixture config rejected')
  const lifetime = new AbortController()
  const provider = await factory.create(config.value, createTestServiceContainer().dependencies, {
    instanceId: 'instance',
    bindingId: fixtureOwner.bindingId,
    scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as W.ScopeRef,
    signal: lifetime.signal,
  })
  const ready = await provider.ready(callContext())
  if (!ready.ok) throw new Error(ready.error.detailCode)
  return { ...fake, provider, lifetime }
}
export function actionFrame(
  method: 'infer' | 'prepareRequest',
  input: W.DataRef,
  over: Partial<W.ActionFrame> = {},
): W.ActionFrame {
  const { signal: _signal, ...context } = callContext()
  return {
    actionId: 'parent-1',
    parentActionId: null,
    runId: 'run-1',
    bindingId: fixtureOwner.bindingId,
    method,
    input,
    inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
    attemptId: 'attempt-1',
    attemptNumber: 1,
    invocationId: 'invocation-parent',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 'signals', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'receipts', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'frame',
    observedAt: new Date().toISOString(),
    context,
    actionTimebox: { defaultTimeoutMs: 10_000, maxDeadline: context.deadline },
    ...over,
  }
}
