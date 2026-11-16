/**
 * The ticket instruction file. Execution sessions inherit only HOME and PATH from the daemon, so the execution variables
 * DSH passed in a worker's environment (`DSH_SUPERAGENT_*`) are written to a file in the ticket directory instead, and the
 * worker session's opening system prompt points at it.
 */
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ticket } from '../core/index.js'
import { HOST_PLATFORM, isWindows } from '../infra/platform.js'

export const TICKET_INSTRUCTIONS_FILE = 'SUPERAGENT.md'
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Writes `SUPERAGENT.md` in the ticket directory `dir` with the ticket and the value of each execution variable, replacing
 * the previous version atomically, so a launch always leaves the current values. On Windows its example sets a variable
 * as PowerShell does.
 */
export async function writeTicketInstructions(
  dir: string,
  ticket: Pick<Ticket, 'id' | 'title'>,
  env: Record<string, string>,
  platform: string = HOST_PLATFORM,
): Promise<void> {
  const lines = [
    '<!-- Written by Superagent on every launch of this ticket; edits are lost. -->',
    `# Ticket ${oneLine(ticket.id)}: ${oneLine(ticket.title)}`,
    '',
    'This session has no `DSH_SUPERAGENT_*` environment variables. Wherever your instructions or a command name one,',
    isWindows(platform)
      ? "use its value here; in a PowerShell command, set it first, for example `$env:DSH_SUPERAGENT_NAME = '<value>'; ...`."
      : 'use its value here; in a shell command, set it first, for example `DSH_SUPERAGENT_NAME=<value> ...`.',
    '',
    ...Object.entries(env).map(([key, value]) => `- ${key} = ${JSON.stringify(value)}`),
    '',
  ]
  const file = join(dir, TICKET_INSTRUCTIONS_FILE)
  const temporary = join(dir, `.${TICKET_INSTRUCTIONS_FILE}.${process.pid}.tmp`)
  await writeFile(temporary, lines.join('\n'), { mode: 0o644 })
  await rename(temporary, file)
}

/** The worker session's `systemPromptAppend` on `session.new`: where its ticket's execution variables are. */
export function workerSystemPromptAppend(dir: string): string {
  return [
    `This ticket's execution environment is in ${join(dir, TICKET_INSTRUCTIONS_FILE)}: the ticket, its directory and`,
    'repository, and the agent account. Read it before you start; its values stand for the `DSH_SUPERAGENT_*`',
    'variables your instructions name, which this session does not have in its environment.',
  ].join(' ')
}
