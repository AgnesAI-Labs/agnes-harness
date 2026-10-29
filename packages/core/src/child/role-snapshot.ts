import { CoreError } from '@agnes/core-common/types'
import { restoreFilesystemPolicy } from '@agnes/core-effects/effects/fs-guard'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { StorageAdapter } from '@agnes/core-ledger/log/storage'
import { parseAgentRef, validateAgainst } from '@agnes/protocol'
import { Actor as ActorSchema } from '@agnes/protocol/gen/session-v1'
import { ROLE_DELEGATION, type RoleDelegation } from './roles.js'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)

function commandTable(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          object(entry) &&
          typeof entry.tool === 'string' &&
          typeof entry.argv === 'string' &&
          ['allow', 'require_approval', 'deny'].includes(String(entry.action)),
      ))
  )
}

/** Validate the backend fact, not the disposable materialized register cache. */
function snapshot(value: unknown): RoleDelegation {
  if (
    !object(value) ||
    !object(value.role) ||
    !object(value.role.title) ||
    typeof value.role.ref !== 'string' ||
    typeof value.role.title.en !== 'string' ||
    (value.role.title['zh-CN'] !== undefined && typeof value.role.title['zh-CN'] !== 'string') ||
    typeof value.parentKey !== 'string' ||
    !value.parentKey ||
    !validateAgainst(ActorSchema, value.actor).ok ||
    !strings(value.tools) ||
    !Number.isSafeInteger(value.generationLimit) ||
    (value.generationLimit as number) < 0 ||
    !Number.isSafeInteger(value.maxFanOut) ||
    (value.maxFanOut as number) < 0 ||
    !['read-only', 'workspace-write'].includes(String(value.permission)) ||
    value.approvalPolicy !== 'never' ||
    typeof value.parentPolicy !== 'string' ||
    (value.delegatedFullAccess !== undefined && value.delegatedFullAccess !== true) ||
    (value.parentTainted !== undefined && typeof value.parentTainted !== 'boolean') ||
    (value.humanApprovals !== undefined && typeof value.humanApprovals !== 'boolean') ||
    typeof value.sandboxRequired !== 'boolean' ||
    !object(value.filesystem) ||
    (value.resources !== undefined &&
      (!object(value.resources) || !strings(value.resources.mcp) || !strings(value.resources.skills))) ||
    !commandTable(value.commandTable) ||
    (value.policyCeilings !== undefined &&
      (!Array.isArray(value.policyCeilings) ||
        value.policyCeilings.some(
          (entry) => !object(entry) || typeof entry.policy !== 'string' || !commandTable(entry.commandTable),
        )))
  )
    throw new CoreError('E_ENVELOPE', 'Invalid trusted role delegation snapshot')
  parseAgentRef(value.role.ref)
  const result = value as unknown as RoleDelegation
  return { ...structuredClone(result), filesystem: restoreFilesystemPolicy(result.filesystem) }
}

/** Both Host workspace admission and direct Core reopen use this same session-local evidence. */
export async function readRoleDelegation(
  storage: StorageAdapter,
  key: string,
): Promise<RoleDelegation | undefined> {
  for await (const rows of scanPages((query) => storage.scan(key, query), {
    type: ROLE_DELEGATION,
    order: 'asc',
  })) {
    for (const row of rows) {
      if (row.type !== ROLE_DELEGATION || row.origin !== 'system' || row.trust !== 'trusted') continue
      // Fork scans include a parent's immutable prefix. It cannot confer a role on another session.
      const [owned] = await storage.scanIntegrity(key, { fromSeq: row.seq, toSeq: row.seq, limit: 1 })
      if (owned?.sessionKey !== key || owned.event.id !== row.id) continue
      const captured = snapshot(row.data)
      if (captured.parentKey === key)
        throw new CoreError('E_ENVELOPE', 'Role delegation cannot name itself as parent')
      return captured
    }
  }
  return undefined
}
