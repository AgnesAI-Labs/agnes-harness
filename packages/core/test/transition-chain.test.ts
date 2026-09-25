import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { type OpStateObj, opMarkData, type ToolCallState, withPhase } from '../src/step/op-state.js'
import type { SessionImpl } from '../src/step/session.js'
import type { IdMinter } from '../src/types.js'
import { fakeProvider, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, openWorldTool, readTool } from './helpers/open-session.js'

/** Counted ids, so two sessions driven the same way write the same rows. */
const countedIds = (): IdMinter => {
  let n = 0
  const next = () => String(++n).padStart(32, '0')
  return {
    ulid: () => next().slice(-26),
    effectId: () => `e-${next()}`,
    toolUseId: (ordinal) => `t${ordinal}-${next()}`,
    requestId: () => `r-${next()}`,
    nonce: () => next(),
  }
}

/** A session in the tools phase with one planned call to `tool`. */
async function atTools(tool: unknown = readTool(), name = 'read') {
  const registry = new ToolRegistry()
  registry.add(tool as never, { source: 's', trust: 'builtin' })
  const h = await openSession({ provider: fakeProvider([toolTurn(name, {})]), registry, ids: countedIds() })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  await h.session.acceptInput()
  await h.session.runInference()
  expect(h.session.op()?.phase.kind).toBe('tools')
  return h
}

const callOf = (op: OpStateObj | null): ToolCallState => {
  if (op?.phase.kind !== 'tools') throw new Error('expected tools phase')
  return op.phase.batch.calls[0] as ToolCallState
}

const withStatus = (op: OpStateObj | null, status: 'planned' | 'awaiting_approval' | 'approved') => {
  if (op?.phase.kind !== 'tools') throw new Error('expected tools phase')
  return withPhase(op, {
    ...op.phase,
    batch: {
      ...op.phase.batch,
      calls: op.phase.batch.calls.map((call) => ({ ...call, status }) as ToolCallState),
    },
  })
}

const plan = (s: SessionImpl, id: string) =>
  s.ev('plan.items', { items: [{ id, text: id, status: 'todo' }] }, { register: 'plan.items' })

/** The rows a session holds, without the per-row id and timestamp. */
const rowsOf = async (h: Awaited<ReturnType<typeof atTools>>) =>
  (await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq })).map(({ id: _id, ts: _ts, ...row }) => row)

describe('transitionChain', () => {
  it('computes each step from the one before it, at the seq its own first row lands on, and returns each step its own rows', async () => {
    const h = await atTools()
    const head = h.log.lastSeq
    const commits = h.opWrites().length
    const seen: Array<{ status: string; nextSeq: number }> = []
    /** A step that notes what it was handed and moves the call to `status`. */
    const noting =
      (status: 'awaiting_approval' | 'approved') => (cur: OpStateObj | null, nextSeq: number) => {
        seen.push({ status: callOf(cur).status, nextSeq })
        return withStatus(cur, status)
      }
    const seqs = await h.session.transitionChain([
      { events: [], next: noting('approved') },
      { events: [plan(h.session, 'a'), plan(h.session, 'b')], next: noting('awaiting_approval') },
      { events: [plan(h.session, 'c')], next: noting('approved') },
    ])
    expect(seen).toEqual([
      { status: 'planned', nextSeq: head + 1 },
      { status: 'approved', nextSeq: head + 1 },
      { status: 'awaiting_approval', nextSeq: head + 3 },
    ])
    expect(seqs).toEqual([[], [head + 1, head + 2], [head + 3]])
    // One commit, rows only: no op-mark beside rows of its own.
    const rows = await h.log.scan({ fromSeq: head + 1, toSeq: h.log.lastSeq })
    expect(rows.map((row) => row.type)).toEqual(['plan.items', 'plan.items', 'plan.items'])
    // Only the last step's value reaches the cell, at the batch's last row.
    const writes = h.opWrites().slice(commits)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.seq).toBe(head + 3)
    expect(callOf(writes[0]?.data as OpStateObj).status).toBe('approved')
    expect(h.session.opSeq()).toBe(head + 3)
  })

  it('leaves one op-mark, from the first value to the last, when no step has a row', async () => {
    const h = await atTools()
    const head = h.log.lastSeq
    const first = h.session.op()
    const seqs = await h.session.transitionChain([
      { events: [], next: (cur) => withStatus(cur, 'awaiting_approval') },
      { events: [], next: (cur) => withStatus(cur, 'approved') },
    ])
    expect(seqs).toEqual([[], [head + 1]])
    const rows = await h.log.scan({ fromSeq: head + 1, toSeq: h.log.lastSeq })
    expect(rows.map((row) => row.type)).toEqual(['x/core/op-mark'])
    expect(rows[0]?.data).toEqual(opMarkData(first, h.session.op()))
    expect(rows[0]?.data).toMatchObject({ phase: 'tools', calls: [{ status: 'approved' }] })
  })

  it('as one function-form step, commits exactly what transition commits', async () => {
    const a = await atTools()
    const b = await atTools()
    const next = (cur: OpStateObj | null) => withStatus(cur, 'approved')
    expect(await a.session.transition([plan(a.session, 'x')], next)).toEqual(
      (await b.session.transitionChain([{ events: [plan(b.session, 'x')], next }]))[0],
    )
    expect(await a.session.transition([], next)).toEqual(
      (await b.session.transitionChain([{ events: [], next }]))[0],
    )
    expect(await rowsOf(b)).toEqual(await rowsOf(a))
    expect(b.opWrites()).toEqual(a.opWrites())
  })

  it('as one value-form step, commits exactly what transition commits', async () => {
    const a = await atTools()
    const b = await atTools()
    const value = withStatus(a.session.op(), 'approved')
    expect(await a.session.transition([], value)).toEqual(
      (await b.session.transitionChain([{ events: [], next: () => value }]))[0],
    )
    expect(await rowsOf(b)).toEqual(await rowsOf(a))
    expect(b.opWrites()).toEqual(a.opWrites())
  })

  it('reads the lane taint once: a row of its own does not taint the value it commits with', async () => {
    const h = await atTools(openWorldTool(), 'fetch_page')
    const call = callOf(h.session.op())
    const result = h.session.ev(
      'tool/result',
      {
        toolUseId: call.toolUseId,
        content: [{ type: 'text', text: 'from the web' }],
        isError: false,
        enforcement: h.session.d.runtime.enforcement(),
        authz: { decisionId: 'n/a' },
      },
      { trust: 'untrusted', origin: 'tool:fetch_page', sourceEventSeqs: [call.argsSeq] },
    )
    expect(h.session.laneTaint()).toBe(false)
    await h.session.transitionChain([
      { events: [result], next: (cur) => withStatus(cur, 'approved') },
      { events: [], next: (cur) => cur },
    ])
    expect(h.session.op()?.taint).toBe(false)
    expect(h.session.laneTaint()).toBe(true)
    // Once the fold is tainted, the first step's value carries it and every later step sees it.
    const seen: boolean[] = []
    await h.session.transitionChain([
      { events: [], next: (cur) => withStatus(cur, 'awaiting_approval') },
      {
        events: [],
        next: (cur) => {
          seen.push(cur?.taint === true)
          return withStatus(cur, 'approved')
        },
      },
    ])
    expect(seen).toEqual([true])
    expect(h.session.op()?.taint).toBe(true)
  })

  it('refuses an empty chain', async () => {
    const h = await atTools()
    expect(() => h.session.transitionChain([])).toThrow('at least one step')
  })
})
