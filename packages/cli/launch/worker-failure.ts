import { publicErrorContract } from '@agnes/protocol'

/** Only vocabulary owned by this program may enter worker startup diagnostics. */
export function workerFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  if (typeof code === 'string' && publicErrorContract(code)) return code
  // Native startup diagnostics are local-only; they are not public domain refusals.
  return ['EPERM', 'EACCES', 'ENOENT', 'EBUSY'].find((known) => known === code) ?? 'UNKNOWN'
}
