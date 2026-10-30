import type { ToolDef } from '@agnes/extension-api'
import type { ToolResult as LedgerToolResult } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { noopHooks } from '../src/step/session.js'
import { toolArgumentError } from '../src/step/tool-args.js'
import { fakeProvider, type Script, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const parameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    count: Type.Integer({ minimum: 1 }),
    mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    tags: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
)
const good = { path: 'file', count: 1, mode: 'read' }
async function check(
  args: unknown,
  schema: ToolDef['parameters'] = parameters,
  scripts?: Script[],
  limit?: number,
  pauseAfterFailures?: number,
) {
  const reached: string[] = []
  const registry = new ToolRegistry()
  const def: ToolDef = {
    name: 'checked',
    description: 'schema-checked',
    parameters: schema,
    modelParameters: Type.Object({}, { additionalProperties: true }),
    meta: {
      ...(limit ? { invalidArgumentLimit: limit } : {}),
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'always',
    },
    async execute(value) {
      reached.push('execute')
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    },
  }
  registry.add(def, { source: 'test', trust: 'builtin' })
  registry.add({ ...def, name: 'other_checked' }, { source: 'test', trust: 'builtin' })
  const seams = fakeSeams({
    principals: {
      authorize: async () => {
        reached.push('authorize')
        return { effect: 'allow', decisionId: 'a', reason: 'ok' }
      },
    },
    approval: {
      ask: async () => {
        reached.push('approval')
        return { verdict: 'allowed-once' as const, answeredBy: actor }
      },
    },
  })
  const provider = fakeProvider(scripts ?? [toolTurn('checked', args), textTurn('handled')])
  const { session, log, storage } = await openSession({
    provider,
    registry,
    seams,
    hooks: {
      ...noopHooks,
      toolCall: async () => {
        reached.push('hook')
        return { allow: true }
      },
    },
  })
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  if (pauseAfterFailures) {
    for (let i = 0; i < 30; i++) {
      await session.step()
      if ((await log.scan({ type: 'x/core/tool-argument-recovery', limit: 10 })).length >= pauseAfterFailures)
        break
    }
  } else
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
  return {
    session,
    storage,
    log,
    registry,
    seams,
    reached,
    result: (await log.scan({ type: 'tool/result', toSeq: log.lastSeq }))[0]?.data,
    results: (await log.scan({ type: 'tool/result', toSeq: log.lastSeq })).map(
      (e) => e.data as LedgerToolResult,
    ),
    toolEffects: (await log.scan({ type: 'effect/intent', toSeq: log.lastSeq })).filter(
      (e) => (e.data as { kind: string }).kind === 'tool',
    ),
    provider,
  }
}

describe('tool argument boundary', () => {
  it('returns structured failure feedback for a failing array item before any effect', async () => {
    const out = await check(
      {
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: '', newText: 'c' },
        ],
      },
      Type.Object({
        edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() })),
      }),
    )
    expect(out.result).toMatchObject({
      code: 'TOOL_ARGS_INVALID',
      structured: {
        category: 'invalid_args',
        index: 1,
        written: false,
        hint: expect.stringContaining('/edits/1/oldText'),
      },
    })
    expect(out.reached).toEqual([])
    expect(out.toolEffects).toEqual([])
    await out.session.close()
  })
  it('identifies nested schema failures without echoing supplied values', () => {
    const schema = Type.Object({
      options: Type.Object(
        {
          template: Type.Union([Type.Literal('tool'), Type.Literal('skill')]),
          count: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    })
    const message = toolArgumentError(schema, {
      options: { template: 'private-token', count: 'private-token' },
    })
    expect(message).toContain('/options/template')
    expect(message).toContain('"tool", "skill"')
    expect(message).toContain('/options/count')
    expect(message).not.toContain('private-token')
    expect(toolArgumentError(schema, { options: { template: 'tool', count: 0 } })).toContain(
      '/options/count: outside the allowed range (minimum=1)',
    )
    expect(
      toolArgumentError(schema, { options: { template: 'tool', count: 1, 'private-token': 1 } }),
    ).not.toContain('private-token')
    expect(toolArgumentError(schema, { options: { template: 'tool', count: 1, extra: true } })).toContain(
      'allowed fields: template, count',
    )
  })
  it('resolves module references and the chosen component union to name the precise field', () => {
    const module = Type.Module({
      Component: Type.Union([
        Type.Object({ kind: Type.Literal('text'), dataKey: Type.String() }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal('chart'), chartType: Type.Union([Type.Literal('bar'), Type.Literal('line')]) },
          { additionalProperties: false },
        ),
      ]),
      Surface: Type.Object(
        {
          revision: Type.Integer({ minimum: 1, maximum: 10 }),
          components: Type.Array(Type.Ref('Component')),
        },
        { additionalProperties: false },
      ),
      Params: Type.Object({ surface: Type.Ref('Surface') }, { additionalProperties: false }),
    })
    const schema = module.Import('Params')
    const bad = {
      locale: 'private-token',
      surface: { revision: 0, components: [{ kind: 'chart', chartType: 'private-token' }] },
    }
    const message = toolArgumentError(schema, bad)
    expect(message).toContain('/surface/revision: outside the allowed range (minimum=1, maximum=10)')
    expect(message).toContain('/surface/components/0/chartType: choose an allowed value ("bar", "line")')
    expect(message).toContain('allowed fields: surface')
    expect(message).not.toContain('private-token')
    expect(message).not.toContain('<unknown>')
  })
  it.each([
    {},
    { ...good, count: '1' },
    { ...good, count: 0 },
    { ...good, count: 1.5 },
    { ...good, mode: 'private' },
    { ...good, path: '' },
    { ...good, extra: true },
    { ...good, tags: [1] },
    null,
  ])('refuses invalid arguments before hooks, authorization, approval, and effects: %j', async (args) => {
    const out = await check(args)
    expect(out.reached).toEqual([])
    expect(out.toolEffects).toEqual([])
    expect(out.result).toMatchObject({ isError: true, code: 'TOOL_ARGS_INVALID' })
    expect(out.provider.calls).toBe(2)
    expect(JSON.stringify(out.provider.requests[1]?.messages)).toContain('tool arguments do not match')
  })
  it('runs valid arguments through every existing guard, with omitted optional tags preserved', async () => {
    const out = await check(good)
    expect(out.reached).toEqual(['hook', 'authorize', 'approval', 'execute'])
    expect(out.toolEffects).toHaveLength(1)
    expect(out.result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(good) }],
    })
  })
  it('fails closed if a registered schema cannot be interpreted', async () => {
    const malformed = { type: 'object' } as unknown as typeof parameters
    const out = await check(good, malformed)
    expect(out.reached).toEqual([])
    expect(out.toolEffects).toEqual([])
    expect(out.result).toMatchObject({ isError: true, code: 'TOOL_ARGS_INVALID' })
  })
  it('names a missing content parameter so the next call can repair it before execution', async () => {
    const schema = Type.Object(
      { path: Type.String(), content: Type.String() },
      { additionalProperties: false },
    )
    const missing = { path: 'synthetic.html' }
    const complete = { ...missing, content: '<html>complete</html>' }
    const out = await check(missing, schema, [
      toolTurn('checked', missing),
      toolTurn('checked', complete),
      textTurn('handled'),
    ])
    expect(out.results).toMatchObject([{ isError: true, code: 'TOOL_ARGS_INVALID' }, { isError: false }])
    const feedback = JSON.stringify(out.provider.requests[1]?.messages)
    expect(feedback).toContain('/content: missing required parameter')
    expect(feedback).toContain('Retry with complete arguments')
    expect(out.reached).toEqual(['hook', 'authorize', 'approval', 'execute'])
    expect(out.toolEffects).toHaveLength(1)
  })
  it('disables only the failing tool after two invalid arguments and tells the model to use text', async () => {
    const out = await check({}, parameters, [
      toolTurn('checked', {}),
      toolTurn('checked', {}),
      toolTurn('checked', good),
      textTurn('文字调查结果'),
    ])
    expect(out.results.map((r) => r.code)).toEqual([
      'TOOL_ARGS_INVALID',
      'TOOL_ARGS_INVALID',
      'TOOL_ARGS_EXHAUSTED',
    ])
    expect(out.reached).toEqual([])
    expect(out.provider.requests[1]?.tools.map((t) => t.name)).toContain('checked')
    expect(out.provider.requests[0]?.tools.find((t) => t.name === 'checked')?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
    expect(out.provider.requests[2]?.tools.map((t) => t.name)).not.toContain('checked')
    expect(JSON.stringify(out.provider.requests[2]?.messages)).toContain(
      'Continue with other available tools and answer in text/markdown',
    )
    expect(JSON.stringify(out.provider.requests[2]?.system)).toContain('do not route around the limit')
    const nodes = (await out.session.projectUI()).nodes.filter((n) => n.kind === 'tool')
    expect(nodes.slice(0, 2).map((n) => n.argumentRecovery)).toEqual([
      { disabled: false, presentational: false },
      { disabled: true, presentational: false },
    ])
    expect(await out.session.decisions.list()).toEqual([])
    await out.session.close()
  })
  it('resets consecutive failures on valid arguments and restores availability on the next turn', async () => {
    const out = await check({}, parameters, [
      toolTurn('checked', {}),
      toolTurn('checked', good),
      toolTurn('checked', {}),
      textTurn('done'),
      toolTurn('checked', good),
      textTurn('next'),
    ])
    expect(out.results.map((r) => r.code)).toEqual(['TOOL_ARGS_INVALID', undefined, 'TOOL_ARGS_INVALID'])
    await out.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }] })
    expect((await out.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(out.provider.requests[4]?.tools.map((t) => t.name)).toContain('checked')
    await out.session.close()
  })
  it('honors a tool limit and counts batched failures before any dispatch', async () => {
    const batch = toolTurn('checked', {})
    batch.splice(2, 0, {
      type: 'toolcall_end',
      call: { toolUseId: '', name: 'checked', args: {}, ordinal: 1 },
      via: 'native',
    })
    const out = await check({}, parameters, [batch, textTurn('done')], 1)
    expect(out.results.map((r) => r.code)).toEqual(['TOOL_ARGS_INVALID', 'TOOL_ARGS_EXHAUSTED'])
    expect(out.toolEffects).toEqual([])
    expect(out.provider.requests[1]?.tools.map((t) => t.name)).not.toContain('checked')
    await out.session.close()
  })
  it('retains exhaustion across reopening and refuses nested dispatch before effects', async () => {
    const out = await check(
      {},
      parameters,
      [toolTurn('checked', {}), toolTurn('checked', {}), textTurn('done')],
      undefined,
      2,
    )
    await out.session.close()
    const provider = fakeProvider([toolTurn('checked', good), textTurn('文字结果')])
    const fresh = await openSession({
      storage: out.storage,
      registry: out.registry,
      seams: out.seams,
      provider,
    })
    try {
      await fresh.session.resume()
      // A nested caller cannot bypass a turn-local prohibition even with valid arguments.
      await expect(fresh.session.invokeTool('checked', good, { depth: 1 })).rejects.toMatchObject({
        code: 'TOOL_ARGS_INVALID',
        message: expect.stringContaining('Disabled for the rest of this turn'),
      })
      expect(
        (await fresh.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
      ).toBe('completed')
      expect(provider.requests[0]?.tools.map((t) => t.name)).not.toContain('checked')
      expect(out.reached).toEqual([])
      expect((await fresh.session.projectUI()).turns[0]?.argumentRecovery).toMatchObject([
        { name: 'checked', disabled: true, hint: expect.stringContaining('Disabled') },
      ])
    } finally {
      await fresh.session.close()
    }
  })
  it('does not let another tool reset the failing tool count or lose its own availability', async () => {
    const out = await check({}, parameters, [
      toolTurn('checked', {}),
      toolTurn('other_checked', good),
      toolTurn('checked', {}),
      toolTurn('other_checked', good),
      textTurn('done'),
    ])
    expect(out.results.map((r) => r.code)).toEqual([
      'TOOL_ARGS_INVALID',
      undefined,
      'TOOL_ARGS_INVALID',
      undefined,
    ])
    expect(out.provider.requests[3]?.tools.map((t) => t.name)).toContain('other_checked')
    expect(out.provider.requests[3]?.tools.map((t) => t.name)).not.toContain('checked')
    expect(out.toolEffects).toHaveLength(2)
    await out.session.close()
  })
})
