import { publicErrorContract, rpcError } from '@agnes/protocol'

// Only fixed installation diagnostics cross the worker boundary; never raw paths or error data.
export function skillInstallReplyError(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null
  const candidate = [value?.data?.code, value?.code, value?.message].find(
    (code): code is string => typeof code === 'string' && publicErrorContract(code)?.skillInstall === true,
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
