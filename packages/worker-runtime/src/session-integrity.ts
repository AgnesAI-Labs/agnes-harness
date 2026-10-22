import type { HostSession } from '@agnes/host'

/** Preserve the failure sequence across the worker boundary instead of flattening it into an error. */
export async function auditSessionHistory(session: HostSession) {
  try {
    return await session.auditHistory()
  } catch (error) {
    const status = session.integrityStatus()
    if ((error as { code?: string }).code === 'E_LEDGER_INTEGRITY' && status.state === 'failed') return status
    throw error
  }
}
