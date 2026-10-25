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
