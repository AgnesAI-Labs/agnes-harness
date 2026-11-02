import type { HarnessEntry, RefineProposal } from '@agnes/core'
import { defineTool } from '@agnes/plugin-runtime'
import { type Static, Type } from '@sinclair/typebox'
import { type RefinementToolPort, workspaceTargetUnavailable } from './port.js'

// Every entry this tool proposes is stamped with this fixed provenance. `source` is a required
// HarnessEntry field stamped here by execute(), not accepted as tool input.
// A model proposing a change to its own prompts/
// memory/skills/subagents has no legitimate claim to make about that entry's *provenance* - letting
// the caller supply an arbitrary `source` string would let a proposal assert a provenance it did
// not have. Substantive justification (which events motivated the proposal) is a separate thing the
// model *does* have first-hand knowledge of, so that lives in `evidenceSeqs` as real, required input
// instead (see ProposeParams below).
const PROPOSAL_SOURCE = 'harness_propose'

export const EntryKind = Type.Union([
  Type.Literal('prompt'),
  Type.Literal('memory'),
  Type.Literal('skill'),
  Type.Literal('subagent'),
])

const Entry = Type.Object(
  {
    kind: EntryKind,
    id: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 256 }),
    content: Type.String({ maxLength: 8192 }),
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('global')])),
  },
  { additionalProperties: false },
)

/** Where a refinement lands: this session (the default) or the workspace. */
export const Target = Type.Union([Type.Literal('session'), Type.Literal('workspace')])

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
    // RefineProposal.evidenceSeqs is required. Required and non-empty here, rather than defaulted: an
    // ungrounded self-modification proposal is exactly what evidence-citing exists to prevent, so
    // there is no safe default.
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
        // The real HarnessEdit (core/src/reduce/shapes.ts) spells the delete variant `op: 'delete'`;
        // see test/propose-tool.test.ts for the schema-level regression pin.
        Type.Object(
          { op: Type.Literal('delete'), kind: EntryKind, id: Type.String({ maxLength: 128 }) },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 20 },
    ),
    target: Type.Optional(Target),
  },
  { additionalProperties: false },
)

type ProposeArgs = Static<typeof ProposeParams>

/** A proposal for this session, as the refinement port receives it. */
export type SessionProposal = RefineProposal

/** Fills the required RefineProposal/HarnessEntry fields the input schema deliberately leaves out
 * or optional - see the doc comments on PROPOSAL_SOURCE and ProposeParams above for why each one
 * is a stamped default rather than caller input. The target routes the call; it is not part of
 * the proposal. */
function toRealProposal(args: ProposeArgs): SessionProposal {
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
export function createProposeTool(port: Pick<RefinementToolPort, 'propose'>) {
  return defineTool({
    name: 'harness_propose',
    description:
      "Submit a structured change to this session's prompts, memory, Skills or child-agent definitions, citing the event seqs that justify it. The change is checked and, if accepted, takes effect from a later turn; there is no direct write path.",
    parameters: ProposeParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
      // Deferred, never eager: core's discloseTools (core/src/execution/turn/inference.ts) treats
      // `deferLoading !== true` as eager and lists the tool in every request's system prompt, which
      // also changes the eager-tool count the host replay fixtures pin. A self-modification tool is
      // not advertised beside every ordinary coding tool; it is reachable through the deferred list.
      deferLoading: true,
    },
    async execute(args, ctx) {
      if (args.target === 'workspace') return workspaceTargetUnavailable()
      return port.propose(toRealProposal(args), ctx)
    },
  })
}
