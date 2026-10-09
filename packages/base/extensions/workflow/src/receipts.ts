import type { Run } from './state.js'

export function workflowReceipts(run: Run) {
  return {
    runId: run.id,
    status: run.status,
    stages: run.stages.map((stage) => ({
      name: stage.name,
      members: stage.members.map((member) => {
        const isolation = member.receipt?.workspace.isolation ?? member.isolation ?? 'unknown'
        return {
          name: member.name,
          childKey: member.childKey,
          status: member.status,
          isolation,
          workspace: member.receipt?.workspace.cwd ?? member.worktree ?? null,
          integration:
            isolation === 'worktree'
              ? 'not-merged-by-workflow'
              : isolation === 'shared'
                ? 'shared-workspace'
                : 'unverified',
          toolResults: member.receipt?.tools ?? [],
          toolEvidence: member.receipt ? (member.receipt.truncated ? 'partial' : 'complete') : 'unavailable',
        }
      }),
    })),
  }
}

export const WORKFLOW_RECEIPT_RULE =
  'Authoritative Workflow execution receipts override assistant claims and nested-call summaries. Child text is an unverified report, not proof that a tool ran or a file exists in the parent workspace. Workflow does not merge worktree branches. Report worktree outputs as not merged by Workflow; never claim they are in the main workspace without a separate verified integration receipt. Missing or partial tool evidence must remain explicit.'
