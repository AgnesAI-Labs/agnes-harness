import type { ApprovalSeam, Pending, Verdict } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'
import { matchPolicy, normalizeArgv } from './normalize.js'
import { readApprovalConfig } from './policy.js'
import { createTicketStore } from './tickets.js'

/**
 * The synchronous half of the approval seam: a command table first, a human second.
 *
 * The order is the whole design. A rule can only ever end the question early in one of two ways -
 * deny, which refuses, or allow, which proceeds without asking - and anything the table has nothing
 * to say about goes to whoever is connected. With nobody connected the answer is `unavailable`,
 * which the kernel reads as a refusal.
 */
export const approvalPolicy: SeamFactory<ApprovalSeam> = async (ctx) => {
  const cfg = readApprovalConfig(ctx.profile.preset)
  const tickets = createTicketStore(ctx, cfg.pendingTtlMs)
  const bind = (workspaceRoot: string): ApprovalSeam => ({
    async ask(req): Promise<Verdict | Pending> {
      const tool = req.tool
      // A budget quote or an unknown-outcome question carries no tool, so the command table has
      // nothing to say about it and it goes straight to the prompter. Deliberate: an allow list
      // written about command lines is not a mandate to spend money, nor to decide what a
      // half-finished tool did.
      if (tool) {
        let argv: string | null = null
        try {
          argv = normalizeArgv(tool.name, tool.args, workspaceRoot)
        } catch (e) {
          // The argument cannot be reduced to one identity, so no rule may be matched against it and
          // no grant may be bound to it. It is a question for a human, not a policy miss to wave
          // through. `null` rather than an empty string, because an empty argv is a value this can
          // legitimately return - a shell command of nothing but whitespace normalizes to it.
          ctx.log.warn('approval argv is not canonical; asking', {
            tool: tool.name,
            message: (e as Error).message,
          })
        }
        if (argv !== null) {
          const action = matchPolicy(cfg.rules, tool.name, argv)
          if (action === 'deny') return 'rejected'
          // Tainted context and an `always` tool both keep the human in the loop whatever the table
          // says: a rule cannot pre-approve a call the model may have been talked into.
          if (
            action === 'allow' &&
            tool.meta.requiresApproval !== 'always' &&
            (!req.taint || req.scope.includes('/'))
          )
            return 'allowed-once'
        }
      }
      const prompter = ctx.adapters.prompter
      if (prompter) {
        try {
          return await prompter.ask(req, { signal: ctx.signal })
        } catch (e) {
          ctx.log.warn('prompter failed', { message: (e as Error).message })
          return 'unavailable'
        }
      }
      if (cfg.onUnavailable === 'park') return tickets.mint(req)
      return 'unavailable'
    },
    resume: (ticket, verdict) => tickets.resume(ticket, verdict),
  })
  return Object.assign(bind(ctx.profile.workspaceRoot), {
    forWorkspace: (workspace: Readonly<{ root: string }>) => bind(workspace.root),
  })
}
