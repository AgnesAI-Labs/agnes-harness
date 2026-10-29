import { publicErrorContract, publicErrorReason } from '@agnes/protocol'

/** Closed boot refusals are generated from the public error contract; no extension prose crosses IPC. */
export function workerBootFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' && publicErrorContract(value)?.boot ? value : undefined
}

/** The executable waits for IPC delivery before exiting; custom embedders need no IPC channel. */
export async function reportWorkerBootFailure(error: unknown): Promise<void> {
  const code = workerBootFailureCode(
    error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined,
  )
  if (!code || !process.send || !process.connected) return
  await new Promise<void>((resolve) => {
    try {
      const reason = publicErrorReason(error)
      process.send?.({ kind: 'worker-boot-failure', code, ...(reason ? { reason } : {}) }, () => resolve())
    } catch {
      resolve()
    }
  })
}
