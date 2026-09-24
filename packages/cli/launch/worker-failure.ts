import { HOST_ERROR_CODES } from '@agnes/host'

/** Only vocabulary owned by this program may enter worker startup diagnostics. */
export function workerFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  return (
    [
      ...HOST_ERROR_CODES,
      'E_WRITER_LEASE',
      'E_STORAGE_FAULT',
      'E_LEDGER_INTEGRITY',
      'EPERM',
      'EACCES',
      'ENOENT',
      'EBUSY',
    ].find((known) => known === code) ?? 'UNKNOWN'
  )
}
