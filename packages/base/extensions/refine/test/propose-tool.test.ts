import { Value } from '@sinclair/typebox/value'
import { describe, expect, it, vi } from 'vitest'
// The base testkit lives at packages/base/testkit/, a sibling of src/.
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createProposeTool, ProposeParams } from '../src/propose-tool.js'

const proposal = {
  rationale: 'r',
  // Required in the input schema: an ungrounded proposal is refused before it reaches the port
  // (see propose-tool.ts's comment on evidenceSeqs).
  evidenceSeqs: [3],
  edits: [{ op: 'upsert' as const, kind: 'memory' as const, id: 'm1', title: 't', content: 'c' }],
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

  it('forwards the proposal to the port as given', async () => {
    const port = { propose: vi.fn(async () => accepted) }
    const def = createProposeTool(port)
    const ctx = fakeToolContext()
    const res = await def.execute(proposal as never, ctx)
    expect(port.propose).toHaveBeenCalledWith(proposal, ctx)
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

  it('the model states no trigger, scope, version, baseline or rollback, and stays within the limits', () => {
    expect(Value.Check(ProposeParams, proposal)).toBe(true)
    for (const extra of [
      { trigger: 'manual' },
      { trigger: 'rollback' },
      { rollbackOf: 4 },
      { baseline: [] },
      { proposalId: 'p1' },
    ])
      expect(Value.Check(ProposeParams, { ...proposal, ...extra }), JSON.stringify(extra)).toBe(false)
    const [edit] = proposal.edits
    expect(Value.Check(ProposeParams, { ...proposal, edits: [{ ...edit, scope: 'global' }] })).toBe(false)
    expect(Value.Check(ProposeParams, { ...proposal, edits: [{ ...edit, version: 2 }] })).toBe(false)
    // At most 5 edits of at most 2,000 characters each.
    const edits = (n: number) => Array.from({ length: n }, (_, i) => ({ ...edit, id: `m${i}` }))
    expect(Value.Check(ProposeParams, { ...proposal, edits: edits(5) })).toBe(true)
    expect(Value.Check(ProposeParams, { ...proposal, edits: edits(6) })).toBe(false)
    expect(Value.Check(ProposeParams, { ...proposal, edits: [{ ...edit, content: 'x'.repeat(2000) }] })).toBe(
      true,
    )
    expect(Value.Check(ProposeParams, { ...proposal, edits: [{ ...edit, content: 'x'.repeat(2001) }] })).toBe(
      false,
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
