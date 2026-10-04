import type {
  EmptyAuthorConfig,
  InterceptorDefinition,
  ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema, defineInterceptor } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { ContextReturn, ToolCallReturn } from '@agnes/protocol/gen/hooks'
import {
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import * as Core from '../../src/index.js'
import {
  type PureHookRegistration,
  type PureHookStage,
  runPureHookStage,
} from '../../src/runtime/hooks/stages.js'
import { createDefaultEffectsFactory } from '../../src/runtime/providers/effects.js'

const closed = { additionalProperties: false } as const
const section = {
  type: 'object',
  ...closed,
  required: ['id', 'order', 'text'],
  properties: {
    id: { type: 'string', maxLength: 64 },
    order: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    text: { type: 'string', maxLength: 65536 },
  },
}
const contextCodec = defineGeneratedAuthorSchema<ContextReturn>({
  ownerPackageId: 'effects-fixture',
  name: 'ContextOutput',
  typeId: 'effects-fixture/context-output@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/ContextOutput',
    $defs: {
      ContextOutput: {
        type: 'object',
        ...closed,
        required: [],
        properties: {
          sections: { type: 'array', maxItems: 10000, items: section },
          additionalContext: { type: 'string', maxLength: 8192 },
        },
      },
    },
  },
})
const toolCodec = defineGeneratedAuthorSchema<ToolCallReturn>({
  ownerPackageId: 'effects-fixture',
  name: 'ToolOutput',
  typeId: 'effects-fixture/tool-output@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/ToolOutput',
    $defs: {
      ToolOutput: {
        anyOf: [
          { type: 'object', ...closed, required: ['allow'], properties: { allow: { const: true } } },
          {
            type: 'object',
            ...closed,
            required: ['allow', 'reason'],
            properties: { allow: { const: false }, reason: { type: 'string', maxLength: 1024 } },
          },
        ],
      },
    },
  },
})
const configCodec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
  ownerPackageId: 'effects-fixture',
  name: 'EmptyConfig',
  typeId: 'effects-fixture/empty-config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/EmptyConfig',
    $defs: { EmptyConfig: { type: 'object', ...closed, required: [], properties: {} } },
  },
})
const contextInput = defineGeneratedAuthorSchema<JsonValue>({
  ownerPackageId: 'effects-fixture',
  name: 'ContextInput',
  typeId: 'effects-fixture/context-input@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/ContextInput',
    $defs: {
      ContextInput: {
        type: 'object',
        ...closed,
        required: ['sections', 'surfaceDigest'],
        properties: {
          sections: { type: 'array', maxItems: 10000, items: section },
          surfaceDigest: {
            type: 'object',
            ...closed,
            required: ['nodes', 'tokensEstimate'],
            properties: {
              nodes: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
              tokensEstimate: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
            },
          },
        },
      },
    },
  },
})
const toolInput = defineGeneratedAuthorSchema<JsonValue>({
  ownerPackageId: 'effects-fixture',
  name: 'ToolInput',
  typeId: 'effects-fixture/tool-input@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/ToolInput',
    $defs: {
      ToolInput: {
        type: 'object',
        ...closed,
        required: ['toolUseId', 'name', 'args', 'meta', 'actor', 'taint'],
        properties: {
          toolUseId: { type: 'string' },
          name: { type: 'string' },
          args: { type: 'object', ...closed, required: [], properties: {} },
          taint: { type: 'boolean' },
          actor: {
            type: 'object',
            ...closed,
            required: ['id', 'org', 'role', 'deptPath', 'attrs'],
            properties: {
              id: { type: 'string' },
              org: { type: 'string' },
              role: { type: 'string' },
              deptPath: { type: 'array', items: { type: 'string' } },
              attrs: { type: 'object', ...closed, required: [], properties: {} },
            },
          },
          meta: {
            type: 'object',
            ...closed,
            required: [
              'isReadOnly',
              'isDestructive',
              'isConcurrencySafe',
              'isOpenWorld',
              'replay',
              'costHint',
              'deferLoading',
              'requiresApproval',
            ],
            properties: {
              isReadOnly: { type: 'boolean' },
              isDestructive: { type: 'boolean' },
              isConcurrencySafe: { type: 'boolean' },
              isOpenWorld: { type: 'boolean' },
              replay: { enum: ['safe', 'never', 'idempotent'] },
              costHint: { type: 'null' },
              deferLoading: { type: 'null' },
              requiresApproval: { type: 'null' },
            },
          },
        },
      },
    },
  },
})
const binding = {
  contract: 'agh.effects',
  providerId: 'default.effects',
  logicalName: 'primary',
  bindingId: 'effects-binding',
}
function encoded<T>(
  codec: { encode(value: T): import('@agnes/extension-api/runtime').Outcome<DataRef> },
  value: T,
): DataRef {
  const result = codec.encode(value)
  if (!result.ok) throw new Error('Fixture codec failed')
  return result.value
}
function contextDefinition(
  id: string,
  handle: Extract<InterceptorDefinition<'context', JsonValue>, { execution: 'pure' }>['handle'],
  extra: Partial<
    Omit<
      Extract<InterceptorDefinition<'context', JsonValue>, { execution: 'pure' }>,
      'event' | 'execution' | 'handle' | 'id'
    >
  > = {},
) {
  return defineInterceptor<'context', JsonValue>({
    id,
    event: 'context',
    execution: 'pure',
    readFields: ['/sections'],
    writeFields: ['/sections', '/additionalContext'],
    permissions: [],
    handle,
    ...extra,
  })
}
function toolDefinition(
  id: string,
  handle: Extract<InterceptorDefinition<'tool_call', JsonValue>, { execution: 'pure' }>['handle'],
  extra: Partial<
    Omit<
      Extract<InterceptorDefinition<'tool_call', JsonValue>, { execution: 'pure' }>,
      'event' | 'execution' | 'handle' | 'id'
    >
  > = {},
) {
  return defineInterceptor<'tool_call', JsonValue>({
    id,
    event: 'tool_call',
    execution: 'pure',
    readFields: ['/name'],
    writeFields: ['/allow', '/reason'],
    permissions: [],
    handle,
    ...extra,
  })
}
function registration(definition: PureHookRegistration['definition'], ordinal: number): PureHookRegistration {
  const event = definition.event
  const metadata = {
    id: definition.id,
    event,
    category: event === 'context' ? ('transform' as const) : ('directive' as const),
    phase: 'before' as const,
    priority: definition.priority ?? 0,
    before: [...(definition.before ?? [])],
    after: [...(definition.after ?? [])],
    mandatory: definition.mandatory ?? false,
    failPolicy: definition.failPolicy ?? 'open',
    timeoutMs: definition.timeoutMs ?? 1000,
    readFields: [...definition.readFields],
    writeFields: [...definition.writeFields],
    permissions: [...definition.permissions],
    execution: 'pure' as const,
    effects: [],
    configSchema: configCodec.ref,
    handler: { entry: './hooks.js', export: definition.id },
  }
  const checked = validateRuntime('InterceptorRegistration', metadata)
  if (!checked.ok) throw new Error('Invalid fixture registration')
  return {
    definition,
    metadata: checked.value,
    config: {},
    snapshot: {
      registrationId: definition.id,
      provider: binding,
      codeDigest: 'a'.repeat(64),
      ordinal,
      mode: 'waterfall',
      category: metadata.category,
      failPolicy: metadata.failPolicy,
      replayOnResume: false,
      timeoutMs: metadata.timeoutMs,
    },
  }
}
function stage(registrations: PureHookRegistration[]): PureHookStage {
  const event = registrations[0]?.definition.event ?? 'context'
  const input =
    event === 'context'
      ? encoded(contextInput, {
          sections: [{ id: 'base', order: 0, text: 'original' }],
          surfaceDigest: { nodes: 1, tokensEstimate: 2 },
        })
      : encoded(toolInput, {
          toolUseId: 'tool-id',
          name: 'read',
          args: {},
          meta: {
            isReadOnly: true,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: false,
            replay: 'safe',
            costHint: null,
            deferLoading: null,
            requiresApproval: null,
          },
          actor: { id: 'actor', org: '', role: '', deptPath: [], attrs: {} },
          taint: false,
        })
  const snapshot = {
    workspaceId: 'workspace',
    configRevision: 1,
    event,
    registrations: registrations.map((entry) => entry.snapshot),
  }
  const effective = { ...snapshot, digest: canonicalJsonDigest(snapshot) }
  return {
    request: {
      stageId: 'stage',
      event,
      owner: { runId: 'run', actionId: 'business-action', requestId: 'request' },
      registrationDigest: effective.digest,
      input,
      inputDigest: canonicalJsonDigest(input),
    },
    effective,
    registrations,
    sourceActionId: 'stage-action',
    invocation: {
      runId: 'run',
      actionId: 'business-action',
      requestId: 'request',
      stageId: 'stage',
      receiptId: null,
      attempt: null,
    },
    access: {
      readFields: [...new Set(registrations.flatMap((entry) => entry.metadata.readFields))],
      writeFields: [...new Set(registrations.flatMap((entry) => entry.metadata.writeFields))],
      permissions: [],
    },
    codecs: { context: contextCodec, tool_call: toolCodec },
    signal: new AbortController().signal,
  }
}
const value = (ref: DataRef) => {
  if (ref.kind !== 'inline') throw new Error('Unexpected blob')
  return ref.value
}

describe('pure runtime Hook stage algorithm (no State or execution authority)', () => {
  it('keeps original sections not overridden by contribution id', async () => {
    const input = stage([
      registration(
        contextDefinition('contribute', () => ({ sections: [{ id: 'added', order: 1, content: 'new' }] })),
        0,
      ),
    ])
    const result = await runPureHookStage(input)
    expect(result.outcome).toBe('completed')
    expect(value(result.result.output)).toEqual({
      sections: [
        { id: 'base', order: 0, text: 'original' },
        { id: 'added', order: 1, text: 'new' },
      ],
    })
  })
  it('retains actual author projections, runs fixed waterfall order and closes result digests', async () => {
    const calls: string[] = []
    const a = registration(
      contextDefinition('first', (input, context) => {
        calls.push('first')
        expect(Object.isFrozen(input)).toBe(true)
        expect(input.sections?.[0]?.content).toBe('original')
        expect('surfaceDigest' in input).toBe(false)
        expect('effects' in context).toBe(false)
        return { sections: [{ id: 'base', order: 0, content: 'changed' }] }
      }),
      0,
    )
    const b = registration(
      contextDefinition(
        'second',
        (input) => {
          calls.push('second')
          expect(input.sections?.[0]?.content).toBe('changed')
          return { additionalContext: 'note' }
        },
        { after: ['first'] },
      ),
      1,
    )
    const input = stage([b, a]),
      result = await runPureHookStage(input)
    expect(calls).toEqual(['first', 'second'])
    expect(result.outcome).toBe('completed')
    expect(value(result.result.output)).toEqual({
      sections: [{ id: 'base', order: 0, text: 'changed' }],
      additionalContext: 'note',
    })
    expect(value(input.request.input)).toMatchObject({ sections: [{ text: 'original' }] })
    expect(result.result.sourceActionId).toBe('stage-action')
    const { digest, ...body } = result.result
    expect(digest).toBe(canonicalJsonDigest(body))
    expect(validateRuntime('HookResultSet', result.result).ok).toBe(true)
  })
  it('keeps mandatory deny when later high-priority allow executes', async () => {
    let count = 0
    const input = stage([
      registration(
        toolDefinition('deny', () => ({ allow: false, reason: 'blocked' }), { priority: -1 }),
        0,
      ),
      registration(
        toolDefinition(
          'allow',
          () => {
            count++
            return { allow: true }
          },
          { priority: 100 },
        ),
        1,
      ),
    ])
    const result = await runPureHookStage(input)
    expect(count).toBe(1)
    expect(result.outcome).toBe('denied')
    expect(value(result.result.output)).toEqual({ allow: false, reason: 'blocked' })
    expect(result.result.entries[0]?.outcome).toBe('denied')
  })
  it('preserves fixed candidate evidence while actual context closed failure blocks success', async () => {
    const fail = () => {
      throw new Error('private raw text must not escape')
    }
    const input = stage([registration(contextDefinition('failed', fail), 0)])
    const result = await runPureHookStage(input)
    expect(result.outcome).toBe('denied')
    expect(result.result.entries[0]?.outcome).toBe('denied')
    expect(jcs(result)).not.toContain('private raw')
    expect(value(result.result.output)).toEqual({ sections: [{ id: 'base', order: 0, text: 'original' }] })
    const closedStage = stage([
      registration(contextDefinition('closed', fail, { failPolicy: 'closed', mandatory: true }), 0),
    ])
    expect((await runPureHookStage(closedStage)).outcome).toBe('denied')
  })
  it('copies and freezes inputs, rejects undeclared writes without altering the original', async () => {
    const entry = registration(
      contextDefinition(
        'writer',
        (input) => {
          expect(() => {
            if (input.sections?.[0]) Object.assign(input.sections[0], { content: 'mutated' })
          }).toThrow()
          return { additionalContext: 'forbidden' }
        },
        { writeFields: ['/sections'], failPolicy: 'closed', mandatory: true },
      ),
      0,
    )
    const input = stage([entry]),
      result = await runPureHookStage(input)
    expect(result.outcome).toBe('denied')
    expect(value(input.request.input)).toMatchObject({ sections: [{ text: 'original' }] })
  })
  it('rejects missing mandatory registration, cycles and unproven read access before handlers', async () => {
    let count = 0
    const base = stage([
      registration(
        contextDefinition('only', () => {
          count++
          return {}
        }),
        0,
      ),
    ])
    await expect(runPureHookStage({ ...base, registrations: [] })).rejects.toThrow()
    await expect(runPureHookStage({ ...base, access: { ...base.access, readFields: [] } })).rejects.toThrow()
    const cycle = stage([
      registration(
        contextDefinition(
          'a',
          () => {
            count++
            return {}
          },
          { before: ['b'] },
        ),
        0,
      ),
      registration(
        contextDefinition(
          'b',
          () => {
            count++
            return {}
          },
          { before: ['a'] },
        ),
        1,
      ),
    ])
    await expect(runPureHookStage(cycle)).rejects.toThrow()
    expect(count).toBe(0)
  })
  it('rejects payload digest substituted for full DataRef and wrong invocation before handlers', async () => {
    let count = 0
    const input = stage([
      registration(
        contextDefinition('only', () => {
          count++
          return {}
        }),
        0,
      ),
    ])
    if (input.request.input.kind !== 'inline') throw new Error('Wrong fixture input')
    await expect(
      runPureHookStage({ ...input, request: { ...input.request, inputDigest: input.request.input.digest } }),
    ).rejects.toThrow()
    await expect(
      runPureHookStage({ ...input, invocation: { ...input.invocation, actionId: 'foreign' } }),
    ).rejects.toThrow()
    await expect(
      runPureHookStage({ ...input, effective: { ...input.effective, digest: 'b'.repeat(64) } }),
    ).rejects.toThrow()
    expect(count).toBe(0)
  })
  it('bounds closed timeout and ignores late result; cancellation never emits a result', async () => {
    let release: (() => void) | undefined
    const input = stage([
      registration(
        contextDefinition(
          'slow',
          () =>
            new Promise((resolve) => {
              release = () => resolve({ additionalContext: 'late' })
            }),
          { timeoutMs: 1 },
        ),
        0,
      ),
    ])
    const result = await runPureHookStage(input)
    release?.()
    await Promise.resolve()
    expect(result.outcome).toBe('denied')
    expect(value(result.result.output)).not.toHaveProperty('additionalContext')
    const abort = new AbortController()
    abort.abort()
    await expect(runPureHookStage({ ...input, signal: abort.signal })).rejects.toMatchObject({
      error: { code: 'cancelled' },
    })
  })
  it('rejects cloned output codecs before handlers and retains stage identity across handler mutation', async () => {
    let calls = 0
    const input = stage([
      registration(
        contextDefinition('first', () => {
          calls++
          return {}
        }),
        0,
      ),
    ])
    await expect(
      runPureHookStage({ ...input, codecs: { ...input.codecs, context: { ...contextCodec } } }),
    ).rejects.toThrow()
    expect(calls).toBe(0)
    let changing: PureHookStage | undefined,
      replacedCodecCalls = 0
    const second = registration(
      contextDefinition('second', () => {
        throw new Error('closed')
      }),
      1,
    )
    const first = registration(
      contextDefinition('first', () => {
        Object.defineProperty(second.metadata, 'failPolicy', { value: 'open' })
        if (!changing) throw new Error('Missing fixture stage')
        Object.defineProperty(changing.request, 'stageId', { value: 'changed-stage' })
        Object.defineProperty(changing.codecs, 'context', {
          value: {
            ...contextCodec,
            encode: (output: ContextReturn) => {
              replacedCodecCalls++
              return contextCodec.encode(output)
            },
          },
        })
        return {}
      }),
      0,
    )
    changing = stage([first, second])
    const result = await runPureHookStage(changing)
    expect(result.outcome).toBe('denied')
    expect(result.result.stageId).toBe('stage')
    expect(result.result.entries[1]?.outcome).toBe('denied')
    expect(replacedCodecCalls).toBe(0)
    expect(result.result.entries[0]?.outcome).toBe('applied')
  })
  it('rejects forged open policy for closed events before any handler', async () => {
    let calls = 0
    const original = registration(
      contextDefinition('only', () => {
        calls++
        return {}
      }),
      0,
    )
    const metadata = { ...original.metadata }
    Object.defineProperty(metadata, 'failPolicy', { value: 'open', enumerable: true })
    const input = stage([{ ...original, metadata }])
    await expect(runPureHookStage(input)).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it('rejects parallel registration and unsupported event without invoking handlers', async () => {
    let count = 0
    const original = registration(
      contextDefinition('only', () => {
        count++
        return {}
      }),
      0,
    )
    const input = stage([{ ...original, snapshot: { ...original.snapshot, mode: 'parallel' } }])
    await expect(runPureHookStage(input)).rejects.toMatchObject({ error: { code: 'incompatible' } })
    const valid = stage([original])
    await expect(
      runPureHookStage({ ...valid, request: { ...valid.request, event: 'shutdown' } }),
    ).rejects.toMatchObject({ error: { code: 'incompatible' } })
    expect(count).toBe(0)
  })
})

const refs = RuntimeMethodSchemaRefs['agh.effects']
const descriptor: ProviderDescriptor = {
  providerId: binding.providerId,
  contract: binding.contract,
  logicalName: binding.logicalName,
  major: 1,
  packageVersion: '1.0.0',
  packageDigest: 'a'.repeat(64),
  features: [],
  scope: 'session',
  configSchema: configCodec.ref,
  requires: [],
  capabilities: [],
  recovery: 'R0',
  isolation: ['trusted-in-process'],
  stateCodecs: [],
  activationMode: 'eager',
  operations: Object.entries(RuntimeServiceCatalog['agh.effects'].methods).map(([method, definition]) => {
    const schema = refs[method as keyof typeof refs]
    return {
      method,
      kind: definition.kind,
      inputSchema: schema.input,
      outputSchema: schema.output,
      requiredCapabilities: [],
      retrySafety: 'idempotent' as const,
    }
  }),
}
const dependencies: ScopedDependencies = {
  get: () => {
    throw new Error('No hidden dependency')
  },
  openScope: async () => {
    throw new Error('No hidden scope')
  },
  close: async () => undefined,
}
describe('default Effects factory ABI scaffold', () => {
  it('rejects execution readiness and controls until a genuine stage owner is installed', async () => {
    expect(Core.createDefaultEffectsFactory).toBe(createDefaultEffectsFactory)
    expect('assertAuthorSchema' in Core).toBe(false)
    const factory = createDefaultEffectsFactory(descriptor, configCodec)
    const signal = new AbortController().signal
    const scope = {
      kind: 'session',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    } as const
    const provider = await factory.create(encoded(configCodec, {}), dependencies, {
      instanceId: 'effects-instance',
      bindingId: binding.bindingId,
      scope,
      signal,
    })
    const call = {
      bindingId: binding.bindingId,
      scope,
      principalRef: 'principal',
      authorizationRef: 'authorization',
      invocationId: 'invocation',
      deadline: '2026-10-05T00:00:00Z',
      traceRef: 'trace',
      signal,
    }
    expect(await provider.ready(call)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'effects_stage_source_unavailable' },
    })
    expect(await provider.health(call)).toMatchObject({ ok: true, value: { status: 'degraded' } })
    expect(Object.keys(provider.actions ?? {})).toEqual(['runHooks'])
    const actionFactory = provider.actions?.runHooks
    if (!actionFactory) throw new Error('Missing official action factory')
    const action = await actionFactory.create({
      instanceId: 'effects-action',
      actionId: 'stage-action',
      runId: 'run',
      bindingId: binding.bindingId,
      scope,
      signal,
    })
    expect(await action.ready(call)).toMatchObject({
      ok: false,
      error: { detailCode: 'effects_stage_source_unavailable' },
    })
    if (!provider.control) throw new Error('Missing official control')
    expect(
      await provider.control({ target: binding, method: 'dispatch', input: encoded(configCodec, {}) }, call),
    ).toMatchObject({ ok: false, error: { code: 'incompatible' } })
    await provider.close('completed')
    expect((await provider.ready(call)).ok).toBe(false)
  })
  it('rejects incomplete/misassigned method ABI and forged config codec', () => {
    expect(() =>
      createDefaultEffectsFactory({ ...descriptor, operations: descriptor.operations.slice(1) }, configCodec),
    ).toThrow()
    expect(() => createDefaultEffectsFactory({ ...descriptor, contract: 'agh.usage' }, configCodec)).toThrow()
    expect(() => createDefaultEffectsFactory(descriptor, { ...configCodec })).toThrow()
  })
})
