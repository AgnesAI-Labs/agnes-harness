import type { ModelWireSource } from '@agnes/ai/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { modelTool } from '../../../core/src/runtime/loop/default-plan.js'
import { TOOL_CALL_BODY_TYPE, TOOL_RESULT_BODY_TYPE } from '../../../core/src/runtime/model/wire-tools.js'
import { entryOf, inlineRef, openModel } from '../../../core/test/runtime/model-deployment-fixture.js'
import {
  callContext,
  fixtureOwner,
  prepareRequest,
  textItem,
} from '../../../core/test/runtime/model-fixture.js'
import {
  resolverOf,
  standardTool,
  standardToolDocument,
  toolCatalogOf,
} from '../../../core/test/runtime/model-tools-fixture.js'
import { modelJointFixture } from './model-joint-fixture.js'

/**
 * What a tool-carrying request does on the two real wires, observed on a loopback peer. The request is
 * prepared by the real Model service (resolver port, wire builder), sent by the real ModelAdapter through
 * the Pi wire adapters and the Host restricted egress, and the peer records the bytes it read and streams
 * tool calls back. Nothing here proves a real provider accepts a request: those cells stay unverified.
 * Nothing here runs the Loop; the Loop's `modelTool` is only fed what the adapter returned.
 */
const APIS = ['openai-completions', 'anthropic-messages'] as const
// biome-ignore lint/suspicious/noExplicitAny: the bytes the peer read are parsed JSON of a provider shape this probe records
type Peek = any
type Api = (typeof APIS)[number]
type Pair = ReturnType<typeof standardTool>
type Reply = { id: string; name: string; arguments: string }

function pair(
  id: string,
  kind: W.ContextItem['kind'],
  trust: W.ContextItem['trust'],
  typeId: string,
  value: W.JsonValue,
): W.ContextItem {
  return {
    ...textItem('user', 'x'),
    id,
    kind,
    trust,
    toolPairRef: (value as { toolUseId: string }).toolUseId,
    body: {
      kind: 'inline',
      schema: { typeId, revision: 1, digest: 'a'.repeat(64) },
      value,
      digest: canonicalJsonDigest(value as never),
      bytes: 1,
    },
  } as W.ContextItem
}
const doc = (text: string) => ({ content: [{ type: 'text', text }] })
const call = (toolUseId: string, name: string, args: W.JsonValue, ordinal = 0) =>
  pair(`c-${toolUseId}`, 'tool-call', 'derived', TOOL_CALL_BODY_TYPE, { toolUseId, name, args, ordinal })
const result = (toolUseId: string, texts: string[], isError = false) =>
  pair(`r-${toolUseId}`, 'tool-result', 'external', TOOL_RESULT_BODY_TYPE, {
    toolUseId,
    content: texts.map((text) => ({ type: 'text', text })),
    isError,
  })
const user = (text: string) => textItem('user', text)
/** The Loop consumer's refusal carries its detail code on `error`, not in the message. */
const refused = (detailCode: string) =>
  expect.objectContaining({ error: expect.objectContaining({ detailCode }) })

/** Prepares through the real Model service on the template's own route; returns the raw outcome and the entry. */
async function prepareRaw(
  template: ModelWireSource,
  items: W.ContextItem[],
  tools: Pair[] | null,
  resolver = true,
) {
  const pick = {
    route: { route: template.route.route, api: template.route.api, baseUrl: template.route.baseUrl },
    model: template.model,
  }
  const model = await openModel({
    catalog: {
      capture: () => ({
        ok: true,
        value: { digest: canonicalJsonDigest({ routes: [pick] } as never) as string, select: () => pick },
      }),
    },
    adapters: { select: (binding) => ({ binding, packageDigest: 'package-1' }) },
    ...(tools && resolver ? { tools: resolverOf(tools.map((t) => t.resolved)) } : {}),
  })
  const request = prepareRequest({
    route: { ...template.prepared.target, features: { ...template.prepared.target.features, tools: true } },
    credentialRef: template.prepared.credentialRef as W.SecretHandle,
    view: { ...prepareRequest().view, items },
    ...(tools ? { toolCatalog: toolCatalogOf(tools.map((t) => t.definition)) } : {}),
  })
  const done = await model.provider.compute?.(
    {
      target: fixtureOwner,
      method: 'prepare',
      input: inlineRef(RuntimeMethodSchemaRefs['agh.model'].prepare.input, request),
    },
    callContext(),
  )
  if (!done) throw new Error('compute missing')
  if (!done.ok) return { refusal: done.error.detailCode as string }
  if (done.value.kind !== 'inline') throw new Error('not inline')
  const out = validateRuntime('ModelPrepareResult', done.value.value)
  if (!out.ok) throw new Error('bad prepare result')
  const entry = entryOf(model.deployment, out.value.preparedRef)
  return {
    source: {
      ...template,
      prepared: structuredClone(entry.prepared),
      request: structuredClone(entry.request),
    } as ModelWireSource,
  }
}

type Scenario = { items: () => W.ContextItem[]; tools: Pair[]; reply?: Reply[] }
const text = standardTool('text_statistics', 'Count the words of a text')
const other = standardTool('other_tool', 'Another tool')
const long = 'x'.repeat(64)
const rootKeys = (() => {
  const document = {
    ...standardToolDocument(),
    $ref: '#/$defs/Input',
    $defs: {
      Input: {
        type: 'object',
        title: 'Root title',
        description: 'Root description',
        properties: { a: { type: 'string', description: 'field', minLength: 1 } },
        required: ['a'],
        additionalProperties: false,
        minProperties: 1,
        maxProperties: 3,
      },
    },
  }
  return standardTool('root_keys', 'Root keywords', document)
})()
const SCENARIOS: Record<string, Scenario> = {
  // One catalog tool; the second round history is one call and its result; the peer answers with one call.
  single: {
    items: () => [user('q'), call('c1', 'text_statistics', doc('a b'), 0), result('c1', ['two'])],
    tools: [text],
    reply: [
      { id: 'call_1', name: 'text_statistics', arguments: '{"content":[{"type":"text","text":"x y"}]}' },
    ],
  },
  parallel: {
    items: () => [
      user('q'),
      call('a', 'text_statistics', doc('A'), 0),
      call('b', 'other_tool', doc('B'), 1),
      result('a', ['A!']),
      result('b', ['B failed'], true),
      user('next'),
    ],
    tools: [text, other],
    reply: [
      { id: 'p1', name: 'text_statistics', arguments: '{"content":[]}' },
      { id: 'p2', name: 'other_tool', arguments: '{"content":[]}' },
    ],
  },
  empty: {
    items: () => [user('q'), call('a', 'text_statistics', doc('A'), 0), result('a', ['A!'])],
    tools: [],
  },
  ids: {
    items: () => [
      user('q'),
      call(long, 'text_statistics', doc('A'), 0),
      result(long, ['A!']),
      call('a-b_C9', 'text_statistics', doc('B'), 0),
      result('a-b_C9', ['B!']),
    ],
    tools: [text],
    reply: [{ id: 'y'.repeat(70), name: 'text_statistics', arguments: '{}' }],
  },
  malformed: {
    items: () => [user('q')],
    tools: [text],
    reply: [{ id: 'z1', name: 'text_statistics', arguments: '{bad json' }],
  },
  unknown: {
    items: () => [user('q')],
    tools: [text],
    reply: [{ id: 'z1', name: 'not_in_catalog', arguments: '{}' }],
  },
  blocks: {
    items: () => [user('q'), call('c1', 'text_statistics', doc('A'), 0), result('c1', ['one', 'two'])],
    tools: [text],
  },
  root: { items: () => [user('q')], tools: [rootKeys] },
}

type Round = Awaited<ReturnType<typeof round>>
async function round(api: Api, scenario: Scenario) {
  const f = await modelJointFixture(api, 'normal', {}, true, {
    store: true,
    source: async (template) => {
      const prepared = await prepareRaw(template, scenario.items(), scenario.tools)
      if (!prepared.source) throw new Error(prepared.refusal)
      return prepared.source
    },
    ...(scenario.reply ? { reply: { toolCalls: scenario.reply } } : {}),
  })
  const effect = await f.execute()
  const observed = f.observations[0]
  const value = effect.result?.kind === 'inline' ? (effect.result.value as Record<string, unknown>) : null
  const output = (value?.outputRef as { value: W.StandardToolOutput } | undefined)?.value
  if (!output) throw new Error(`No model output: ${effect.outcome} ${effect.error?.detailCode}`)
  return {
    f,
    effect,
    peers: f.observations.length,
    raw: observed?.body ?? '',
    body: JSON.parse(observed?.body ?? 'null') as Record<string, Peek>,
    output,
    finish: value?.finishReason as string | undefined,
    sourceTools: f.source.request.tools,
    definitions: scenario.tools.map((t) => t.definition),
  }
}

/** The inlined StandardToolOutput parameters the builder disclosed for the real tool document. */
const STANDARD_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { type: { const: 'text' }, text: { type: 'string' } },
        required: ['type', 'text'],
      },
      maxItems: 10000,
    },
    structured: {},
  },
  required: ['content'],
}
const { additionalProperties: _root, ...WITHOUT_ROOT_CLOSURE } = STANDARD_PARAMETERS

describe.each(APIS)('tool-carrying request over the %s wire, observed on the loopback peer', (api) => {
  const rounds = new Map<string, Round>()
  beforeAll(async () => {
    // One at a time: each round starts a real service chain and a loopback peer.
    for (const [name, scenario] of Object.entries(SCENARIOS)) rounds.set(name, await round(api, scenario))
  }, 300_000)
  afterAll(async () => {
    for (const r of rounds.values()) await r.f.close()
  })
  const at = (name: string) => rounds.get(name) as Round

  describe('cell 1: the tool catalog as the peer read it', () => {
    it('sent exactly one request that carries the catalog, answered 200 and passed the fence', () => {
      const r = at('single')
      expect(r.peers).toBe(1)
      expect(r.effect.outcome).toBe('succeeded')
      expect(r.f.observations[0]?.correctKey).toBe(true)
      expect(r.sourceTools.map((t) => t.name)).toEqual(['text_statistics'])
    })

    if (api === 'openai-completions')
      it('carries name, description and the disclosed parameters unchanged in a function wrapper', () => {
        expect(at('single').body.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'text_statistics',
              description: 'Count the words of a text',
              parameters: STANDARD_PARAMETERS,
            },
          },
        ])
        expect(at('single').body.tools[0].function.parameters).toEqual(
          at('single').sourceTools[0]?.parameters,
        )
      })
    else {
      it('carries name and description, adds eager_input_streaming and a cache marker on the last tool', () => {
        const [only] = at('single').body.tools
        expect(only).toMatchObject({
          name: 'text_statistics',
          description: 'Count the words of a text',
          eager_input_streaming: true,
          cache_control: { type: 'ephemeral' },
        })
        expect(Object.keys(only).sort()).toEqual([
          'cache_control',
          'description',
          'eager_input_streaming',
          'input_schema',
          'name',
        ])
      })
      it('PIN current behaviour: input_schema loses the root additionalProperties the builder disclosed', () => {
        const [only] = at('single').body.tools
        expect(only.input_schema).toEqual(WITHOUT_ROOT_CLOSURE)
        expect(only.input_schema.additionalProperties).toBeUndefined()
        // Nested objects keep their closure: only the root is rebuilt from type, properties and required.
        expect(only.input_schema.properties.content.items.additionalProperties).toBe(false)
      })
      it.fails('EXPECTED RED: input_schema equals the parameters the builder disclosed', () => {
        expect(at('single').body.tools[0].input_schema).toEqual(at('single').sourceTools[0]?.parameters)
      })
    }

    it('keeps the catalog order, and on the Anthropic wire marks only the last tool', () => {
      const names = at('parallel').body.tools.map((t: Peek) => t.name ?? t.function.name)
      expect(names).toEqual(['text_statistics', 'other_tool'])
      if (api === 'anthropic-messages')
        expect(at('parallel').body.tools.map((t: Peek) => t.cache_control)).toEqual([
          undefined,
          { type: 'ephemeral' },
        ])
    })

    it('PIN current behaviour: other root keywords of a tool schema as the wire shows them', () => {
      const [only] = at('root').body.tools
      const schema = api === 'openai-completions' ? only.function.parameters : only.input_schema
      if (api === 'openai-completions')
        expect(schema).toEqual({
          type: 'object',
          title: 'Root title',
          description: 'Root description',
          properties: { a: { type: 'string', description: 'field', minLength: 1 } },
          required: ['a'],
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 3,
        })
      else
        expect(schema).toEqual({
          type: 'object',
          properties: { a: { type: 'string', description: 'field', minLength: 1 } },
          required: ['a'],
        })
    })
  })

  describe('cell 2: paired history after Pi normalizeContext', () => {
    it('serialises a call and its result as the provider formats require, ids paired', () => {
      const { messages } = at('single').body
      if (api === 'openai-completions')
        expect(messages.slice(1)).toEqual([
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'text_statistics',
                  arguments: '{"content":[{"text":"a b","type":"text"}]}',
                },
              },
            ],
          },
          { role: 'tool', content: 'two', tool_call_id: 'c1' },
        ])
      else
        expect(messages.slice(1)).toEqual([
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'c1',
                name: 'text_statistics',
                input: { content: [{ text: 'a b', type: 'text' }] },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'c1',
                content: 'two',
                is_error: false,
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ])
    })

    it('puts parallel calls into one assistant message in ordinal order, results in the same order', () => {
      const { messages } = at('parallel').body
      if (api === 'openai-completions') {
        expect(messages.map((m: Peek) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
        expect(messages[1].tool_calls.map((c: Peek) => c.id)).toEqual(['a', 'b'])
        expect(messages.slice(2, 4).map((m: Peek) => m.tool_call_id)).toEqual(['a', 'b'])
      } else {
        // Pi merges the adjacent results into the one user message Anthropic requires.
        expect(messages.map((m: Peek) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
        expect(messages[1].content.map((c: Peek) => c.id)).toEqual(['a', 'b'])
        expect(messages[2].content.map((c: Peek) => c.tool_use_id)).toEqual(['a', 'b'])
      }
    })

    if (api === 'openai-completions')
      it('PIN current behaviour: an error result has no error flag, only its text', () => {
        const failed = at('parallel').body.messages[3]
        expect(failed).toEqual({ role: 'tool', content: 'B failed', tool_call_id: 'b' })
      })
    else
      it('marks an error result with is_error on its tool_result block', () => {
        const blocks = at('parallel').body.messages[2].content
        expect(blocks.map((b: Peek) => b.is_error)).toEqual([false, true])
      })

    it('joins the text blocks of one result into one string', () => {
      const messages = at('blocks').body.messages
      const content = api === 'openai-completions' ? messages[2].content : messages[2].content[0].content
      expect(content).toBe('one\ntwo')
    })

    it('PIN current behaviour: call arguments reach Pi with keys in canonical order, not authored order', () => {
      // The item was authored as {type, text}; the prepare boundary canonicalises it before Pi sees it.
      const { messages } = at('single').body
      const args =
        api === 'openai-completions'
          ? JSON.parse(messages[1].tool_calls[0].function.arguments)
          : messages[1].content[0].input
      expect(Object.keys(args.content[0])).toEqual(['text', 'type'])
    })
  })

  describe('cell 3: an empty tool list together with tool history (second round)', () => {
    it('the builder produced no tools and the peer got the history', () => {
      const r = at('empty')
      expect(r.sourceTools).toEqual([])
      expect(r.peers).toBe(1)
      expect(r.effect.outcome).toBe('succeeded')
    })
    if (api === 'openai-completions')
      it('PIN current behaviour: sends an explicit empty tools array. Real API acceptance: unverified', () => {
        expect(at('empty').body.tools).toEqual([])
        expect('tools' in at('empty').body).toBe(true)
      })
    else
      it('PIN current behaviour: sends tool_use and tool_result blocks with no tools field. Real API acceptance: unverified', () => {
        const r = at('empty')
        expect('tools' in r.body).toBe(false)
        expect(JSON.stringify(r.body.messages)).toContain('"type":"tool_use"')
        expect(JSON.stringify(r.body.messages)).toContain('"type":"tool_result"')
      })
  })

  describe('cell 4: provider id limits', () => {
    it('passes a 64 character id and a hyphen and underscore id through unchanged, both directions', () => {
      const raw = at('ids').raw
      expect(raw).toContain(`"${long}"`)
      expect(raw).toContain('"a-b_C9"')
      const { messages } = at('ids').body
      const seen = JSON.stringify(messages)
      expect(seen.split(long).length - 1).toBe(2)
      expect(seen.split('a-b_C9').length - 1).toBe(2)
    })
    if (api === 'openai-completions')
      it('PIN current behaviour: no truncation of a 64 character id at 40. A real endpoint limit: unverified', () => {
        expect(JSON.stringify(at('ids').body.messages)).toContain(long)
        expect(long.length).toBeGreaterThan(40)
      })
  })

  describe('cell 5: tool calls coming back', () => {
    const calls = (name: string) => (at(name).output.structured as { toolCalls: unknown[] }).toolCalls
    it('finishes with tool-calls and the call in the keys the Loop consumer reads', () => {
      const r = at('single')
      expect(r.finish).toBe('tool-calls')
      expect(calls('single')).toEqual([
        {
          args: { content: [{ text: 'x y', type: 'text' }] },
          name: 'text_statistics',
          ordinal: 0,
          toolUseId: 'call_1',
        },
      ])
      expect(
        Object.keys((calls('single')[0] ?? {}) as object)
          .sort()
          .join(','),
      ).toBe('args,name,ordinal,toolUseId')
    })
    it('is accepted by modelTool with exactly the parsed args as the tool input', () => {
      const r = at('single')
      const accepted = modelTool(r.output, r.definitions)
      expect(accepted.definition.name).toBe('text_statistics')
      expect(accepted.input).toMatchObject({
        kind: 'inline',
        value: { content: [{ text: 'x y', type: 'text' }] },
      })
    })
    it('streams the arguments in two parts and the adapter parses them once, whole', () => {
      expect((calls('single')[0] as { args: unknown }).args).toEqual({
        content: [{ text: 'x y', type: 'text' }],
      })
    })
    it('keeps parallel calls apart with their ordinals, and modelTool refuses more than one', () => {
      const r = at('parallel')
      expect(
        (calls('parallel') as { name: string; ordinal: number }[]).map((c) => [c.name, c.ordinal]),
      ).toEqual([
        ['text_statistics', 0],
        ['other_tool', 1],
      ])
      expect(() => modelTool(r.output, r.definitions)).toThrow(refused('loop_single_tool_required'))
    })
    it('a text answer has an empty tool call list and finishes with stop', () => {
      expect(at('empty').finish).toBe('stop')
      expect((at('empty').output.structured as { toolCalls: unknown[] }).toolCalls).toEqual([])
    })
    it('PIN current behaviour: a call name outside the catalog is returned as is; modelTool refuses it', () => {
      const r = at('unknown')
      expect(r.finish).toBe('tool-calls')
      expect((calls('unknown')[0] as { name: string }).name).toBe('not_in_catalog')
      expect(() => modelTool(r.output, r.definitions)).toThrow(refused('loop_tool_not_in_catalog'))
    })
    it('PIN current behaviour: malformed argument JSON becomes empty args, and modelTool accepts the call', () => {
      const r = at('malformed')
      expect((calls('malformed')[0] as { args: unknown }).args).toEqual({})
      expect(modelTool(r.output, r.definitions).input).toMatchObject({ value: {} })
    })
    it('PIN current behaviour: a 70 character call id is returned as is and modelTool accepts it', () => {
      const r = at('ids')
      const id = 'y'.repeat(70)
      expect((calls('ids')[0] as { toolUseId: string }).toolUseId).toBe(id)
      expect(modelTool(r.output, r.definitions).definition.name).toBe('text_statistics')
    })
  })
})

describe.each(APIS)('cell 6: refusals by name from the real Model service, %s route', (api) => {
  let template: ModelWireSource
  let joint: Awaited<ReturnType<typeof modelJointFixture>>
  beforeAll(async () => {
    joint = await modelJointFixture(api, 'normal', {}, true, {
      source: (t) => {
        template = t
        return t
      },
    })
  }, 120_000)
  afterAll(async () => {
    await joint.close()
  })
  const refusal = async (items: W.ContextItem[], tools: Pair[] | null) =>
    (await prepareRaw(template, items, tools)).refusal
  const hyphen = standardTool('text-statistics', 'Count the words of a text')
  const huge = (() => {
    const document = {
      ...standardToolDocument(),
      $ref: '#/$defs/Input',
      $defs: {
        Input: {
          type: 'object',
          properties: {
            a: { enum: Array.from({ length: 6000 }, (_, i) => `value-number-${i}-${'x'.repeat(40)}`) },
          },
          required: ['a'],
        },
      },
    }
    return standardTool('huge_tool', 'Huge', document)
  })()

  it.each([
    [
      'an illegal tool name (the default tool name today)',
      () => [user('q')],
      () => [hyphen],
      'model_wire_tool_name',
    ],
    [
      'a duplicate tool name',
      () => [user('q')],
      () => [text, standardTool('text_statistics', 'again')],
      'model_wire_tool_name',
    ],
    [
      'a description over the limit',
      () => [user('q')],
      () => [standardTool('text_statistics', 'd'.repeat(4097))],
      'model_wire_tool_description',
    ],
    ['a parameters schema over the byte limit', () => [user('q')], () => [huge], 'model_wire_tools_oversize'],
    [
      'more tools than the catalog limit',
      () => [user('q')],
      () => Array.from({ length: 129 }, (_, i) => standardTool(`tool_${i}`, 'd')),
      'model_wire_tools_oversize',
    ],
    [
      'history with a call whose result is missing',
      () => [user('q'), call('c1', 'text_statistics', doc('A'))],
      () => [] as Pair[],
      'model_wire_tool_pair',
    ],
    [
      'history with a call id over 64 characters',
      () => [user('q'), call('i'.repeat(65), 'text_statistics', doc('A')), result('i'.repeat(65), ['r'])],
      () => [] as Pair[],
      'model_wire_tool_id',
    ],
    [
      'history with a call id outside the allowed characters',
      () => [user('q'), call('call.1|x', 'text_statistics', doc('A')), result('call.1|x', ['r'])],
      () => [] as Pair[],
      'model_wire_tool_id',
    ],
    [
      'history with a call name outside the allowed characters',
      () => [user('q'), call('c1', 'text-statistics', doc('A')), result('c1', ['r'])],
      () => [] as Pair[],
      'model_wire_tool_history',
    ],
  ])('refuses %s', async (_name, items, tools, expected) => {
    expect(await refusal(items(), tools())).toBe(expected)
  })

  it('refuses tool history when the request has no catalog at all', async () => {
    const items = [user('q'), call('c1', 'text_statistics', doc('A')), result('c1', ['r'])]
    expect(await refusal(items, null)).toBe('model_wire_item')
  })

  it('refuses a catalog when no resolver port is installed', async () => {
    expect((await prepareRaw(template, [user('q')], [text], false)).refusal).toBe('model_wire_tools')
  })
})
