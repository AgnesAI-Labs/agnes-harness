import { rpcError } from '@agnes/protocol'

// Only fixed installation diagnostics cross the worker boundary; never raw paths or error data.
const PUBLIC_CODES = new Set([
  'SKILL_ATOMIC_PUBLISH_UNAVAILABLE',
  'SKILL_DOCUMENT_INVALID',
  'SKILL_FILE_MISSING',
  'SKILL_FILE_REFUSED',
  'SKILL_INSTALL_BAD_RECEIPT',
  'SKILL_INSTALL_BUSY',
  'SKILL_INSTALL_CANCELLED',
  'SKILL_INSTALL_CAPABILITY_DENIED',
  'SKILL_INSTALL_EXPIRED',
  'SKILL_INSTALL_FAILED',
  'SKILL_INSTALL_INTERRUPTED',
  'SKILL_INSTALL_INVALID',
  'SKILL_INSTALL_LEASE_CHANGED',
  'SKILL_INSTALL_LOCAL_OWNER_REQUIRED',
  'SKILL_INSTALL_PERMISSION_INVALID',
  'SKILL_INSTALL_PERMISSION_TIMEOUT',
  'SKILL_INSTALL_PERMISSION_UNAVAILABLE',
  'SKILL_INSTALL_REJECTED',
  'SKILL_INSTALL_SESSION_CLOSED',
  'SKILL_LINK_REFUSED',
  'SKILL_NAME_INVALID',
  'SKILL_NOT_READY',
  'SKILL_PATH_DENIED',
  'SKILL_PATH_INVALID',
  'SKILL_PROPOSAL_TERMINAL',
  'SKILL_PROPOSAL_UNAVAILABLE',
  'SKILL_READ_REJECTED',
  'SKILL_RECEIPT_DIRECTORY_UNSAFE',
  'SKILL_RESOURCE_CHANGED_OR_SHADOWED',
  'SKILL_RESOURCE_OPERATION_FAILED',
  'SKILL_RESOURCE_OPERATION_PENDING',
  'SKILL_SIZE_LIMIT',
  'SKILL_SOURCE_CHANGED',
  'SKILL_SOURCE_NOT_DIRECTORY',
  'SKILL_SOURCE_TARGET_OVERLAP',
  'SKILL_STAGE_INVALID',
  'SKILL_TARGET_BUSY',
  'SKILL_TARGET_CONFLICT',
])

export function skillInstallReplyError(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null
  const candidate = [value?.data?.code, value?.code, value?.message].find(
    (code): code is string => typeof code === 'string' && PUBLIC_CODES.has(code),
  )
  const code =
    candidate ??
    (value?.code === rpcError('INVALID_PARAMS').code
      ? 'SKILL_INSTALL_INVALID'
      : value?.code === rpcError('CAPABILITY_DENIED').code
        ? 'SKILL_INSTALL_CAPABILITY_DENIED'
        : 'SKILL_INSTALL_FAILED')
  return { code, message: code }
}
