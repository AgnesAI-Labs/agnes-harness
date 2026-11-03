import { defineTool } from '@agnes/plugin-runtime'
import { type Static, Type } from '@sinclair/typebox'
import type { RefinementToolPort, SessionProposal } from './port.js'

export const EntryKind = Type.Union([
  Type.Literal('prompt'),
  Type.Literal('memory'),
  Type.Literal('skill'),
  Type.Literal('subagent'),
])

/**
 * Where a refinement lands: this session (the default) or, as well, the session's workspace. Saving to
 * the workspace is always the model's own save: it states no one else, and the host decides the rest.
 */
export const Target = Type.Union([Type.Literal('session'), Type.Literal('workspace')])

// The model states what to change and why, citing the events that justify it. It never states who
// asked, the scope, an entry version or the trigger: the host stamps those, and a rollback is a
// control operation of its own, never a proposal.
export const ProposeParams = Type.Object(
  {
    rationale: Type.String({ minLength: 1, maxLength: 2048 }),
    // Required and non-empty: an ungrounded self-modification proposal is exactly what citing
    // evidence exists to prevent, so there is no safe default.
    evidenceSeqs: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 20 }),
    edits: Type.Array(
      Type.Union([
        Type.Object(
          {
            op: Type.Literal('upsert'),
            kind: EntryKind,
            id: Type.String({ minLength: 1, maxLength: 128 }),
            title: Type.String({ minLength: 1, maxLength: 256 }),
            content: Type.String({ minLength: 1, maxLength: 2000 }),
            // Skill and subagent only, checked by the host: never a grant of tools, models or access.
            reference: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 512,
                description:
                  'Skill or subagent only: the approved resource this entry uses, as "<resourceId>@<revision>" of an enabled, trusted Skill or the role ref subagent_spawn takes.',
              }),
            ),
          },
          { additionalProperties: false },
        ),
        // The real HarnessEdit spells the delete variant `op: 'delete'`; see
        // test/propose-tool.test.ts for the schema-level regression pin.
        Type.Object(
          { op: Type.Literal('delete'), kind: EntryKind, id: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 5 },
    ),
    target: Type.Optional(Target),
  },
  { additionalProperties: false },
)

type ProposeArgs = Static<typeof ProposeParams>

/** The proposal as the port receives it: the target routes the call and is not part of it. */
function toProposal(args: ProposeArgs): SessionProposal {
  return { rationale: args.rationale, evidenceSeqs: args.evidenceSeqs, edits: args.edits }
}

// 拍板 Q2（2026-09-08）：模型面入口是普通工具，不给 ToolContext 加 harness 成员。
export function createProposeTool(port: Pick<RefinementToolPort, 'propose'>) {
  return defineTool({
    name: 'harness_propose',
    description:
      "Submit a structured change to this session's prompts, memory, Skills or child-agent definitions (at most 5 entries of at most 2,000 characters each), citing the event seqs that justify it. A new id adds an entry; to replace or delete a saved entry, first read it in full with harness_inspect (op 'get'). The change is checked and, if accepted, takes effect from a later turn (a deleted entry is withdrawn there); there is no direct write path.",
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
      if (args.target === 'workspace') return port.propose(toProposal(args), ctx, 'workspace')
      return port.propose(toProposal(args), ctx)
    },
  })
}
