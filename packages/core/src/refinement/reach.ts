import type { RefinementPlan, RefinementTrigger } from '@agnes/core-ledger/reduce/state'

/**
 * How far a lesson may reach once it is saved: its workspace, or every workspace (user memory). The
 * planner only suggests `user`; Core grants it here, by structure alone, and the Host checks it again
 * when the lesson is promoted. Nothing here judges what a lesson means.
 */
export type RefinementReach = 'workspace' | 'user'

/** An absolute path in text: `/a/b`, `~/a`, `C:\a` or `C:/a`, at the start or after a space or quote. */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=[<])(?:\/[^\s/"'`]+\/|~[\\/]|[A-Za-z]:[\\/])/u
/** A word of letters, digits, `.`, `_` or `-`, as a workspace folder name is matched in text. */
const wordAt = (text: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}._-])${escaped}(?:$|[^\\p{L}\\p{N}_-])`, 'iu').test(text)
}

/**
 * Whether text names a particular workspace: it holds an absolute path, the workspace's root, or the
 * root's last folder name as a word (letter case ignored). Text that does is kept to its workspace.
 */
export function namesWorkspace(text: string, workspaceRoot: string): boolean {
  if (ABSOLUTE_PATH.test(text)) return true
  const root = workspaceRoot.replace(/[\\/]+$/u, '')
  if (root && text.toLowerCase().includes(root.toLowerCase())) return true
  const folder = root.split(/[\\/]/u).pop() ?? ''
  return folder.length > 0 && wordAt(text, folder)
}

type Upsert = Extract<RefinementPlan['edits'][number], { op: 'upsert' }>

/**
 * The reach a planned upsert may keep. Only `user` is ever kept, and only when all of these hold:
 * - the planner asked for it, on a prompt or memory entry;
 * - the run is a maintenance plan the model did not start (never a `model` trigger: neither the model's
 *   review nor its direct proposal), and no one asked for its result to go to the workspace;
 * - the entry holds for the session on a verbatim quote of the user's own request: evidence from tool
 *   output alone never backs it;
 * - its title and content name no workspace (`namesWorkspace`).
 * Anything else stays at workspace reach.
 */
export function checkedReach(
  edit: Pick<Upsert, 'kind' | 'title' | 'content' | 'applicability' | 'usedEvidence'> & { reach?: string },
  trigger: Pick<RefinementTrigger, 'kind' | 'saveTo'>,
  workspace: { root: string },
): RefinementReach {
  if (edit.reach !== 'user') return 'workspace'
  if (edit.kind !== 'prompt' && edit.kind !== 'memory') return 'workspace'
  if (trigger.kind === 'model' || trigger.saveTo === 'workspace') return 'workspace'
  if (edit.applicability !== 'session') return 'workspace'
  if (!(edit.usedEvidence ?? []).some((identity) => identity.startsWith('user:'))) return 'workspace'
  if (namesWorkspace(`${edit.title}\n${edit.content}`, workspace.root)) return 'workspace'
  return 'user'
}

/** The plan with `reach: 'user'` kept only on the upserts `checkedReach` grants it to. */
export function grantReach(
  plan: RefinementPlan,
  trigger: Pick<RefinementTrigger, 'kind' | 'saveTo'>,
  workspace: { root: string },
): RefinementPlan {
  if (!plan.edits.some((edit) => edit.op === 'upsert' && edit.reach !== undefined)) return plan
  return {
    ...plan,
    edits: plan.edits.map((edit) => {
      if (edit.op !== 'upsert' || edit.reach === undefined) return edit
      const { reach: _asked, ...rest } = edit
      return checkedReach(edit, trigger, workspace) === 'user' ? { ...rest, reach: 'user' as const } : rest
    }),
  }
}
