import assert from 'node:assert/strict'
import { HOOK_TABLE } from '../../../../packages/extension-api/src/index.js'
import type { CallContext, DataRef, ScopeRef } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  createConformanceHarness,
  judgeReport,
  LEGACY_FIXTURES,
} from '../../../../packages/extension-api/testkit/index.js'
import {
  communityDefinitionDigest,
  FixedCordisAssembly,
  HOOKS_RUNNER_EVENTS,
  HOOKS_RUNNER_ROW_ID,
  normalizeHookSnapshots,
  PUBLIC_HOOK_EVENTS,
} from '../../../../packages/plugin-runtime/src/host/index.js'
import { canonicalJsonDigest, validateRuntime } from '../../../../packages/protocol/src/runtime/index.js'

const digest = 'a'.repeat(64)
const stops: string[] = []
const assembly = new FixedCordisAssembly(
  [
    {
      key: 'mcp:shared',
      start: () => () => {
        stops.push('mcp:shared')
      },
    },
  ],
  { hooksRunnerRank: 4 },
)

assert.deepEqual(PUBLIC_HOOK_EVENTS, HOOK_TABLE)

const first = await assembly.open({
  generationId: 'old',
  brokerKeys: ['mcp:shared'],
  loopFeatures: ['loop-hook:before_step'],
  providers: [
    {
      providerId: 'loop',
      contract: 'agh.loop',
      major: 1,
      logicalName: 'default',
      scope: 'runtime',
      features: ['loop-hook:before_step'],
      packageDigest: digest,
      capabilities: [],
      requires: [],
    },
  ],
  contributions: [
    {
      providerId: 'loop',
      source: 'legacy-apply',
      hooks: [{ event: 'before_step' }],
    },
  ],
})
assert.equal(first.published, true)
assert.deepEqual(first.installedHooks, ['before_step'])
assembly.pinRun('run-old')

await assembly.open({
  generationId: 'next',
  brokerKeys: ['mcp:shared'],
  providers: [
    {
      providerId: 'loop',
      contract: 'agh.loop',
      major: 1,
      logicalName: 'default',
      scope: 'runtime',
      features: [],
      packageDigest: 'b'.repeat(64),
      capabilities: [],
      requires: [],
    },
  ],
})
await assembly.close('next')
assert.deepEqual(stops, [])
assert.equal(assembly.resourceRunning('mcp:shared'), true)
assert.equal(assembly.invoke('run-old', 'loop').generationId, 'old')

await assert.rejects(
  assembly.open({
    generationId: 'captured',
    providers: [
      {
        providerId: 'short',
        contract: 'agh.short',
        major: 1,
        logicalName: 'default',
        scope: 'action',
        features: [],
        packageDigest: digest,
        capabilities: [],
        requires: [],
      },
      {
        providerId: 'long',
        contract: 'agh.long',
        major: 1,
        logicalName: 'default',
        scope: 'runtime',
        features: [],
        packageDigest: digest,
        capabilities: [],
        requires: [
          {
            contract: 'agh.short',
            major: 1,
            logicalName: 'default',
            scope: 'action',
            features: [],
            optional: false,
            capture: 'instance',
          },
        ],
      },
    ],
  }),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'scope_capture')
    return true
  },
)

await assert.rejects(
  assembly.open({
    generationId: 'container',
    container: 'other',
    providers: [],
  } as never),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'container_forbidden')
    return true
  },
)

const repeated = await assembly.close('old')
assert.equal(repeated.repeated, false)
const again = await assembly.close('old')
assert.equal(again.repeated, true)
assert.deepEqual(stops, ['mcp:shared'])

const takeover = assembly.attachHooksRunner({
  rowId: HOOKS_RUNNER_ROW_ID,
  events: [...HOOKS_RUNNER_EVENTS],
  mappingReports: [{ event: 'Notification', unsupportedFields: ['permissionMode'] }],
})
assert.equal(takeover.mode, 'takeover')
assert.equal(takeover.rank, 4)
assert.equal(takeover.execution, 'delegated')
assert.equal(assembly.disableHooksRunnerTakeover().mode, 'builtin')

const drafts = normalizeHookSnapshots({
  workspaceId: 'workspace-1',
  configRevision: 1,
  registrations: [
    {
      id: 'mask',
      event: 'tool_result',
      source: 'interceptor',
      sourceKey: 'pkg#mask',
      provider: {
        bindingId: 'binding-1',
        contract: 'agh.hooks',
        logicalName: 'default',
        providerId: 'provider-1',
      },
      codeDigest: digest,
      execution: 'opaque',
      failPolicy: 'closed',
      readFields: ['/result'],
      writeFields: ['/content'],
    },
  ],
})
const draft = drafts[0]
assert.ok(draft)
const validated = validateRuntime('EffectiveHookSnapshot', draft.snapshot)
assert.equal(validated.ok, true, JSON.stringify(validated))
assert.equal(canonicalJsonDigest(JSON.parse(JSON.stringify(draft.digestMaterial))), draft.snapshot.digest)

const communityDefinition = {
  contract: 'acme/goals',
  major: 1,
  ownerPackageId: 'acme',
  scope: 'workspace' as const,
  features: ['goals.v1'],
  operations: [
    {
      method: 'list',
      kind: 'query' as const,
      inputSchema: { typeId: 'acme/goal@1', revision: 1, digest },
      outputSchema: { typeId: 'acme/goal@1', revision: 1, digest },
      requiredCapabilities: [],
      retrySafety: 'read-only' as const,
    },
  ],
}
const communityValidated = validateRuntime('CommunityContractDefinition', communityDefinition)
assert.equal(communityValidated.ok, true, JSON.stringify(communityValidated))
assert.equal(
  communityDefinitionDigest(communityDefinition),
  canonicalJsonDigest(JSON.parse(JSON.stringify(communityDefinition))),
)

const fixtureBuild = {
  codeSha: 'cordis-code',
  buildDigest: 'cordis-build',
  lockDigest: 'cordis-lock',
  specVersion: 'cordis-spec',
  sdkVersion: 'cordis-sdk',
  sdkDigest: 'cordis-sdk-digest',
  platform: 'test',
}
const fixtureClock = {
  startedAt: '2026-10-01T00:00:00.000Z',
  finishedAt: '2026-10-01T00:00:01.000Z',
} as const
const inputRef: DataRef = {
  kind: 'inline',
  schema: { typeId: 'demo/input@1', revision: 1, digest: 'a'.repeat(64) },
  value: null,
  digest: 'b'.repeat(64),
  bytes: 4,
}

function scopeRef(kind: ScopeRef['kind']): ScopeRef {
  if (kind === 'installation') return { kind, installationId: 'install-1' }
  if (kind === 'runtime') return { kind, installationId: 'install-1', runtimeId: 'runtime-1' }
  if (kind === 'workspace') {
    return { kind, installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'workspace-1' }
  }
  if (kind === 'session') {
    return {
      kind,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    }
  }
  if (kind === 'run') {
    return {
      kind,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-1',
    }
  }
  return {
    kind: 'action',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    actionId: 'action-1',
  }
}

function callContext(kind: ScopeRef['kind']): CallContext {
  return {
    principalRef: 'principal-1',
    scope: scopeRef(kind),
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

for (const fixture of LEGACY_FIXTURES) {
  assert.equal(fixture.callsDefaultProvider, false)
  assert.equal(fixture.structuralAssertionIsEquivalence, false)
}
assert.ok(LEGACY_FIXTURES.length > 0)

const peer = new FixedCordisAssembly()
const seen: string[] = []
await peer.open({
  generationId: 'peer',
  providers: [
    {
      providerId: 'loop',
      contract: 'agh.loop',
      major: 1,
      logicalName: 'default',
      scope: 'runtime',
      features: [],
      packageDigest: digest,
      capabilities: [],
      requires: [],
    },
  ],
  observers: [
    {
      id: 'observer-1',
      scope: 'runtime',
      event: { typeId: 'agh.notice', schemaTypeId: 'agh.notice' },
      handle(notification, context) {
        seen.push(notification.eventId)
        assert.deepEqual(Object.keys(context).sort(), ['log', 'signal'])
      },
    },
  ],
})

const harness = createConformanceHarness()
assert.equal(harness.inbox.kind, 'fixture')
assert.equal(harness.inbox.persistent, false)
assert.equal(harness.effects.mark, 'restricted-effects')

harness.registerCase({
  contract: 'agh.loop',
  scenario: 'normal',
  qualification: 'required',
  providerId: 'reference',
  async run(context) {
    let pending: Promise<{ acceptedEffects: readonly unknown[]; status: string }> | undefined
    context.inbox.registerWaiter('peer', (acceptance) => {
      pending = peer.deliver('peer', {
        typeId: 'agh.notice',
        scope: 'action',
        eventId: acceptance.deliveryId,
        data: { ok: true },
      })
    })
    const before = context.effects.calls().length
    const notice = context.inbox.notify('peer')
    const delivered = await pending
    assert.equal(notice.woken, 1)
    assert.deepEqual(seen, [notice.deliveryId])
    assert.equal(delivered?.status, 'completed')
    assert.deepEqual(delivered?.acceptedEffects, [])
    assert.equal(context.effects.calls().length, before)
    assert.equal(context.inbox.read(notice.deliveryId, 'terminal'), 'terminal')
    return {
      id: 'assembly-inbox-peer',
      providerDigest: 'assembly-provider',
      recipe: 'fixed cordis assembly',
      features: ['read'],
      build: fixtureBuild,
      consumer: 'assembly-consumer',
      command: 'cordis assembly acceptance',
      status: 'passed',
      configDigest: 'assembly-config',
      releaseSetDigest: 'assembly-release',
      attachmentDigest: null,
      fixture: 'runtime-inbox',
      sharedEvidenceId: null,
      reuse: { scope: 'run', methodKind: 'compute', lifecycle: 'call', undeclaredConnection: false },
      perImplementation: true,
      gate: null,
    }
  },
})
harness.registerCase({
  contract: 'agh.loop',
  scenario: 'deny',
  qualification: 'required',
  providerId: 'reference',
  async run(context) {
    const refused = await context.effects.ports.invoke(
      { operation: 'bill', input: inputRef },
      callContext('runtime'),
    )
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.equal(refused.error.detailCode, 'operation_not_supported')
    let forwarded = 0
    context.effects.allow({
      port: 'invoke',
      operation: 'note',
      handle: async () => {
        forwarded += 1
        return { ok: true, value: inputRef }
      },
    })
    const allowed = await context.effects.ports.invoke(
      { operation: 'note', input: inputRef },
      callContext('runtime'),
    )
    assert.equal(allowed.ok, true)
    assert.equal(forwarded, 1)
    assert.deepEqual(
      context.effects.calls().map((call) => call.operation),
      ['bill', 'note'],
    )
    return {
      id: 'assembly-effects-boundary',
      providerDigest: 'assembly-provider',
      recipe: 'fixed cordis assembly',
      features: ['read'],
      build: fixtureBuild,
      consumer: 'assembly-consumer',
      command: 'cordis assembly acceptance',
      status: 'passed',
      configDigest: 'assembly-config',
      releaseSetDigest: 'assembly-release',
      attachmentDigest: null,
      fixture: 'restricted-effects',
      sharedEvidenceId: null,
      reuse: { scope: 'run', methodKind: 'compute', lifecycle: 'call', undeclaredConnection: false },
      perImplementation: true,
      gate: null,
    }
  },
})
harness.registerCase({
  contract: 'agh.loop',
  scenario: 'select',
  qualification: 'not-advertised',
  providerId: 'reference',
  run() {
    return {
      id: 'assembly-not-advertised',
      providerDigest: 'assembly-provider',
      recipe: 'not advertised',
      features: ['read'],
      build: fixtureBuild,
      consumer: 'assembly-consumer',
      command: 'cordis assembly acceptance',
      status: 'skipped',
      configDigest: 'assembly-config',
      releaseSetDigest: 'assembly-release',
      attachmentDigest: null,
      fixture: null,
      sharedEvidenceId: null,
      perImplementation: false,
      gate: null,
    }
  },
})

const graded = await harness.run({
  contracts: ['agh.loop'],
  providers: ['reference'],
  command: 'cordis assembly acceptance',
  clock: fixtureClock,
})
assert.equal(graded.status, 'passed', JSON.stringify(graded.failures))
assert.deepEqual(graded.failures, [])
assert.equal(
  graded.assertions.filter((item) => item.qualification === 'required' && item.status === 'passed').length,
  2,
)
assert.equal(
  graded.assertions.some((item) => item.qualification === 'not-advertised' && item.status === 'skipped'),
  true,
)
assert.equal(
  graded.assertions.some((item) => item.fixture === 'runtime-inbox'),
  true,
)
assert.equal(
  graded.assertions.some((item) => item.fixture === 'restricted-effects'),
  true,
)

const emptyGrade = judgeReport({
  contracts: ['agh.loop'],
  providers: ['reference'],
  unknownContracts: [],
  command: 'cordis assembly acceptance',
  startedAt: fixtureClock.startedAt,
  finishedAt: fixtureClock.finishedAt,
  assertions: [
    {
      id: 'assembly-empty',
      contract: 'agh.loop',
      scenario: 'select',
      qualification: 'not-advertised',
      providerId: 'reference',
      providerDigest: 'assembly-provider',
      recipe: 'not advertised',
      features: ['read'],
      build: fixtureBuild,
      consumer: 'assembly-consumer',
      command: 'cordis assembly acceptance',
      startedAt: fixtureClock.startedAt,
      finishedAt: fixtureClock.finishedAt,
      status: 'skipped',
      configDigest: 'assembly-config',
      releaseSetDigest: 'assembly-release',
      attachmentDigest: null,
      fixture: null,
      sharedEvidenceId: null,
    },
  ],
})
assert.equal(emptyGrade.status, 'failed')
assert.equal(
  emptyGrade.failures.some((failure) => failure.code === 'empty-run'),
  true,
)

console.log('cordis assembly acceptance passed')
