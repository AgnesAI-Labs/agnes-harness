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
  auto: 'automatic, after two confirmations',
  user: 'you',
  model: 'the model',
}

const REASON: Record<string, string> = {
  'refinement-off': 'task experience is off',
  'user-revoked': 'you removed or withdrew this before; only your own save brings it back',
  unconfirmed: 'it has not been confirmed twice yet',
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
}

/** One save of task experience to the workspace: outcome, who asked, why it was refused. Never its text. */
export function saveText(node: SaveNode): string {
  const reason = node.reason === undefined ? undefined : (REASON[node.reason] ?? node.reason)
  return [
    `Save to workspace: ${STATE[node.state]}${node.initiator ? ` (asked by: ${INITIATOR[node.initiator]})` : ''}.`,
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
