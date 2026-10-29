import type { ApprovalAnswer, ApprovalRequest, ApprovalSeam, Pending, Verdict } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'

/**
 * Delivery only: the question goes to whoever is connected and the answer comes back. Which calls
 * are asked about is the tool policy's decision, the command table is the Host's floor around it, and
 * who may answer and what is durable belong to Core. With nobody connected the answer is
 * `unavailable`, which the kernel reads as a refusal.
 */
export const approvalPolicy: SeamFactory<ApprovalSeam> = async (ctx) => ({
  async ask(req: ApprovalRequest, opts): Promise<Verdict | ApprovalAnswer | Pending> {
    const prompter = ctx.adapters.prompter
    if (prompter) {
      try {
        return await prompter.ask(req, {
          signal: opts ? AbortSignal.any([ctx.signal, opts.signal]) : ctx.signal,
        })
      } catch (e) {
        ctx.log.warn('prompter failed', { message: (e as Error).message })
        return { verdict: 'unavailable', reason: 'transport' }
      }
    }
    // Core's canonical decisions persist/re-offer tool gates. Unmigrated domains
    // have no parked continuation here; absence of a human is never an answer.
    return { verdict: 'unavailable', reason: 'no-approver' }
  },
})
