import { Value } from '@sinclair/typebox/value'
import { describe, expect, it, vi } from 'vitest'
// The plan's own sample imports this from '../../../src/testkit/tool-context.js', which does not
// exist: the real testkit lives at packages/base/testkit/ (a sibling of src/, not inside it). Three
// '../' from this test dir lands on packages/base/, so the real path is '../../../testkit/...'.
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createProposeTool, ProposeParams } from '../src/propose-tool.js'

const proposal = {
  proposalId: 'p1',
  trigger: 'manual' as const,
  rationale: 'r',
  // Required on the real RefineProposal (core/src/effects/seams.ts:145) and read by Task 19's
  // gateT0 as `evidenceSeqs.length` - the plan's own Step 7 schema omitted this field entirely
  // (see propose-tool.ts's doc comment), which would have let `args as never` smuggle `undefined`
  // through and crash gateT0 the first time a real proposal reached it.
  evidenceSeqs: [3],
  edits: [{ op: 'upsert' as const, entry: { kind: 'memory' as const, id: 'm1', title: 't', content: 'c' } }],
}

describe('harness_propose tool', () => {
  it('declares meta that keeps it out of the destructive path', () => {
    const seam = { propose: vi.fn(async () => 'queued' as const) }
    const def = createProposeTool(seam)
    expect(def.name).toBe('harness_propose')
    expect(def.meta).toMatchObject({
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
      requiresApproval: undefined,
    })
  })

  it('is deferred rather than eagerly disclosed (regression pin, see propose-tool.ts deferLoading comment)', () => {
    // core's discloseTools (core/src/step/inference.ts:50) treats `deferLoading !== true` as eager
    // and shows the tool in every request's system prompt. The plan's own Step 7 sample left this
    // `undefined` (= eager), which broke two host replay fixtures that hardcode an exact tool count
    // the moment harness_propose became a real, listed extension - see this task's report.
    const seam = { propose: vi.fn(async () => 'queued' as const) }
    expect(createProposeTool(seam).meta.deferLoading).toBe(true)
  })

  it('forwards the proposal to the seam, stamping source and defaulting scope/baseline', async () => {
    const seam = { propose: vi.fn(async () => 'queued' as const) }
    const def = createProposeTool(seam)
    const res = await def.execute(proposal as never, fakeToolContext())
    // HarnessEntry.source (core/src/reduce/shapes.ts:53) is required but neither the plan's Step 1
    // test sample nor its Step 7 Entry schema account for it (see propose-tool.ts's doc comment for
    // the design call this stamping implements). `scope` and `baseline` are likewise real-required
    // fields the input schema leaves optional/absent, defaulted here rather than in the schema.
    expect(seam.propose).toHaveBeenCalledWith({
      proposalId: 'p1',
      trigger: 'manual',
      rationale: 'r',
      evidenceSeqs: [3],
      baseline: [],
      edits: [
        {
          op: 'upsert',
          entry: {
            kind: 'memory',
            id: 'm1',
            title: 't',
            content: 'c',
            scope: 'local',
            source: 'harness_propose',
          },
        },
      ],
    })
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain('queued')
  })

  it('preserves an explicitly stated scope and baseline instead of overriding them', async () => {
    const seam = { propose: vi.fn(async () => 'queued' as const) }
    const def = createProposeTool(seam)
    const withScope = {
      ...proposal,
      baseline: [{ key: 'memory/m1', version: 2 }],
      edits: [
        {
          op: 'upsert' as const,
          entry: { kind: 'memory' as const, id: 'm1', title: 't', content: 'c', scope: 'global' as const },
        },
      ],
    }
    await def.execute(withScope as never, fakeToolContext())
    expect(seam.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        baseline: [{ key: 'memory/m1', version: 2 }],
        edits: [
          { op: 'upsert', entry: expect.objectContaining({ scope: 'global', source: 'harness_propose' }) },
        ],
      }),
    )
  })

  it('a rejected proposal is a normal result, not a throw', async () => {
    const seam = { propose: vi.fn(async () => 'rejected' as const) }
    const res = await createProposeTool(seam).execute(proposal as never, fakeToolContext())
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('rejected')
  })

  it('the delete-edit schema branch uses the real HarnessEdit op literal "delete", not "remove"', () => {
    // Regression pin: the plan's own Step 7 schema sample used `op: Type.Literal('remove')` here,
    // inconsistent with its own Step 3 seam.ts sample, which imports the real HarnessEdit type
    // (core/src/reduce/shapes.ts:129-131, spelled 'delete'). Checked against the schema itself
    // rather than only through execute(), so a future edit that reintroduces 'remove' fails here
    // even if some caller happens to route around execute().
    const del = {
      proposalId: 'p2',
      trigger: 'manual',
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ op: 'delete', kind: 'memory', id: 'm1' }],
    }
    expect(Value.Check(ProposeParams, del)).toBe(true)
    expect(Value.Check(ProposeParams, { ...del, edits: [{ op: 'remove', kind: 'memory', id: 'm1' }] })).toBe(
      false,
    )
  })
})
