import type { UINode } from '@agnes/protocol'

type SaveNode = Extract<UINode, { kind: 'refinement-save' }>

const STATE: Record<SaveNode['state'], string> = {
  saved: 'saved to workspace memory',
  installed: 'installed',
  'awaiting-approval': 'waiting for your approval',
  refused: 'not saved',
  unknown: 'unknown result',
}

const INITIATOR: Record<NonNullable<SaveNode['initiator']>, string> = {
  auto: 'automatic',
  user: 'you',
  model: 'the model',
}

const REASON: Record<string, string> = {
  'refinement-off': 'task experience is off',
  'user-revoked': 'you removed or withdrew this before; only your own save brings it back',
  unconfirmed: 'it has not been seen to hold yet',
  'source-rules': "only session-level entries backed by this session's own evidence are saved",
  'static-check': 'it did not pass the content checks (for example, it looks like a secret)',
  'memory-off': 'workspace memory is off',
  'memory-full':
    'workspace memory is full and nothing is merged automatically; free space with /memory, then save again',
  'unsupported-provider': 'the memory provider in use cannot keep saved paragraphs',
  'subagent-review-unavailable': 'agents are not saved to the workspace',
  'child-session': 'a forked or child session does not save',
  unavailable:
    'saving is not available right now (the workspace records or the approval list could not be reached)',
  conflict: 'a person edited the paragraph or the file changed meanwhile; nothing was overwritten',
  'approval-expired': 'the approval request was not answered within 7 days',
  'user-memory-budget': 'the user memory file is full; nothing was changed or trimmed',
  'model-cannot-write-user': 'an earlier version did not let the model write user memory',
  'workflow-run-unavailable':
    'the workflow run it names is not in this session, so no skill was made from it',
  'workflow-run-not-completed':
    'the workflow run it names did not finish with every member completed, so no skill was made from it',
  'workflow-definition-too-large': 'the workflow definition does not fit in one skill file; nothing was cut',
  'workflow-already-saved': 'a skill with this workflow definition is already saved',
}

/** A promotion to user memory: what it reaches, and how it ended. */
const USER_STATE: Partial<Record<SaveNode['state'], string>> = {
  saved: 'saved to user memory (all workspaces)',
  refused: 'not saved to user memory',
  unknown: 'unknown result',
}

/**
 * One save of task experience to the workspace or user memory: outcome, who asked, why it was refused,
 * and for user memory where to withdraw it. Never its text.
 */
export function saveText(node: SaveNode): string {
  const reason =
    node.reason === undefined
      ? undefined
      : node.reason === 'user-revoked' && node.target === 'user-memory'
        ? 'this was withdrawn before; it is not saved again'
        : (REASON[node.reason] ?? node.reason)
  const toUser = node.target === 'user-memory'
  // Saved because a person asked for it: the line says so instead of naming who asked.
  const atRequest = toUser && node.state === 'saved' && node.initiator === 'user'
  const user = toUser
    ? atRequest
      ? 'saved to user memory at your request (all workspaces)'
      : USER_STATE[node.state]
    : undefined
  const by = node.initiator && !atRequest ? ` (asked by: ${INITIATOR[node.initiator]})` : ''
  if (user)
    return [
      `Task experience: ${user}${by}.`,
      node.state === 'saved'
        ? 'Every workspace that reads user memory sees it; withdraw it in the Web memory settings (Memory files), and it is not saved again.'
        : '',
      node.state === 'saved' && node.userMemoryRead === false
        ? 'This workspace does not read user memory, so it does not see it here.'
        : '',
      reason ? `Reason: ${reason}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
  return [
    `Save to workspace: ${STATE[node.state]}${by}.`,
    node.state === 'awaiting-approval'
      ? 'Answer it under Needs attention; the request is open for 7 days.'
      : '',
    node.state === 'unknown'
      ? 'If its paragraph was written, it stays hidden from the agent until you repair or remove it with /memory.'
      : '',
    reason ? `Reason: ${reason}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
