import assert from 'node:assert/strict'
import { HOOK_TABLE } from '../../../../packages/extension-api/src/index.js'
import {
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

console.log('cordis assembly acceptance passed')
