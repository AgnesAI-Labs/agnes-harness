import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { prepareEvents } from '../src/log/validate.js'
import { CoreError, type EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const base = { actor, origin: 'principal', trust: 'trusted' } as const
const AT = Date.parse('2026-09-07T00:00:00.000Z')
const ctx = { ids: defaultIds(() => AT), clock: () => AT, refineCaller: false }
const user = (): EventInput => ({
  ...base,
  type: 'user/message',
  data: { content: [{ type: 'text', text: 'hi' }] },
})

describe('prepareEvents', () => {
  it('fills lane, v, ts, id and keeps order', () => {
    const [e] = prepareEvents([user()], ctx)
    expect(e).toMatchObject({ lane: 'main', v: 1, ts: '2026-09-07T00:00:00.000Z' })
    // seq belongs to the commit transaction, so a prepared row must not carry one at all.
    expect(e).not.toHaveProperty('seq')
    expect(e?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('rejects missing trust / unknown type / tool result without enforcement', () => {
    const { trust: _t, ...noTrust } = user()
    expect(() => prepareEvents([noTrust as EventInput], ctx)).toThrow(/E_ENVELOPE/)
    expect(() => prepareEvents([{ ...base, type: 'nope/x', data: {} }], ctx)).toThrow(/E_UNKNOWN_EVENT/)
    expect(() => prepareEvents([{ ...base, type: 'nope/x', data: {}, ignorable: true }], ctx)).not.toThrow()
    // The ignorable escape hatch is narrow: it forgives an unknown `type` and nothing else. An
    // ignorable event that is also malformed elsewhere must still be rejected, otherwise setting
    // `ignorable` would wave any envelope through.
    try {
      prepareEvents(
        [{ ...base, actor: { ...actor, id: '' }, type: 'nope/x', data: {}, ignorable: true }],
        ctx,
      )
      expect.unreachable('ignorable must not excuse a malformed actor')
    } catch (err) {
      expect((err as CoreError).code).toBe('E_ENVELOPE')
      expect((err as CoreError).detail?.errors).toContainEqual(expect.objectContaining({ path: '/actor/id' }))
    }
    // enforcement / authz are required by protocol's ToolResult definition, so core does not repeat
    // the check. The assertion lands on detail.errors to prove it was that schema rule which fired,
    // and not some other check that happens to raise E_ENVELOPE too.
    try {
      prepareEvents(
        [
          {
            ...base,
            type: 'tool/result',
            data: { toolUseId: 't1', content: [], isError: false, authz: { decisionId: 'n/a' } },
          },
        ],
        ctx,
      )
      expect.unreachable('tool/result without enforcement must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CoreError)
      expect((err as CoreError).code).toBe('E_ENVELOPE')
      expect((err as CoreError).detail?.errors).toContainEqual(
        expect.objectContaining({ path: '/data', key: 'enforcement', code: 'MISSING' }),
      )
    }
  })

  it('rejects approval/decided with bad via and harness/refine from a non-refine caller', () => {
    expect(() =>
      prepareEvents(
        [
          {
            ...base,
            type: 'approval/decided',
            data: { requestId: 'a', verdict: 'allowed-once', via: 'guardian' },
          },
        ],
        ctx,
      ),
    ).not.toThrow()
    expect(() =>
      prepareEvents(
        [{ ...base, type: 'approval/decided', data: { requestId: 'a', verdict: 'rejected', via: 'magic' } }],
        ctx,
      ),
    ).toThrow(/E_ENVELOPE/)
    const refine = (): EventInput => ({
      ...base,
      type: 'harness/refine',
      data: {
        proposalId: 'p',
        trigger: 'manual',
        outcome: 'applied',
        edits: [],
        baseline: [],
        rationale: '',
      },
    })
    expect(() => prepareEvents([refine()], ctx)).toThrow(/E_ENVELOPE/)
    expect(() => prepareEvents([refine()], { ...ctx, refineCaller: true })).not.toThrow()
  })

  it('allows surfaceOp only on model-visible types and at most one replace per batch', () => {
    const rep = (): EventInput => ({
      ...base,
      type: 'assistant/message',
      data: { content: [], stopReason: 'end_turn' },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    })
    expect(() =>
      prepareEvents(
        [
          {
            ...base,
            type: 'tool/call',
            data: { toolUseId: 't', name: 'read', args: {}, ordinal: 0 },
            surfaceOp: 'append',
          },
        ],
        ctx,
      ),
    ).toThrow(/E_SURFACE_RANGE/)
    expect(() => prepareEvents([rep(), rep()], ctx)).toThrow(/E_SURFACE_RANGE/)
    expect(() => prepareEvents([rep()], ctx)).not.toThrow()
    // A replace rewrites a range of the surface, so it must name the rows it consumed.
    const { sourceEventSeqs: _s, ...noSource } = rep()
    try {
      prepareEvents([noSource as EventInput], ctx)
      expect.unreachable('replace without sourceEventSeqs must throw')
    } catch (err) {
      expect((err as CoreError).code).toBe('E_SURFACE_RANGE')
      expect((err as CoreError).message).toContain('sourceEventSeqs')
    }
  })
})
