import type { ToolContext } from '@agnes/extension-api'

const timeouts = new Map<string, number>()
function wrapsPowerShell(command: string): boolean {
  const words = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  if (words[0] === '&') words.shift()
  const executable =
    words
      .shift()
      ?.replace(/^["']|["']$/g, '')
      .split(/[\\/]/)
      .pop() ?? ''
  if (!/^(powershell|pwsh)(\.exe)?$/i.test(executable)) return false
  for (const word of words) {
    if (/^-f(?:ile)?$/i.test(word)) return false
    if (/^-(?:command|c)$/i.test(word)) return true
  }
  return false
}
export function shellGuidance(ctx: ToolContext, command: string, stopped = 0): string[] {
  const notes: string[] = []
  if (ctx.platform.shell === 'powershell' && wrapsPowerShell(command))
    notes.push('[the session already runs PowerShell; omit the extra powershell/pwsh -Command wrapper]')
  if (stopped > 0)
    notes.push(
      `[stopped ${stopped} descendant process(es) still running when the command ended (for example started with & or nohup); processes do not outlive a foreground command. Start long-running work such as a server with background: true and check it with job_output]`,
    )
  return notes
}

export function timeoutGuidance(ctx: ToolContext, command: string, cwd: string, empty: boolean): string {
  const key = JSON.stringify([ctx.session.key, ctx.session.lane, cwd, command])
  const count = (timeouts.get(key) ?? 0) + 1
  timeouts.delete(key)
  timeouts.set(key, count)
  const oldest = timeouts.keys().next()
  if (timeouts.size > 256 && !oldest.done) timeouts.delete(oldest.value)
  return `[${empty ? 'the command printed no output; ' : ''}${count > 1 ? `this command has timed out ${count} times here; ` : ''}do not rerun it unchanged. Inspect the current state, split the work or request a longer timeoutMs within the deployment limit.]`
}

/** The part of a turn's time limit a foreground command leaves free for the model to wrap up. */
export const deadlineMarginMs = (timeLimitMs: number) => Math.max(15_000, Math.round(timeLimitMs * 0.05))
/** The shortest wait a command gets near the deadline, so a quick check can still run. */
const DEADLINE_FLOOR_MS = 1_000

/**
 * How long a foreground command may run in a turn with a time limit: its own timeout, cut down to the
 * time the turn has left less a margin, so one long command cannot run past the deadline with the
 * model unable to wrap up. `capped` says the turn's deadline, not the command's own timeout, decided.
 * A turn without a time limit leaves the timeout unchanged.
 */
export function deadlineWait(
  ctx: ToolContext,
  timeoutMs: number,
  opts: { continues?: boolean } = {},
): { waitMs: number; capped: boolean } {
  const limit = ctx.turnTimeLimit
  if (!limit) return { waitMs: timeoutMs, capped: false }
  const usable = limit.deadlineAt - Date.now() - deadlineMarginMs(limit.timeLimitMs)
  // A wait whose process keeps running after it ends gives control back with half the usable time
  // still left, so the model can act on what it sees; cut at the margin, one wait could take the
  // whole rest of the turn. A wait that kills its process at the cut keeps all of it.
  const allowed = Math.max(DEADLINE_FLOOR_MS, opts.continues ? Math.floor(usable / 2) : usable)
  return allowed < timeoutMs ? { waitMs: allowed, capped: true } : { waitMs: timeoutMs, capped: false }
}

/** `4m20s`, `45s`, `1h05m`: whole seconds rounded down, so the model never hears it has more. */
function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** Why a capped foreground wait ended, and what the turn has left, measured when the call returns. */
export function deadlineStop(ctx: ToolContext, waitMs: number): string {
  const deadlineAt = ctx.turnTimeLimit?.deadlineAt ?? Date.now()
  const at = new Date(deadlineAt).toISOString().slice(11, 19)
  return `stopped after ${waitMs}ms because this turn's time limit is nearly up: about ${duration(deadlineAt - Date.now())} of the turn remains (deadline ${at} UTC)`
}

/** Why a capped wait whose process continues ended early, and what the turn has left. */
export function deadlineYield(ctx: ToolContext, waitMs: number, requestedMs: number): string {
  const deadlineAt = ctx.turnTimeLimit?.deadlineAt ?? Date.now()
  const at = new Date(deadlineAt).toISOString().slice(11, 19)
  return `stopped after ${waitMs}ms (requested ${requestedMs}ms) to leave time in this turn: about ${duration(deadlineAt - Date.now())} of the turn remains (deadline ${at} UTC)`
}

export const DEADLINE_ADVICE =
  'Use the time left for short steps: leave the work in its best checked state and end with a short summary.'
