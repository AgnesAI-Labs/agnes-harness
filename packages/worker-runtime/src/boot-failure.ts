/** Closed boot refusals only. No extension prose, stack, paths or credentials cross this channel. */
const BOOT_FAILURE_CODES = new Set([
  'E_SEAM_INIT',
  'E_SEAM_MISSING',
  'E_SEAM_EXPORT_MISSING',
  'E_PROVIDER_INVALID',
  'E_DEP_MISSING',
  'E_EXT_LOAD',
  'E_LOCK_MISMATCH',
  'E_API_RANGE',
])

export function workerBootFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' && BOOT_FAILURE_CODES.has(value) ? value : undefined
}

/** The executable waits for IPC delivery before exiting; custom embedders need no IPC channel. */
export async function reportWorkerBootFailure(error: unknown): Promise<void> {
  const code = workerBootFailureCode(
    error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined,
  )
  if (!code || !process.send || !process.connected) return
  await new Promise<void>((resolve) => {
    try {
      process.send?.({ kind: 'worker-boot-failure', code }, () => resolve())
    } catch {
      resolve()
    }
  })
}
