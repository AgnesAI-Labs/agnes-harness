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
  // Required on the real RefineProposal and in the input schema: an ungrounded proposal is refused
  // before it reaches the port (see propose-tool.ts's doc comment on evidenceSeqs).
  evidenceSeqs: [3],
  edits: [{ op: 'upsert' as const, entry: { kind: 'memory' as const, id: 'm1', title: 't', content: 'c' } }],
}

/** Whatever the port answers is the tool's result; the tool adds no verdict text of its own. */
const accepted = { content: [{ type: 'text' as const, text: 'accepted' }] }

describe('harness_propose tool', () => {
  it('declares meta that keeps it out of the destructive path', () => {
    const port = { propose: vi.fn(async () => accepted) }
    const def = createProposeTool(port)
    expect(def.name).toBe('harness_propose')
    expect(def.meta.requiresApproval).toBeUndefined()
    expect(def.meta).toMatchObject({
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
    })
  })

  it('is deferred rather than eagerly disclosed (regression pin, see propose-tool.ts deferLoading comment)', () => {
    // core's discloseTools (core/src/execution/turn/inference.ts) treats `deferLoading !== true` as
    // eager and shows the tool in every request's system prompt; eager registration also changes the
    // tool count the host replay fixtures pin.
    const port = { propose: vi.fn(async () => accepted) }
    expect(createProposeTool(port).meta.deferLoading).toBe(true)
  })

  it('forwards the proposal to the port, stamping source and defaulting scope/baseline', async () => {
    const port = { propose: vi.fn(async () => accepted) }
    const def = createProposeTool(port)
    const ctx = fakeToolContext()
    const res = await def.execute(proposal as never, ctx)
    // HarnessEntry.source (core/src/reduce/shapes.ts:53) is required but neither the plan's Step 1
    // test sample nor its Step 7 Entry schema account for it (see propose-tool.ts's doc comment for
    // the design call this stamping implements). `scope` and `baseline` are likewise real-required
    // fields the input schema leaves optional/absent, defaulted here rather than in the schema.
    expect(port.propose).toHaveBeenCalledWith(
      {
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
      },
      ctx,
    )
    expect(res).toBe(accepted)
  })

  it('an explicit session target is the default and is not passed on as part of the proposal', async () => {
    const propose = vi.fn(async (_proposal: unknown, _ctx: unknown) => accepted)
    await createProposeTool({ propose }).execute(
      { ...proposal, target: 'session' } as never,
      fakeToolContext(),
    )
    expect(propose.mock.calls[0]?.[0]).not.toHaveProperty('target')
    expect(Value.Check(ProposeParams, { ...proposal, target: 'session' })).toBe(true)
    expect(Value.Check(ProposeParams, { ...proposal, target: 'workspace' })).toBe(true)
    expect(Value.Check(ProposeParams, { ...proposal, target: 'global' })).toBe(false)
  })

  it('preserves an explicitly stated scope and baseline instead of overriding them', async () => {
    const port = { propose: vi.fn(async () => accepted) }
    const def = createProposeTool(port)
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
    expect(port.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        baseline: [{ key: 'memory/m1', version: 2 }],
        edits: [
          { op: 'upsert', entry: expect.objectContaining({ scope: 'global', source: 'harness_propose' }) },
        ],
      }),
      expect.anything(),
    )
  })

  it("passes the port's refusal through as a normal result, not a throw", async () => {
    const refused = { content: [{ type: 'text' as const, text: 'refused' }], isError: true }
    const port = { propose: vi.fn(async () => refused) }
    const res = await createProposeTool(port).execute(proposal as never, fakeToolContext())
    expect(res).toBe(refused)
  })

  it('the delete-edit schema branch uses the real HarnessEdit op literal "delete", not "remove"', () => {
    // Regression pin: the real HarnessEdit (core/src/reduce/shapes.ts) spells the delete variant
    // 'delete'. Checked against the schema itself rather than only through execute(), so a future
    // edit that reintroduces 'remove' fails here even if some caller routes around execute().
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
