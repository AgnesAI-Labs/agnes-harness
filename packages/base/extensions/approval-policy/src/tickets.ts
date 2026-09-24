import type { ApprovalRequest, Pending, Verdict } from '@agnes/core'
import type { SeamInitContext } from '../../../src/seam-init.js'

export type TicketStore = {
  mint(req: ApprovalRequest): Promise<Pending>
  resume(
    ticket: string,
    verdict: Verdict,
  ): Promise<{ requestId: string; bindingHash: string; expiresAt: string } | null>
}

/**
 * The parked half of this seam, which is not built yet.
 *
 * Both methods reject rather than returning a placeholder. A deployment that configures
 * `on_unavailable: park` and gets a quiet allow-shaped answer would be running unattended with
 * nobody asked; a rejection stops the call and names why.
 */
export function createTicketStore(_ctx: SeamInitContext, _ttlMs: number): TicketStore {
  const unbuilt = (): Promise<never> =>
    Promise.reject(new Error('approval parking is not implemented: no ticket store yet'))
  return { mint: unbuilt, resume: unbuilt }
}
