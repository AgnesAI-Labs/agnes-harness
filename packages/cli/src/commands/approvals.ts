import { grantLine } from '@agnes/cli-tui'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { approvalsSuggest } from './approvals-suggest.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/**
 * `agh approvals grants <session>` lists the grants in force for a session ("this session" answers and
 * the actor's "always" grants); `revoke <session> <grantId>` withdraws one. Both are admin tier: a
 * daemon that refuses says so, and that refusal is shown as it comes.
 */
export async function approvalsCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [action, sessionId, grantId, ...extra] = p.positional
  if (action === 'suggest') return approvalsSuggest(p, client, io)
  if (action === 'grants') {
    if (!sessionId || grantId !== undefined) throw new UsageError('approvals grants expects <sessionId>')
    const result = await client.approval.sessionGrants(sessionId)
    if (p.json) io.stdout.write(`${JSON.stringify(result)}\n`)
    else
      io.stdout.write(
        result.grants.length
          ? `${result.grants.map((g) => grantLine(g)).join('\n')}\n`
          : 'no approval grants\n',
      )
    return ExitCode.OK
  }
  if (action === 'revoke') {
    if (!sessionId || !grantId || extra.length > 0)
      throw new UsageError('approvals revoke expects <sessionId> <grantId>')
    const revoked = await client.approval.revokeSessionGrant(sessionId, grantId)
    io.stdout.write(p.json ? `${JSON.stringify(revoked)}\n` : `revoked ${grantLine(revoked)}\n`)
    return ExitCode.OK
  }
  throw new UsageError('approvals expects grants <sessionId>, revoke <sessionId> <grantId> or suggest')
}
