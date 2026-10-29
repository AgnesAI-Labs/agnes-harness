import { ToolRegistry } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  openSession,
  readTool,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { type VerifyInput, verifierT0 } from '../src/verifier.js'

const base: VerifyInput = {
  toolCalls: [],
  deviations: 0,
  recentToolKeys: [],
  surfaceTailHashes: [],
  newToolResults: 1,
}
const opts = { tier: 0 as const, signal: new AbortController().signal }
describe('verifier T0', () => {
  it('passes a clean input', async () => {
    const v = await verifierT0(fakeSeamInit())
    expect(await v.verify('turn', base, opts)).toEqual({ verdict: 'pass', reasons: [] })
  })
  it('fails on schema-invalid calls, tool-call-as-text and truncation on any scope', async () => {
    const v = await verifierT0(fakeSeamInit())
    expect(
      await v.verify('tool', { ...base, toolCalls: [{ name: 'x', args: {}, schemaOk: false }] }, opts),
    ).toEqual({ verdict: 'fail', reasons: ['schema_invalid'] })
    expect(await v.verify('step', { ...base, deviations: 2 }, opts)).toEqual({
      verdict: 'fail',
      reasons: ['tool_call_as_text'],
    })
    expect(await v.verify('step', { ...base, lastFinishReason: 'length' }, opts)).toEqual({
      verdict: 'fail',
      reasons: ['output_truncated'],
    })
  })
  it('flags repeats and no progress on step scope only over the history a limited turn hands it', async () => {
    const v = await verifierT0(fakeSeamInit())
    const key = 'edit|{"path":"a"}'
    const history = {
      toolCalls: [0, 1, 2].map(() => ({
        name: 'edit',
        args: { path: 'a' },
        schemaOk: true,
        isReadOnly: false,
      })),
      recentToolKeys: [key, key, key],
      surfaceTailHashes: ['h', 'h'],
      newToolResults: 3,
    }
    // The step's own fields hold one call; its history holds the turn's last steps.
    const step = { ...base, recentToolKeys: [key] }
    expect(await v.verify('step', step, opts)).toEqual({ verdict: 'pass', reasons: [] })
    expect(await v.verify('step', { ...step, history }, opts)).toEqual({
      verdict: 'needs_revision',
      reasons: ['repeated_write:3'],
    })
    const stalled = {
      ...history,
      recentToolKeys: [],
      toolCalls: [],
      surfaceTailHashes: ['h', 'h', 'h', 'h'],
      newToolResults: 0,
    }
    expect(await v.verify('step', { ...step, history: stalled }, opts)).toEqual({
      verdict: 'needs_revision',
      reasons: ['no_progress:4'],
    })
    // A failure on the step itself still wins, and tool scope never reads history.
    expect(await v.verify('step', { ...step, deviations: 1, history }, opts)).toEqual({
      verdict: 'fail',
      reasons: ['tool_call_as_text'],
    })
    expect(await v.verify('tool', { ...step, history }, opts)).toEqual({ verdict: 'pass', reasons: [] })
  })
  // A turn verdict judges how the turn ended, not every slip on the way there.
  it('fails a turn only on an invalid call that was never corrected or that recurred', async () => {
    const v = await verifierT0(fakeSeamInit())
    const call = (name: string, schemaOk: boolean) => ({ name, args: {}, schemaOk, isReadOnly: true })
    const turn = (...toolCalls: ReturnType<typeof call>[]) => ({
      ...base,
      toolCalls,
      recentToolKeys: toolCalls.map((c) => `${c.name}|{}`),
    })
    // Corrected by a later valid call to the same tool.
    expect(await v.verify('turn', turn(call('a', false), call('b', true), call('a', true)), opts)).toEqual({
      verdict: 'pass',
      reasons: [],
    })
    // A valid call to some other tool does not correct it.
    expect(await v.verify('turn', turn(call('a', false), call('b', true)), opts)).toEqual({
      verdict: 'fail',
      reasons: ['schema_invalid'],
    })
    // The same tool called invalidly twice is a pattern, even if a third call got it right.
    expect(await v.verify('turn', turn(call('a', false), call('a', false), call('a', true)), opts)).toEqual({
      verdict: 'fail',
      reasons: ['schema_invalid'],
    })
    // A step is still judged on its own calls.
    expect(await v.verify('step', turn(call('a', false), call('a', true)), opts)).toEqual({
      verdict: 'fail',
      reasons: ['schema_invalid'],
    })
  })
  it('flags repeats and no progress only on turn scope, honouring preset thresholds', async () => {
    const v = await verifierT0(
      fakeSeamInit({ preset: { loop: { repeat_threshold: 2, no_progress_steps: 2 } } }),
    )
    const rep = { ...base, recentToolKeys: ['edit|{"path":"a"}', 'edit|{"path":"a"}'] }
    expect(await v.verify('step', rep, opts)).toEqual({ verdict: 'pass', reasons: [] })
    expect(await v.verify('turn', rep, opts)).toEqual({
      verdict: 'needs_revision',
      reasons: ['repeated_write:2'],
    })
    for (const [readOnly, expected] of [
      [[true, true], 'pass'],
      [[false, false], 'needs_revision'],
      [[false, true], 'pass'],
      [[true, false], 'pass'],
      [[false, true, false], 'pass'],
      [[true, false, false], 'needs_revision'],
    ] as const) {
      const toolCalls = readOnly.map((isReadOnly) => ({
        name: 'edit',
        args: { path: 'a' },
        schemaOk: true,
        isReadOnly,
      }))
      expect(
        (
          await v.verify(
            'turn',
            { ...rep, toolCalls, recentToolKeys: toolCalls.map(() => rep.recentToolKeys[0]) },
            opts,
          )
        ).verdict,
      ).toBe(expected)
    }
    expect(
      await v.verify(
        'turn',
        {
          ...rep,
          toolCalls: [true, true].map((isReadOnly) => ({
            name: 'edit',
            args: { path: 'a' },
            schemaOk: true,
            isReadOnly,
          })),
          surfaceTailHashes: ['h', 'h'],
          newToolResults: 0,
        },
        opts,
      ),
    ).toEqual({ verdict: 'needs_revision', reasons: ['no_progress:2'] })
  })
})

// Real Core + T0: refused arguments are diagnosed without poisoning the final answer.
it.each([true, false])('keeps repeated-write verification automatic (readOnly=%s)', async (readOnly) => {
  const registry = new ToolRegistry()
  const tool = readTool() as ToolDef
  registry.add(
    { ...tool, name: 'device', meta: { ...tool.meta, isReadOnly: readOnly } },
    { source: 's', trust: 'builtin' },
  )
  const provider = fakeProvider([
    toolTurn('device', {}),
    toolTurn('device', {}),
    toolTurn('device', {}),
    textTurn('done'),
  ])
  let approvals = 0
  const { session, log } = await openSession({
    registry,
    provider,
    seams: fakeSeams({
      verifier: await verifierT0(fakeSeamInit()),
      repair: { decide: async () => 'park' },
      approval: {
        ask: async () => {
          approvals++
          return { verdict: 'allowed-once', answeredBy: actor }
        },
      },
    }),
  })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'check' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      readOnly ? 'completed' : 'blocked',
    )
    expect(approvals).toBe(0)
    expect(await session.decisions.list()).toEqual([])
    expect(await log.scan({ type: 'tool/call', limit: 100 })).toHaveLength(3)
  } finally {
    await session.close()
  }
})
it('completes after invalid argument fallback with real T0 and keeps schema rejection evidence', async () => {
  const registry = new ToolRegistry()
  const tool = readTool() as ToolDef
  registry.add(
    {
      ...tool,
      name: 'checked',
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      meta: { ...tool.meta, isPresentational: true },
    },
    { source: 's', trust: 'builtin' },
  )
  const provider = fakeProvider([toolTurn('checked', {}), toolTurn('checked', {}), textTurn('文字结论')])
  const { session, log } = await openSession({
    registry,
    provider,
    seams: fakeSeams({ verifier: await verifierT0(fakeSeamInit()) }),
  })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'check' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.calls).toBe(3)
    expect(await session.decisions.list()).toEqual([])
    expect((await log.scan({ type: 'tool/result', limit: 10 })).map((r) => r.data)).toMatchObject([
      { code: 'TOOL_ARGS_INVALID' },
      { code: 'TOOL_ARGS_INVALID' },
    ])
    expect(provider.requests[2]?.tools.map((t) => t.name)).not.toContain('checked')
  } finally {
    await session.close()
  }
})

/**
 * The Terminal-Bench git-multibranch chain, replayed on real Core + T0: a shell hint names a deferred
 * tool, the model guesses its argument names, and the call is refused. That early slip must neither
 * fail the final verdict nor send the model into a repair of finished work.
 */
describe('a refused call to a deferred tool', () => {
  const setup = () => {
    const registry = new ToolRegistry()
    const tool = readTool() as ToolDef
    const executed: unknown[] = []
    registry.add(
      {
        ...tool,
        name: 'tool_describe',
        parameters: Type.Object({ name: Type.String() }),
        async execute(args, ctx) {
          if (!ctx.tools.disclose) throw new Error('expected tool disclosure port')
          await ctx.tools.disclose((args as { name: string }).name)
          return { content: [{ type: 'text', text: 'loaded' }] }
        },
      },
      { source: 's', trust: 'builtin' },
    )
    registry.add(
      {
        ...tool,
        name: 'job_output',
        parameters: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
        meta: { ...tool.meta, deferLoading: true },
        async execute(args) {
          executed.push(args)
          return { content: [{ type: 'text', text: 'PASS_MAIN PASS_DEV\n[exited; exit 0]' }] }
        },
      },
      { source: 's', trust: 'builtin' },
    )
    return { registry, executed }
  }
  const runTurn = async (registry: ToolRegistry, provider: ReturnType<typeof fakeProvider>) => {
    const opened = await openSession({
      registry,
      provider,
      seams: fakeSeams({ verifier: await verifierT0(fakeSeamInit()) }),
    })
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'set up' }] })
    const end = await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    return { ...opened, end }
  }

  it('loads the tool, returns its schema, and lets a corrected call complete the turn', async () => {
    const { registry, executed } = setup()
    const provider = fakeProvider([
      toolTurn('job_output', { job_id: 'j1' }),
      toolTurn('job_output', { jobId: 'j1' }),
      textTurn('Setup complete and verified end to end.'),
      textTurn('must not be needed'),
      textTurn('must not be needed'),
    ])
    const { session, log, end } = await runTurn(registry, provider)
    try {
      expect(end.reason).toBe('completed')
      expect(provider.calls).toBe(3)
      const [refused] = await log.scan({ type: 'tool/result', limit: 1 })
      expect(refused?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
      // The refusal carries the schema the model was missing, and the next request offers the tool.
      expect(JSON.stringify(refused?.data)).toContain('jobId')
      expect(provider.requests[0]?.tools.map((t) => t.name)).not.toContain('job_output')
      expect(provider.requests[1]?.tools.map((t) => t.name)).toContain('job_output')
      expect(executed).toEqual([{ jobId: 'j1' }])
      expect(await log.scan({ type: 'repair/decision', limit: 5 })).toEqual([])
      const signals = await log.scan({ type: 'verifier/signal', limit: 10 })
      expect(signals.map((e) => e.data)).not.toContainEqual(
        expect.objectContaining({ reasons: ['schema_invalid'] }),
      )
      expect(signals.at(-1)?.data).toMatchObject({ scope: 'turn', verdict: 'pass' })
    } finally {
      await session.close()
    }
  })

  it('does not fail the turn when the model finishes without retrying the tool', async () => {
    const { registry } = setup()
    const provider = fakeProvider([
      toolTurn('job_output', { job_id: 'j1' }),
      textTurn('Done; verified with the shell.'),
      textTurn('must not be needed'),
    ])
    const { session, log, end } = await runTurn(registry, provider)
    try {
      expect(end.reason).toBe('completed')
      expect(provider.calls).toBe(2)
      expect(await log.scan({ type: 'repair/decision', limit: 5 })).toEqual([])
    } finally {
      await session.close()
    }
  })
})
