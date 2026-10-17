import { describe, expect, it } from 'vitest'
import { dispatchCalls, observeDispatch, replayCalls } from '../src/dispatch.js'
import type { PendingCall } from '../src/types.js'

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
