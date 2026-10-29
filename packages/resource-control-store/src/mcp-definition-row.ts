import { jcs, type McpServerDefinitionInput, type McpStatus } from '@agnes/protocol'
import type { McpRow } from './mcp.js'

/** True when two definitions differ only in `toolDisclosure` (an omitted mode is `auto`). */
function onlyDisclosureChanged(before: McpServerDefinitionInput, after: McpServerDefinitionInput): boolean {
  const { toolDisclosure: was, ...restBefore } = before
  const { toolDisclosure: now, ...restAfter } = after
  return (was ?? 'auto') !== (now ?? 'auto') && jcs(restBefore) === jcs(restAfter)
}

/**
 * An update that changed only the tool loading mode succeeds even when the server cannot connect:
 * the mode is a preference, and rolling it back would not make the server connect. The connection
 * failure is still observed in the server's status.
 */
export function disclosureOnlyUpdate(
  kind: string,
  previous: unknown,
  definition: McpServerDefinitionInput,
): boolean {
  if (kind !== '_agnes/v1/mcp.servers.update' || !previous || typeof previous !== 'object') return false
  const before = (previous as { definition?: McpServerDefinitionInput }).definition
  return before !== undefined && onlyDisclosureChanged(before, definition)
}

/**
 * The journal row a create or update writes. Any edit needs review again, so the row starts
 * untrusted and disabled -- except an update that changes only how tools reach
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
    desired: 'disabled',
    status: unavailable,
  }
}
