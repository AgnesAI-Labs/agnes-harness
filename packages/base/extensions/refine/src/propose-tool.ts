import type { HarnessEntry, HarnessSeam, RefineProposal } from '@agnes/core'
import { defineTool } from '@agnes/extension-api'
import { type Static, Type } from '@sinclair/typebox'

// Every entry this tool proposes is stamped with this fixed provenance. `source` is a required
// HarnessEntry field (core/src/reduce/shapes.ts:53) that neither the plan's Step 1 test sample (an
// `as never` cast) nor its Step 7 Entry schema accounted for - a real, unresolved gap between the
// plan and the shipped core type. DESIGN CALL (flagged in this task's report for whoever implements
// Task 19, the future consumer of real HarnessEntry values off this queue): `source` is stamped
// here by execute(), not accepted as tool input. A model proposing a change to its own prompts/
// memory/skills/subagents has no legitimate claim to make about that entry's *provenance* - letting
// the caller supply an arbitrary `source` string would let a proposal assert a provenance it did
// not have. Substantive justification (which events motivated the proposal) is a separate thing the
// model *does* have first-hand knowledge of, so that lives in `evidenceSeqs` as real, required input
// instead (see ProposeParams below).
const PROPOSAL_SOURCE = 'harness_propose'

const Entry = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('prompt'),
      Type.Literal('memory'),
      Type.Literal('skill'),
      Type.Literal('subagent'),
    ]),
    id: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 256 }),
    content: Type.String({ maxLength: 8192 }),
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('global')])),
  },
  { additionalProperties: false },
)

export const ProposeParams = Type.Object(
  {
    proposalId: Type.String({ maxLength: 128 }),
    trigger: Type.Union([
      Type.Literal('auto'),
      Type.Literal('manual'),
      Type.Literal('compact'),
      Type.Literal('rollback'),
    ]),
    rationale: Type.String({ maxLength: 2048 }),
    rollbackOf: Type.Optional(Type.Integer({ minimum: 1 })),
    // RefineProposal.evidenceSeqs (seams.ts:145) is required, and Task 19's gateT0 rejects an empty
    // one as `no_evidence`. The plan's own Step 7 schema omitted this field (and `baseline`)
    // entirely, which its `seam.propose(args as never)` cast would have silently let through as
    // `undefined` - a `.length` read away from crashing the first real proposal that reached
    // gateT0. Required and non-empty here, rather than defaulted: an ungrounded self-modification
    // proposal is exactly what evidence-citing exists to prevent, so there is no safe default.
    evidenceSeqs: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 }),
    // Also required on RefineProposal, but - unlike evidenceSeqs - an add-only proposal has no
    // existing entry version to cite, so an absent baseline is a legitimate "asserts no version
    // dependency" rather than an omission to reject. Defaulted to [] in toRealProposal below.
    baseline: Type.Optional(
      Type.Array(
        Type.Object({ key: Type.String({ maxLength: 128 }), version: Type.Integer({ minimum: 0 }) }),
        { maxItems: 20 },
      ),
    ),
    edits: Type.Array(
      Type.Union([
        Type.Object({ op: Type.Literal('upsert'), entry: Entry }, { additionalProperties: false }),
        // REAL HarnessEdit (core/src/reduce/shapes.ts:129-131) spells the delete variant `op:
        // 'delete'`. The plan's own Step 7 sample used `op: Type.Literal('remove')` here - an
        // internal inconsistency in the plan's own text, since its Step 3 seam.ts sample correctly
        // imports the real HarnessEdit type and would already expect 'delete'. Corrected to the
        // real value; see test/propose-tool.test.ts for the schema-level regression pin.
        Type.Object(
          { op: Type.Literal('delete'), kind: Entry.properties.kind, id: Type.String({ maxLength: 128 }) },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
)

type ProposeArgs = Static<typeof ProposeParams>

/** Fills the required RefineProposal/HarnessEntry fields the input schema deliberately leaves out
 * or optional - see the doc comments on PROPOSAL_SOURCE and ProposeParams above for why each one
 * is a stamped default rather than caller input. */
function toRealProposal(args: ProposeArgs): RefineProposal {
  return {
    proposalId: args.proposalId,
    trigger: args.trigger,
    rationale: args.rationale,
    ...(args.rollbackOf !== undefined ? { rollbackOf: args.rollbackOf } : {}),
    evidenceSeqs: args.evidenceSeqs,
    baseline: args.baseline ?? [],
    edits: args.edits.map((e): RefineProposal['edits'][number] =>
      e.op === 'upsert'
        ? {
            op: 'upsert',
            entry: { ...e.entry, scope: e.entry.scope ?? 'local', source: PROPOSAL_SOURCE } as HarnessEntry,
          }
        : e,
    ),
  }
}

// 拍板 Q2（2026-09-08）：模型面入口是普通工具，不给 ToolContext 加 harness 成员。
export function createProposeTool(seam: Pick<HarnessSeam, 'propose'>) {
  return defineTool({
    name: 'harness_propose',
    description:
      'Propose a change to prompts, memory, skills or subagent specs. Proposals are queued and reviewed; there is no direct write path.',
    parameters: ProposeParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
      costHint: undefined,
      // THIRD self-discovered correction (see task report): the plan's own Step 7 sample wrote
      // `deferLoading: undefined` here, which core's discloseTools (core/src/step/inference.ts:50,
      // `d.meta.deferLoading !== true`) treats as eager - shown in every request's system prompt by
      // default, the same as read/write/edit/shell/etc. Measured against the real replay corpus
      // (packages/host/test/replay.test.ts, fixtures 0001-read-note and
      // 0100-killed-mid-inference-resumes both hardcode the exact eager-tool count):
      // registering harness_propose as eager changed that count and broke both. `true` here is both
      // the fix and a defensible standalone call - a self-modification tool should not be advertised
      // alongside every ordinary coding tool; a caller that specifically needs it can still reach it
      // through the deferred-tools listing (registry/tools.ts's `list({ deferred: true })`).
      deferLoading: true,
      requiresApproval: undefined,
    },
    async execute(args) {
      const verdict = await seam.propose(toRealProposal(args))
      return {
        content: [
          {
            type: 'text',
            text:
              verdict === 'queued'
                ? 'proposal queued for review'
                : 'proposal rejected (queue full or unknown kind)',
          },
        ],
        structured: { verdict },
        isError: verdict === 'rejected',
      }
    },
  })
}
