import { readFileSync } from 'node:fs'
import { JsonRpcError, type NodeClient, unresolvedSubmission } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

const UNSETTLED = new Set(['UNCERTAIN', 'OUTCOME_UNKNOWN'])

function inputText(words: string[]): string {
  if (words.length === 1 && words[0] === '-') {
    let text: string
    try {
      text = readFileSync(0, 'utf8')
    } catch {
      throw new UsageError('cannot read the message from stdin')
    }
    return text.replace(/\r?\n$/, '')
  }
  return words.join(' ')
}

/**
 * `agh queue <key> [--steer] <text...|->`: hands one message to an existing session through the
 * SDK's `Session.followUp` (queued behind the current turn) or `steer` (guides the turn in flight), so
 * the commandId, the pending journal and the replay rules are the SDK's own. A daemon refusal is
 * shown as it comes and exits 1. An outcome the SDK could not settle is reported as unconfirmed and
 * is never sent a second time here: the caller checks the session and decides.
 */
export async function queueCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [key, ...words] = p.positional
  if (!key || words.length === 0) throw new UsageError('queue expects <key> [--steer] <text...|->')
  const text = inputText(words)
  if (text.trim() === '') throw new UsageError('the message is empty')
  const kind = p.steer ? 'steer' : 'followUp'
  try {
    // open restores execution without replaying the transcript; it attaches no event stream.
    const session = await client.session.open(key, p.cwd ? { cwd: p.cwd } : {})
    const seq = await (p.steer ? session.steer(text) : session.followUp(text))
    io.stdout.write(
      p.json ? `${JSON.stringify({ sessionId: key, kind, seq })}\n` : `queued ${kind} (seq ${seq})\n`,
    )
    return ExitCode.OK
  } catch (error) {
    // A daemon answer that is not UNCERTAIN is a refusal even though the SDK keeps such a command
    // pending: the journal is the SDK's; this command only reports what the daemon said.
    if (error instanceof JsonRpcError && !UNSETTLED.has(error.data.code)) {
      io.stderr.write(`refused: ${oneLine(error.data.code)}: ${oneLine(error.rpc.message)}\n`)
      return ExitCode.ERROR
    }
    const unresolved = unresolvedSubmission(error)
    if (unresolved) {
      io.stderr.write(
        `unconfirmed: the daemon did not confirm ${kind} ${oneLine(unresolved.commandId)} for ${oneLine(key)}; it was not sent again. Check with: agh sessions show ${oneLine(key)}\n`,
      )
      return ExitCode.ERROR
    }
    throw error
  }
}
