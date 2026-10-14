import { jcs, type McpServerDefinitionInput, type McpStatus } from '@agnes/protocol'
import type { McpRow } from './mcp.js'

/** True when two definitions differ only in `toolDisclosure` (an omitted mode is `auto`). */
function onlyDisclosureChanged(before: McpServerDefinitionInput, after: McpServerDefinitionInput): boolean {
  const { toolDisclosure: was, ...restBefore } = before
  const { toolDisclosure: now, ...restAfter } = after
  return (was ?? 'auto') !== (now ?? 'auto') && jcs(restBefore) === jcs(restAfter)
}

/**
 * The journal row a create or update writes. Any edit needs review again, so the row starts
 * untrusted (keeping the requested enablement) -- except an update that changes only how tools reach
 * the model: nothing that runs or connects changed, so trust, enablement and a local start approval
 * carry over to the new revision.
 */
export function definedRow(
  /** The current row on update; a create never has one. */
  prior: McpRow | undefined,
  definition: McpServerDefinitionInput,
  revision: string,
  unavailable: McpStatus,
): McpRow {
  if (prior && onlyDisclosureChanged(prior.definition, definition))
    return {
      ...prior,
      definition,
      revision,
      ...(prior.localStartApproval ? { localStartApproval: revision } : {}),
    }
  return {
    definition,
    revision,
    trust: 'untrusted',
    desired: prior?.desired ?? 'disabled',
    status: unavailable,
  }
}
