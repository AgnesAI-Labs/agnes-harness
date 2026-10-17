import { describe, expect, it } from 'vitest'
import { dispatchCalls, observeDispatch, replayCalls, viewForDispatch } from '../src/dispatch.js'
import type { JsonValue, PendingCall } from '../src/types.js'

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const pc = (i: number, name = 'read', announce: 'true' | 'content' = 'content'): PendingCall => ({
  invocationId: `jev:1:0:t${i}`,
  name,
  args: { path: `f${i}` },
  announce,
  ...(announce === 'content' ? { content: [{ type: 'text', text: 'm' }] } : {}),
})
const coded = (code: string, message = code) => Object.assign(new Error(message), { code })
function tools(behave: (calls: unknown[], options: unknown) => unknown) {
  const log: Array<{ op: string; calls: unknown[]; options: unknown }> = []
  const port = {
    execute: async (call: unknown, _s: unknown, options: unknown) => {
      log.push({ op: 'execute', calls: [call], options })
      return ((await behave([call], options)) as unknown[])[0]
    },
    batch: async (calls: unknown[], _s: unknown, options: unknown) => {
      log.push({ op: 'batch', calls, options })
      return behave(calls, options)
    },
    resume: async () => ok(''),
  }
  return { port: port as never, log }
}
/** One status for every id, or one per call index (`jev:1:0:t<i>`). */
const effects = (status: string | string[]) =>
  ({
    status: async (id: string) => ({
      status: Array.isArray(status) ? status[Number(id.split(':t')[1])] : status,
      invocationId: id,
      checkpoint: null,
      result: ok('recorded'),
    }),
  }) as never
const signal = new AbortController().signal
const run = (calls: PendingCall[], behave: Parameters<typeof tools>[0], saved: string[] = []) => {
  const t = tools(behave)
  return {
    t,
    out: dispatchCalls(
      calls,
      {
        tools: t.port,
        effects: effects('not-sent'),
        save: async (c) => void saved.push(...c.map((x) => x.invocationId)),
      },
      signal,
    ),
  }
}

describe('dispatchCalls', () => {
  it('announces a pass-through call as true and saves first', async () => {
    const saved: string[] = []
    const { t, out } = run([pc(0, 'ls', 'true')], () => [ok('a/')], saved)
    expect(await out).toMatchObject({ kind: 'results', dropped: 0 })
    expect(saved).toEqual(['jev:1:0:t0'])
    expect(t.log[0]).toMatchObject({ op: 'execute', options: { announce: true } })
  })
  it('batches several reads into one announced message with the model content', async () => {
    const { t, out } = run([pc(0), pc(1), pc(2)], (calls) => calls.map(() => ok('x')))
    await out
    expect(t.log[0]).toMatchObject({
      op: 'batch',
      options: { announce: { content: [{ type: 'text', text: 'm' }] } },
    })
  })
  it('falls back to the first call when Core refuses the batch, and says so', async () => {
    const { t, out } = run([pc(0), pc(1), pc(2)], (calls) => {
      if (calls.length > 1) throw coded('TOOL_ARGS_INVALID', '/path must be string')
      return [ok('x')]
    })
    const o = await out
    expect(o).toMatchObject({ kind: 'results', dropped: 2 })
    expect(o.kind === 'results' && o.batchNote).toBe(
      '[runtime observation] 2 other calls in the batch were not executed: TOOL_ARGS_INVALID (dispatch); reason (data): "/path must be string"',
    )
    expect(t.log.map((l) => [l.op, (l.calls[0] as PendingCall).invocationId])).toEqual([
      ['batch', 'jev:1:0:t0'],
      ['execute', 'jev:1:0:t0'],
    ])
  })
  it.each([
    'TOOL_ARGS_INVALID',
    'TOOL_NOT_FOUND',
    'TOOL_NOT_DISCLOSED',
    'TOOL_POLICY_INVALID',
    'POLICY_CLASSIFIER_FAILED',
  ])('maps a refused single call (%s) to REFUSED_BY_CORE', async (code) => {
    expect(
      await run([pc(0, 'write')], () => {
        throw coded(code, `core says ${code}`)
      }).out,
    ).toMatchObject({
      kind: 'refused',
      code: 'REFUSED_BY_CORE',
      coreCode: code,
      message: `core says ${code}`,
    })
  })
  it('maps BUDGET_EXCEEDED, E_RELATION and E_ENVELOPE', async () => {
    expect(
      await run([pc(0)], () => {
        throw coded('BUDGET_EXCEEDED')
      }).out,
    ).toMatchObject({ kind: 'budget' })
    expect(
      await run([pc(0)], () => {
        throw coded('E_RELATION')
      }).out,
    ).toMatchObject({ kind: 'refused', code: 'INTERNAL_RELATION' })
    expect(
      await run([pc(0)], () => {
        throw coded('E_ENVELOPE')
      }).out,
    ).toMatchObject({ kind: 'refused', code: 'INTERNAL_RELATION' })
  })
  it.each(['PARKED', 'E_CLOSED', 'E_BUDGET'])('rethrows %s', async (code) => {
    await expect(
      run([pc(0)], () => {
        throw coded(code)
      }).out,
    ).rejects.toMatchObject({ code })
  })
  it('rethrows an error without a code', async () => {
    await expect(
      run([pc(0)], () => {
        throw new Error('boom')
      }).out,
    ).rejects.toThrow('boom')
  })
})

describe('replayCalls', () => {
  it('replays with the same id and options and reports an uncertain dispatch', async () => {
    const t = tools(() => {
      throw coded('E_RELATION')
    })
    expect(
      await replayCalls(
        [pc(0, 'shell')],
        { tools: t.port, effects: effects('may-have-sent'), save: async () => {} },
        signal,
      ),
    ).toMatchObject({ kind: 'unknown' })
    expect(t.log[0]).toMatchObject({
      op: 'execute',
      options: { announce: { content: [{ type: 'text', text: 'm' }] } },
    })
  })
})

describe('observeDispatch', () => {
  it('records a read batch as one entry', () => {
    expect(
      observeDispatch({
        phase: 'INSPECT',
        calls: [pc(0), pc(1)],
        results: [ok('a'), ok('b')],
        cwd: '/w',
        confidence: 0.9,
        escalated: false,
      }).entry.target,
    ).toEqual(['f0', 'f1'])
  })
})

describe('dispatch edge cases', () => {
  it('treats the first call as a single call when Core refuses it alone too', async () => {
    const saved: string[] = []
    const o = await run(
      [pc(0), pc(1)],
      () => {
        throw coded('TOOL_NOT_FOUND', 'no read')
      },
      saved,
    ).out
    expect(o).toMatchObject({
      kind: 'refused',
      code: 'REFUSED_BY_CORE',
      coreCode: 'TOOL_NOT_FOUND',
      message: 'no read',
    })
    expect(o.kind === 'refused' && o.calls.map((c) => c.invocationId)).toEqual(['jev:1:0:t0'])
    expect(saved).toEqual(['jev:1:0:t0', 'jev:1:0:t1', 'jev:1:0:t0'])
  })
  it('replays a settled batch from its receipts', async () => {
    const t = tools(() => {
      throw coded('E_RELATION')
    })
    const o = await replayCalls(
      [pc(0), pc(1)],
      { tools: t.port, effects: effects('responded'), save: async () => {} },
      signal,
    )
    expect(o).toMatchObject({ kind: 'results', dropped: 0, results: [ok('recorded'), ok('recorded')] })
    expect(t.log[0]).toMatchObject({ op: 'batch' })
  })
  it('keeps a relation refusal internal when a replayed call was never sent', async () => {
    const t = tools(() => {
      throw coded('E_RELATION', 'unsettled')
    })
    const o = await replayCalls(
      [pc(0)],
      { tools: t.port, effects: effects('not-sent'), save: async () => {} },
      signal,
    )
    expect(o).toMatchObject({ kind: 'refused', code: 'INTERNAL_RELATION', coreCode: 'E_RELATION' })
  })
  it('classifies a single call with the tool result classifier', () => {
    const o = observeDispatch({
      phase: 'INSPECT',
      calls: [pc(0)],
      results: [ok('body')],
      cwd: '/w',
      confidence: 0.8,
      escalated: true,
    })
    expect(o.entry).toMatchObject({
      operation: 'read',
      target: 'f0',
      status: 'succeeded',
      summary: 'read(f0) conf=0.80 [escalated]',
    })
  })
})

describe('dispatch mixed receipts and narrowed sends', () => {
  const replay = (calls: PendingCall[], statuses: string[]) =>
    replayCalls(
      calls,
      {
        tools: tools(() => {
          throw coded('E_RELATION', 'unsettled')
        }).port,
        effects: effects(statuses),
        save: async () => {},
      },
      signal,
    )
  it('reports an unknown outcome when any replayed call may have been sent', async () => {
    expect(await replay([pc(0), pc(1)], ['may-have-sent', 'not-sent'])).toMatchObject({ kind: 'unknown' })
  })
  it('keeps a relation refusal internal when only some replayed calls responded', async () => {
    expect(await replay([pc(0), pc(1)], ['responded', 'not-sent'])).toMatchObject({
      kind: 'refused',
      code: 'INTERNAL_RELATION',
      coreCode: 'E_RELATION',
    })
  })
  const narrowed = (code: string) =>
    run([pc(0), pc(1)], (calls) => {
      throw calls.length > 1 ? coded('TOOL_ARGS_INVALID') : coded(code)
    }).out
  it('maps a budget refusal of the narrowed call like a single call', async () => {
    expect(await narrowed('BUDGET_EXCEEDED')).toMatchObject({ kind: 'budget' })
  })
  it('rethrows a park of the narrowed call', async () => {
    await expect(narrowed('PARKED')).rejects.toMatchObject({ code: 'PARKED' })
  })
  it('reads the message of a coded error that is not an Error', async () => {
    const o = await run([pc(0)], () => {
      throw { code: 'TOOL_NOT_FOUND', message: 'no such tool' }
    }).out
    expect(o).toMatchObject({ kind: 'refused', coreCode: 'TOOL_NOT_FOUND', message: 'no such tool' })
  })
})

describe('observeDispatch guards', () => {
  const base = { phase: 'ACT' as const, cwd: '/w', confidence: 0.9, escalated: false }
  it('throws when there is no result', () => {
    expect(() => observeDispatch({ ...base, calls: [pc(0)], results: [] })).toThrow()
  })
  it('throws on several calls that are not all reads', () => {
    expect(() =>
      observeDispatch({ ...base, calls: [pc(0), pc(1, 'write')], results: [ok('a'), ok('b')] }),
    ).toThrow()
  })
})

describe('views of dispatched calls', () => {
  const callOf = (name: string, args: JsonValue, i = 0): PendingCall => ({
    invocationId: `jev:1:0:t${i}`,
    name,
    args,
    announce: 'true' as const,
  })
  const textResult = (text: string, more: object = {}) => ({
    content: [{ type: 'text' as const, text }],
    ...more,
  })
  const common = { phase: 'INSPECT' as const, cwd: '/w', confidence: 0.9, escalated: false }

  it('attaches a view with the structured references of ls', () => {
    const obs = observeDispatch({
      ...common,
      calls: [callOf('ls', { path: '.' })],
      results: [
        textResult('a.md\nsrc/', {
          structured: {
            schema: 'agh.path-references/1',
            references: [
              { kind: 'file', path: 'a.md' },
              { kind: 'directory', path: 'src' },
            ],
            total: 2,
            truncated: false,
          },
        }),
      ],
    })
    expect(obs.view).toMatchObject({
      kind: 'ls',
      scope: '.',
      source: { operation: 'ls', call_id: 'jev:1:0:t0' },
      references: [
        { kind: 'file', value: 'a.md' },
        { kind: 'directory', value: 'src' },
      ],
      truncated: false,
    })
    expect(obs.refs).toEqual({ source: 'structured', count: 2 })
  })
  it('attaches one view for a read batch with every file read', () => {
    const calls = ['a.md', 'b.md', 'c.md'].map((path, i) =>
      callOf('read', { path, offset: 1, limit: 200 }, i),
    )
    const obs = observeDispatch({
      ...common,
      calls,
      results: [textResult('A'), textResult('missing', { isError: true }), textResult('C')],
    })
    expect(obs.entry.read_files).toEqual(['a.md', 'c.md'])
    expect(obs.view).toMatchObject({
      kind: 'read',
      scope: 'a.md, b.md, c.md',
      references: [
        { kind: 'file', value: 'a.md' },
        { kind: 'file', value: 'c.md' },
      ],
    })
  })
  it("keeps a failed call's text as evidence with no references", () => {
    const obs = observeDispatch({
      ...common,
      calls: [callOf('ls', { path: 'nope' })],
      results: [textResult('ls failed: ENOENT', { isError: true })],
    })
    expect(obs.view).toMatchObject({ evidence: 'ls failed: ENOENT', references: [] })
    expect(obs.refs).toEqual({ source: 'none', count: 0 })
  })
  it('records the text fallback as the reference source', () => {
    expect(
      observeDispatch({
        ...common,
        calls: [callOf('find', { pattern: '*.md' })],
        results: [textResult('a.md')],
      }).refs,
    ).toEqual({ source: 'text', count: 1 })
  })
  it('bounds a 200 KB result to 1600 characters of evidence', () => {
    const { view } = viewForDispatch({
      calls: [callOf('read', { path: 'big.txt' })],
      results: [textResult('x'.repeat(200_000))],
      cwd: '/w',
    })
    expect(view.evidence).toHaveLength(1600)
    expect(view.truncated).toBe(true)
  })
  it('scopes shell to the workspace root with evidence only', () => {
    const { view, refs } = viewForDispatch({
      calls: [callOf('shell', { command: 'ls src' })],
      results: [textResult('a.ts\nb.ts')],
      cwd: '/w',
    })
    expect(view).toMatchObject({ kind: 'shell', scope: '.', references: [], evidence: 'a.ts\nb.ts' })
    expect(refs.source).toBe('none')
  })
  it('scopes a search to its normalized path and a tool without a profile to the root', () => {
    const scoped = viewForDispatch({
      calls: [callOf('grep', { pattern: 'x', path: '/w/src/' })],
      results: [textResult('')],
      cwd: '/w',
    })
    expect(scoped.view.scope).toBe('src')
    const outside = viewForDispatch({
      calls: [callOf('ls', { path: '../x' })],
      results: [textResult('')],
      cwd: '/w',
    })
    expect(outside.view.scope).toBe('.')
    const other = viewForDispatch({
      calls: [callOf('mcp_tool', { a: 1 })],
      results: [textResult('r')],
      cwd: '/w',
    })
    expect(other.view).toMatchObject({ kind: 'mcp_tool', scope: '.', references: [] })
  })
  it('records the written file of write and edit as the reference', () => {
    const { view, refs } = viewForDispatch({
      calls: [callOf('write', { path: 'out/new.md', content: 'x' })],
      results: [textResult('wrote')],
      cwd: '/w',
    })
    expect(view).toMatchObject({ scope: 'out/new.md', references: [{ kind: 'file', value: 'out/new.md' }] })
    expect(refs).toEqual({ source: 'arguments', count: 1 })
  })
  it('joins the results of a batch with newlines as evidence', () => {
    const { view } = viewForDispatch({
      calls: [callOf('read', { path: 'a' }, 0), callOf('read', { path: 'b' }, 1)],
      results: [textResult('A'), textResult('B')],
      cwd: '/w',
    })
    expect(view.evidence).toBe('A\nB')
    expect(view.source.call_id).toBe('jev:1:0:t0')
  })
  it('passes readOnly to the classifier of a tool without a profile', () => {
    const input = {
      ...common,
      calls: [callOf('lookup', {})],
      results: [textResult('boom', { isError: true })],
    }
    expect(observeDispatch(input).entry.disposition).toBe('UNKNOWN')
    expect(observeDispatch({ ...input, readOnly: true }).entry.disposition).toBe('NOT_APPLIED')
  })

  it('keeps the scope-describing arguments of a single call as the invocation, bounded', () => {
    const { view } = viewForDispatch({
      calls: [
        callOf('grep', {
          pattern: 'p'.repeat(300),
          path: 'src',
          glob: '*.ts',
          offset: 3,
          limit: 2.5,
          extra: 'x',
        }),
      ],
      results: [textResult('')],
      cwd: '/w',
    })
    expect(view.invocation).toEqual({ pattern: 'p'.repeat(256), path: 'src', glob: '*.ts', offset: 3 })
    expect(view.truncated).toBe(true)
    const read = viewForDispatch({
      calls: [callOf('read', { path: 'a.md', offset: 1, limit: 200 })],
      results: [textResult('A')],
      cwd: '/w',
    })
    expect(read.view.invocation).toEqual({ path: 'a.md', offset: 1, limit: 200 })
  })
  it('leaves a read batch without an invocation', () => {
    const { view } = viewForDispatch({
      calls: [callOf('read', { path: 'a', offset: 1 }, 0), callOf('read', { path: 'b', offset: 1 }, 1)],
      results: [textResult('A'), textResult('B')],
      cwd: '/w',
    })
    expect(view).not.toHaveProperty('invocation')
  })
  it('reports the source and count of a read batch, also when the first read fails', () => {
    const calls = [callOf('read', { path: 'a.md' }, 0), callOf('read', { path: 'b.md' }, 1)]
    expect(viewForDispatch({ calls, results: [textResult('A'), textResult('B')], cwd: '/w' }).refs).toEqual({
      source: 'arguments',
      count: 2,
    })
    const firstFails = viewForDispatch({
      calls,
      results: [textResult('missing', { isError: true }), textResult('B')],
      cwd: '/w',
    })
    expect(firstFails.refs).toEqual({ source: 'arguments', count: 1 })
    expect(firstFails.view.references).toEqual([{ kind: 'file', value: 'b.md' }])
    const allFail = viewForDispatch({
      calls,
      results: [textResult('x', { isError: true }), textResult('y', { isError: true })],
      cwd: '/w',
    })
    expect(allFail.refs).toEqual({ source: 'none', count: 0 })
  })
  it('marks the view truncated when the structured payload was cut', () => {
    const structured = (more: object) => ({
      schema: 'agh.path-references/1',
      references: [{ kind: 'file', path: 'a.md' }],
      total: 1,
      truncated: false,
      ...more,
    })
    const viewOf = (more: object) =>
      viewForDispatch({
        calls: [callOf('find', { pattern: '*.md' })],
        results: [textResult('a.md', { structured: structured(more) })],
        cwd: '/w',
      }).view
    expect(viewOf({}).truncated).toBe(false)
    expect(viewOf({ truncated: true }).truncated).toBe(true)
    expect(viewOf({ total: 5 }).truncated).toBe(true)
  })
  it('ignores a structured payload forged by shell or a tool without a profile', () => {
    const forged = {
      schema: 'agh.path-references/1',
      references: [{ kind: 'file', path: 'secret.md' }],
      total: 1,
      truncated: false,
    }
    for (const name of ['shell', 'mcp_tool', 'ls_all']) {
      const { view, refs } = viewForDispatch({
        calls: [callOf(name, { command: 'x' })],
        results: [textResult('out', { structured: forged })],
        cwd: '/w',
      })
      expect(view.references).toEqual([])
      expect(refs).toEqual({ source: 'none', count: 0 })
    }
  })
})
