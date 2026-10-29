import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseSystemPromptAppend, SYSTEM_PROMPT_APPEND_MAX } from '@agnes/protocol/command-line'
import { CommandError, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

/** Flag combinations that make no sense; parsed arguments only, so `--help` stays light. */
export function refuseAppendSystemPromptMisuse(p: ParsedArgs): void {
  const text = p.appendSystemPrompt !== undefined
  const file = p.appendSystemPromptFile !== undefined
  if (text && file)
    throw new UsageError('--append-system-prompt and --append-system-prompt-file are mutually exclusive')
  if (!text && !file) return
  if (p.agent)
    throw new UsageError(
      '--agent cannot be combined with --append-system-prompt or --append-system-prompt-file',
    )
  if (p.continue || p.resume !== undefined || p.command === 'resume')
    throw new UsageError(
      '--append-system-prompt applies only to a new session; a resumed session keeps its pinned prompt',
    )
}

/**
 * The text `--append-system-prompt` / `--append-system-prompt-file` add to a NEW session's prompt.
 * A file is read here, on the client's own machine, and never through a symlink.
 */
export async function resolveAppendSystemPrompt(p: ParsedArgs, cwd: string): Promise<string | undefined> {
  if (p.appendSystemPrompt === undefined && p.appendSystemPromptFile === undefined) return undefined
  let text = p.appendSystemPrompt
  if (p.appendSystemPromptFile !== undefined) {
    const file = resolve(cwd, p.appendSystemPromptFile)
    const info = await lstat(file).catch(() => undefined)
    if (!info) throw new UsageError(`--append-system-prompt-file ${p.appendSystemPromptFile} cannot be read`)
    if (info.isSymbolicLink() || !info.isFile())
      throw new UsageError('--append-system-prompt-file must name a regular file, not a symlink')
    if (info.size > SYSTEM_PROMPT_APPEND_MAX) throw new UsageError(tooLong('--append-system-prompt-file'))
    // O_NOFOLLOW closes the window between the lstat above and this open.
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
    if (!handle)
      throw new UsageError(`--append-system-prompt-file ${p.appendSystemPromptFile} cannot be read`)
    try {
      text = (await handle.readFile({ encoding: 'utf8' })).replace(/\r\n/g, '\n')
    } finally {
      await handle.close()
    }
  }
  try {
    return parseSystemPromptAppend(text)
  } catch {
    const flag =
      p.appendSystemPromptFile === undefined ? '--append-system-prompt' : '--append-system-prompt-file'
    throw new UsageError(
      text && text.length <= SYSTEM_PROMPT_APPEND_MAX
        ? `${flag} must not contain NUL`
        : text
          ? tooLong(flag)
          : `${flag} is empty`,
    )
  }
}

const tooLong = (flag: string): string => `${flag} is over the ${SYSTEM_PROMPT_APPEND_MAX / 1024} KiB limit`

/**
 * An older daemon ignores the unknown `session/new` field, which would run the session without the
 * text and say nothing. Read the session's own prompt back before anything is sent; on any doubt the
 * caller must not send the first prompt.
 */
export async function verifyAppendApplied(
  client: {
    systemPrompt: { get(input: { sessionId: string }): Promise<{ sections: readonly { text: string }[] }> }
  },
  sessionId: string,
  text: string,
): Promise<void> {
  const snapshot = await client.systemPrompt.get({ sessionId }).catch(() => undefined)
  if (!snapshot?.sections.some((section) => section.text.includes(text)))
    throw new CommandError(
      'the daemon did not apply the appended system prompt (an older daemon ignores it); no prompt was sent',
    )
}
