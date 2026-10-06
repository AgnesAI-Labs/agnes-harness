import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { ResolvedMedia } from '../../src/runtime/media/resolve.js'
import {
  buildWireRequest,
  type ModelCapture,
  modelInputDigest,
  modelInputPreimage,
  type WireIdentity,
} from '../../src/runtime/model/wire-request.js'
import {
  type ResolvedTool,
  type ResolvedTools,
  TOOL_CALL_BODY_TYPE,
  TOOL_RESULT_BODY_TYPE,
  type ToolSchemaDocument,
} from '../../src/runtime/model/wire-tools.js'
import { featuresImage, mediaBinding, planOf, routeSnapshot } from './media-fixture.js'

const model: ModelRecord = {
  id: 'fixture-model',
  name: 'fixture-model',
  api: 'openai-completions',
  route: 'fixed-route',
  baseUrl: 'https://fake.invalid',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const captureFor = (api: 'openai-completions' | 'anthropic-messages', over: Partial<ModelRecord> = {}) =>
  ({
    adapterPackageDigest: 'package-1',
    route: { route: 'fixed-route', api, baseUrl: 'https://fake.invalid' },
    model: { ...model, api, ...over },
  }) as ModelCapture
const capture = captureFor('openai-completions')
const wire: WireIdentity = { sessionKey: 'session-1', slot: 'primary', contractId: null }
const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

/** A closed resolved document whose single definition is the given schema, as a schema source would publish it. */
const documentOf = (
  schema: Wire.JsonValue,
  defs: Record<string, Wire.JsonValue> = {},
): ToolSchemaDocument => ({
  $schema: SCHEMA,
  $ref: '#/$defs/Input',
  $defs: { ...defs, Input: schema },
})

type Fixture = { name: string; description: string; parameters: Wire.JsonValue }
function conformanceTools(file: string, scenario: string): Fixture[] {
  const url = new URL(`../../../ai/fixtures/conformance/${file}`, import.meta.url)
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as { scenario: string; request: { tools: Fixture[] } }
    if (row.scenario === scenario) return row.request.tools
  }
  throw new Error(`missing conformance scenario ${scenario}`)
}

type Pair = { definition: Wire.ToolDefinition; resolved: ResolvedTool }
function pairOf(name: string, description: string, schema: Wire.JsonValue, defs = {}): Pair {
  const document = documentOf(schema, defs)
  return {
    definition: {
      name,
      inputSchema: {
        typeId: `fixture.tool/${name}-input@1`,
        revision: 1,
        digest: canonicalJsonDigest(document as never),
      },
      outputSchema: runtimeAuthorSchemas.StandardToolOutput.ref,
    } as Wire.ToolDefinition,
    resolved: { name, description, document },
  }
}
const pairsOf = (fixtures: Fixture[]) => fixtures.map((f) => pairOf(f.name, f.description, f.parameters))
const catalogOf = (pairs: Pair[]): Wire.ToolCatalog => {
  const tools = pairs.map((p) => p.definition)
  return { revision: 1, digest: canonicalJsonDigest({ revision: 1, tools } as never), tools }
}
const resolvedOf = (pairs: Pair[]): ResolvedTools => pairs.map((p) => p.resolved)

const bodyRef = (typeId: string) => ({ typeId, revision: 1, digest: 'a'.repeat(64) })
function item(
  id: string,
  kind: Wire.ContextItem['kind'],
  trust: Wire.ContextItem['trust'],
  value: Wire.JsonValue,
  typeId = 't',
  toolPairRef: string | null = null,
  sourceRefs: Wire.PublicRef[] = [],
): Wire.ContextItem {
  return {
    id,
    kind,
    body: {
      kind: 'inline',
      schema: bodyRef(typeId),
      value,
      digest: canonicalJsonDigest(value as never),
      bytes: 1,
    },
    sourceRefs,
    provenance: { sourceRefs: [], producer: mediaBinding, trustLabels: [] },
    trust,
    tokenEstimate: 1,
    protected: false,
    toolPairRef,
    sourceRanges: [],
  } as Wire.ContextItem
}
const user = (text: string, sourceRefs: Wire.PublicRef[] = []) =>
  item(`u-${text}`, 'message', 'user', text, 't', null, sourceRefs)
const call = (toolUseId: string, name: string, args: Wire.JsonValue, ordinal = 0, over = {}) =>
  item(
    `c-${toolUseId}`,
    'tool-call',
    'derived',
    { toolUseId, name, args, ordinal, ...over },
    TOOL_CALL_BODY_TYPE,
    toolUseId,
  )
const result = (
  toolUseId: string,
  text: string,
  isError = false,
  trust: Wire.ContextItem['trust'] = 'external',
) =>
  item(
    `r-${toolUseId}`,
    'tool-result',
    trust,
    { toolUseId, content: [{ type: 'text', text }], isError },
    TOOL_RESULT_BODY_TYPE,
    toolUseId,
  )

function preparedWith(
  items: Wire.ContextItem[],
  catalog: Wire.ToolCatalog | null,
  over: Partial<Wire.PreparedModelRequest> = {},
): Wire.PreparedModelRequest {
  return {
    preparedId: 'prepared',
    ownerBinding: mediaBinding,
    target: { ...routeSnapshot(), model: 'fixture-model', features: { ...featuresImage, tools: true } },
    view: { viewId: 'view', items } as Wire.ContextView,
    inputDigest: 'a'.repeat(64),
    outputSchema: null,
    toolCatalog: catalog,
    generation: { maxOutputTokens: 32, thinking: null },
    mediaPlans: [],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {} as never,
    legacyRequestOverrides: null,
    credentialRef: null,
    ...over,
  } as Wire.PreparedModelRequest
}
const code = (r: ReturnType<typeof buildWireRequest>) => (r.ok ? 'ok' : r.error.detailCode)
const read = pairOf('read', 'Read a file', {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
})
function build(
  items: Wire.ContextItem[],
  pairs: Pair[] = [read],
  cap: ModelCapture = capture,
  over: Partial<Wire.PreparedModelRequest> = {},
) {
  return buildWireRequest(preparedWith(items, catalogOf(pairs), over), cap, wire, [], resolvedOf(pairs))
}
const must = (r: ReturnType<typeof buildWireRequest>) => {
  if (!r.ok) throw new Error(r.error.detailCode)
  return r.value
}

describe('schema reference digest', () => {
  it('is the canonical digest of the resolved schema document', () => {
    const root = (name: string) =>
      fileURLToPath(new URL(`../../../protocol/schema/runtime/${name}`, import.meta.url))
    const pub = JSON.parse(readFileSync(root('public.json'), 'utf8')).$defs as Record<string, Wire.JsonValue>
    const proto = JSON.parse(readFileSync(root('prototype.json'), 'utf8')).$defs as Record<
      string,
      Wire.JsonValue
    >
    const rewrite = (node: Wire.JsonValue): Wire.JsonValue =>
      Array.isArray(node)
        ? node.map(rewrite)
        : node !== null && typeof node === 'object'
          ? Object.fromEntries(
              Object.entries(node).map(([k, v]) => [
                k,
                k === '$ref' && typeof v === 'string' ? v.replace(/^[^#]*#/, '#') : rewrite(v),
              ]),
            )
          : node
    const document = {
      $schema: SCHEMA,
      $ref: '#/$defs/StandardToolOutput',
      $defs: {
        JsonValue: rewrite(proto.JsonValue as Wire.JsonValue),
        StandardToolOutput: rewrite(pub.StandardToolOutput as Wire.JsonValue),
      },
    }
    expect(canonicalJsonDigest(document as never)).toBe(RuntimeSchemaRefs.StandardToolOutput.digest)
  })

  it('rewrites the recursive JsonValue to any value and keeps the rest of the real tool schema', () => {
    const defs = {
      JsonValue: {
        anyOf: [
          { type: 'null' },
          { type: 'boolean' },
          { type: 'number' },
          { type: 'string' },
          { type: 'array', items: { $ref: '#/$defs/JsonValue' }, maxItems: 10000, minItems: 0 },
          { type: 'object', additionalProperties: { $ref: '#/$defs/JsonValue' } },
        ],
      },
    }
    const pair = pairOf(
      'text_statistics',
      'Count words',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' } } },
            maxItems: 10000,
          },
          structured: { $ref: '#/$defs/JsonValue' },
        },
        required: ['content'],
        'x-max-canonical-json-bytes': 5,
      },
      defs,
    )
    const built = must(build([user('q')], [pair]))
    expect(built.tools).toEqual([
      {
        name: 'text_statistics',
        description: 'Count words',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: {
              type: 'array',
              items: { type: 'object', properties: { text: { type: 'string' } } },
              maxItems: 10000,
            },
            structured: {},
          },
          required: ['content'],
        },
      },
    ])
  })
})

describe.each([
  ['openai-completions.jsonl', 'openai-completions'],
  ['anthropic-messages.jsonl', 'anthropic-messages'],
] as const)('wire tools from the %s conformance catalog', (file, api) => {
  const cap = captureFor(api)
  it('keeps the catalog order of six tools and the exact conformance tool shapes', () => {
    const fixtures = conformanceTools(file, 'six_tools_degrade')
    expect(fixtures).toHaveLength(6)
    const built = must(build([user('List files in src.')], pairsOf(fixtures), cap))
    expect(built.tools).toEqual(fixtures)
    expect(built.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'List files in src.' }] },
    ])
  })

  it('carries a read tool with its object parameters unchanged', () => {
    const fixtures = conformanceTools(file, 'tool_call')
    expect(must(build([user('q')], pairsOf(fixtures), cap)).tools).toEqual(fixtures)
  })

  it('renders the user, assistant tool call and tool result history of the adapter fixture', () => {
    const built = must(
      build(
        [user('hi'), call('c1', 'read', { path: 'a' }), result('c1', 'file body')],
        pairsOf(conformanceTools(file, 'tool_call')),
        cap,
      ),
    )
    expect(built.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ toolUseId: 'c1', name: 'read', args: { path: 'a' }, ordinal: 0 }],
      },
      {
        role: 'tool_result',
        toolUseId: 'c1',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      },
    ])
  })
})

describe('tool history', () => {
  it('carries a call and its result on an empty second round catalog', () => {
    const built = must(
      buildWireRequest(
        preparedWith([user('q'), call('c1', 'read', { path: 'a' }), result('c1', 'ok'), user('next')], {
          revision: 1,
          digest: canonicalJsonDigest({ revision: 1, tools: [] }),
          tools: [],
        }),
        capture,
        wire,
        [],
        [],
      ),
    )
    expect(built.tools).toEqual([])
    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'user'])
  })

  it('orders parallel calls and their results by ordinal, not by position in the view', () => {
    const built = must(
      build([
        user('q'),
        call('b', 'read', { path: 'b' }, 1),
        call('a', 'read', { path: 'a' }, 0),
        result('b', 'B'),
        result('a', 'A'),
      ]),
    )
    expect(built.messages[1]).toMatchObject({
      toolCalls: [
        { toolUseId: 'a', ordinal: 0 },
        { toolUseId: 'b', ordinal: 1 },
      ],
    })
    expect(built.messages.slice(2).map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['a', 'b'])
  })

  it('keeps the original ordinal of a call, not its position', () => {
    const built = must(build([user('q'), call('x', 'read', {}, 7), result('x', 'r')]))
    expect(built.messages[1]).toMatchObject({ toolCalls: [{ toolUseId: 'x', ordinal: 7 }] })
  })

  it('carries an error result and accepts derived trust', () => {
    const built = must(build([user('q'), call('c1', 'read', {}), result('c1', 'boom', true, 'derived')]))
    expect(built.messages[2]).toMatchObject({ role: 'tool_result', isError: true })
  })

  it('does not accept tool items on the legacy path without resolved tools', () => {
    const items = [user('q'), call('c1', 'read', {}), result('c1', 'r')]
    expect(code(buildWireRequest(preparedWith(items, null), capture, wire))).toBe('model_wire_item')
  })
})

describe('refusals by name', () => {
  const tooBig = pairOf('big', 'd', { type: 'object', properties: { p: { enum: ['x'.repeat(263000)] } } })
  const recursive = pairOf(
    'rec',
    'd',
    { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } },
    { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
  )
  const mutualRecursive = pairOf(
    'rec2',
    'd',
    { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
    {
      A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
      B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
    },
  )
  const fakeJson = pairOf(
    'fake',
    'd',
    { type: 'object', properties: { v: { $ref: '#/$defs/JsonValue' } } },
    { JsonValue: { anyOf: [{ type: 'null' }, { type: 'array', items: { $ref: '#/$defs/JsonValue' } }] } },
  )
  const q = [user('q')]
  const swap = (p: Pair, over: Partial<ResolvedTool>): Pair => ({
    ...p,
    resolved: { ...p.resolved, ...over },
  })
  const withDigest = (p: Pair, digest: string): Pair => ({
    ...p,
    definition: { ...p.definition, inputSchema: { ...p.definition.inputSchema, digest } },
  })
  const cases: [string, () => ReturnType<typeof buildWireRequest>, string][] = [
    [
      'illegal name',
      () => build(q, [pairOf('text-statistics', 'd', { type: 'object' })]),
      'model_wire_tool_name',
    ],
    [
      'name starting with a digit',
      () => build(q, [pairOf('1x', 'd', { type: 'object' })]),
      'model_wire_tool_name',
    ],
    [
      'name over 64',
      () => build(q, [pairOf('a'.repeat(65), 'd', { type: 'object' })]),
      'model_wire_tool_name',
    ],
    ['duplicate name', () => build(q, [read, read]), 'model_wire_tool_name'],
    ['empty description', () => build(q, [swap(read, { description: '' })]), 'model_wire_tool_description'],
    [
      'long description',
      () => build(q, [swap(read, { description: 'd'.repeat(4097) })]),
      'model_wire_tool_description',
    ],
    ['resolved name differs', () => build(q, [swap(read, { name: 'other' })]), 'model_wire_tool_schema'],
    ['digest mismatch', () => build(q, [withDigest(read, 'f'.repeat(64))]), 'model_wire_tool_schema'],
    ['non object root', () => build(q, [pairOf('s', 'd', { type: 'string' })]), 'model_wire_tool_schema'],
    [
      'external reference',
      () =>
        build(q, [pairOf('e', 'd', { type: 'object', properties: { p: { $ref: 'other.json#/$defs/X' } } })]),
      'model_wire_tool_schema',
    ],
    [
      'unknown keyword',
      () => build(q, [pairOf('k', 'd', { type: 'object', properties: { p: { oneOf: [] } } })]),
      'model_wire_tool_schema',
    ],
    ['self recursion', () => build(q, [recursive]), 'model_wire_tool_schema_recursive'],
    ['mutual recursion', () => build(q, [mutualRecursive]), 'model_wire_tool_schema_recursive'],
    ['JsonValue by name only', () => build(q, [fakeJson]), 'model_wire_tool_schema_recursive'],
    ['oversize parameters', () => build(q, [tooBig]), 'model_wire_tools_oversize'],
    [
      'too many tools',
      () =>
        build(
          q,
          Array.from({ length: 129 }, (_, i) => pairOf(`t${i}`, 'd', { type: 'object' })),
        ),
      'model_wire_tools_oversize',
    ],
    [
      'no native format',
      () => build(q, [read], captureFor('openai-completions', { toolCallFormats: ['text'] as never })),
      'model_wire_tool_format',
    ],
    [
      'unsupported api',
      () => build(q, [read], { ...capture, route: { ...capture.route, api: 'openai-responses' } }),
      'model_wire_tool_format',
    ],
    [
      'tools feature off',
      () =>
        build(q, [read], capture, {
          target: { ...routeSnapshot(), features: { ...featuresImage, tools: false } },
        }),
      'model_wire_tool_feature',
    ],
    [
      'catalog without resolved tools',
      () => buildWireRequest(preparedWith(q, catalogOf([read])), capture, wire),
      'model_wire_tools',
    ],
    [
      'resolved tools without catalog',
      () => buildWireRequest(preparedWith(q, null), capture, wire, [], resolvedOf([read])),
      'model_wire_tools',
    ],
    [
      'resolved length mismatch',
      () => buildWireRequest(preparedWith(q, catalogOf([read])), capture, wire, [], []),
      'model_wire_tools',
    ],
    [
      'plain text tool call body',
      () => build([user('q'), item('c', 'tool-call', 'derived', 'text')]),
      'model_wire_item',
    ],
    [
      'plain text tool result body',
      () => build([user('q'), item('r', 'tool-result', 'external', 'text')]),
      'model_wire_item',
    ],
    [
      'user trust call',
      () => build([user('q'), { ...call('c1', 'read', {}), trust: 'user' }, result('c1', 'r')]),
      'model_wire_item',
    ],
    [
      'system trust result',
      () => build([user('q'), call('c1', 'read', {}), result('c1', 'r', false, 'system')]),
      'model_wire_item',
    ],
    [
      'extra body key',
      () => build([user('q'), call('c1', 'read', {}, 0, { extra: 1 }), result('c1', 'r')]),
      'model_wire_tool_history',
    ],
    [
      'negative ordinal',
      () => build([user('q'), call('c1', 'read', {}, -1), result('c1', 'r')]),
      'model_wire_tool_history',
    ],
    [
      'illegal call name',
      () => build([user('q'), call('c1', 'a-b', {}), result('c1', 'r')]),
      'model_wire_tool_history',
    ],
    [
      'image result block',
      () =>
        build([
          user('q'),
          call('c1', 'read', {}),
          item(
            'r',
            'tool-result',
            'external',
            {
              toolUseId: 'c1',
              content: [{ type: 'image', data: 'A', mimeType: 'image/png' }],
              isError: false,
            },
            TOOL_RESULT_BODY_TYPE,
            'c1',
          ),
        ]),
      'model_wire_tool_history',
    ],
    [
      'illegal tool use id',
      () => build([user('q'), call('bad id!', 'read', {}), result('bad id!', 'r')]),
      'model_wire_tool_id',
    ],
    [
      'overlong tool use id',
      () => build([user('q'), call('i'.repeat(65), 'read', {}), result('i'.repeat(65), 'r')]),
      'model_wire_tool_id',
    ],
    ['call without result', () => build([user('q'), call('c1', 'read', {})]), 'model_wire_tool_pair'],
    ['result without call', () => build([user('q'), result('c1', 'r')]), 'model_wire_tool_pair'],
    [
      'result before call',
      () => build([user('q'), result('c1', 'r'), call('c1', 'read', {})]),
      'model_wire_tool_pair',
    ],
    [
      'duplicate id',
      () => build([user('q'), call('c1', 'read', {}, 0), call('c1', 'read', {}, 1), result('c1', 'r')]),
      'model_wire_tool_pair',
    ],
    [
      'duplicate ordinal',
      () =>
        build([
          user('q'),
          call('a', 'read', {}, 0),
          call('b', 'read', {}, 0),
          result('a', 'r'),
          result('b', 'r'),
        ]),
      'model_wire_tool_pair',
    ],
    [
      'result for another id',
      () => build([user('q'), call('a', 'read', {}), result('z', 'r')]),
      'model_wire_tool_pair',
    ],
    [
      'pair ref differs from the id',
      () => build([user('q'), { ...call('a', 'read', {}), toolPairRef: 'b' }, result('a', 'r')]),
      'model_wire_tool_pair',
    ],
    [
      'message between call and result',
      () => build([user('q'), call('a', 'read', {}), user('x'), result('a', 'r')]),
      'model_wire_tool_pair',
    ],
    [
      'thinking with native replay',
      () =>
        build([user('q'), call('a', 'read', {}), result('a', 'r')], [read], capture, {
          generation: { maxOutputTokens: 8, thinking: 'low' },
        }),
      'model_wire_tool_thinking',
    ],
  ]
  it.each(cases)('%s', (_name, run, expected) => {
    expect(code(run())).toBe(expected)
  })

  it('accepts thinking when the model does not replay it natively', () => {
    const built = build(
      [user('q'), call('a', 'read', {}), result('a', 'r')],
      [read],
      captureFor('openai-completions', { thinkingReplay: 'none' as never }),
      {
        generation: { maxOutputTokens: 8, thinking: 'low' },
      },
    )
    expect(code(built)).toBe('ok')
  })

  it('refuses a tool result as a media anchor and keeps the media refusal name', () => {
    const plan = planOf([{ marker: 1, node: 1 }], 'native')
    const ref = plan.sourceRefs[0] as { value: Wire.BlobRef }
    const anchored = { ...result('c1', 'r'), sourceRefs: [plan.sourceRefs[0] as Wire.PublicRef] }
    const media: ResolvedMedia = {
      planKey: plan.key,
      planDigest: canonicalJsonDigest(plan as never),
      mediaDigest: 'm'.repeat(64),
      trust: 'external',
      usageIds: [],
      parts: [{ kind: 'text', text: 'note', anchor: ref.value.blobId }],
    }
    const pairs = [read]
    const built = buildWireRequest(
      preparedWith([user('q'), call('c1', 'read', {}), anchored], catalogOf(pairs), { mediaPlans: [plan] }),
      capture,
      wire,
      [media],
      resolvedOf(pairs),
    )
    expect(code(built)).toBe('model_wire_media_anchor')
  })
})

describe('compatibility with the tool-less builder', () => {
  const items = [user('hello')]
  it('is byte identical when the catalog and resolved tools are both absent', () => {
    const prepared = preparedWith(items, null)
    expect(buildWireRequest(prepared, capture, wire, [], null)).toEqual(
      buildWireRequest(prepared, capture, wire),
    )
    expect(must(buildWireRequest(prepared, capture, wire)).tools).toEqual([])
  })

  it('keeps the digest of an input without tools or tool items at its frozen value', () => {
    const request = must(buildWireRequest(preparedWith(items, null), capture, wire))
    expect(request.derivedHash).toBe(FROZEN_DIGEST)
  })

  it('changes the input digest when a tool schema changes, so the tool set is covered', () => {
    const other = pairOf('read', 'Read a file', { type: 'object' })
    const a = must(build(items, [read])).derivedHash
    expect(must(build(items, [other])).derivedHash).not.toBe(a)
  })

  it('changes the input digest when only a description changes, with the schema untouched', () => {
    const schema: Wire.JsonValue = { type: 'object', properties: { path: { type: 'string' } } }
    const a = pairOf('read', 'Read a file', schema)
    const b = pairOf('read', 'Read a file from disk', schema)
    expect(a.definition).toEqual(b.definition)
    expect(must(build(items, [b])).derivedHash).not.toBe(must(build(items, [a])).derivedHash)
  })

  it('binds the descriptions without adding a preimage field, and the digest equals the builder hash', () => {
    const prepared = preparedWith(items, catalogOf([read]))
    const bare = Object.keys(modelInputPreimage(prepared, capture, wire) as object).sort()
    const tooled = modelInputPreimage(prepared, capture, wire, resolvedOf([read])) as Record<string, unknown>
    expect(Object.keys(tooled).sort()).toEqual(bare)
    expect(must(build(items, [read])).derivedHash).toBe(
      modelInputDigest(prepared, capture, wire, resolvedOf([read])),
    )
    expect(modelInputDigest(prepared, capture, wire, resolvedOf([read]))).not.toBe(
      modelInputDigest(prepared, capture, wire),
    )
  })
})

const FROZEN_DIGEST = '348f0a97b827c9e7dc1aa2969623cc641b95cb6ee577aea0bbe002995e35a583'
