import {
  deliverableLine,
  escapeControl,
  findDeliverable,
  listDeliverables,
  saveDeliverable,
} from '@agnes/cli-tui'
import type { NodeClient } from '@agnes/sdk'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/**
 * `agh sessions deliverables <id>` lists the files a session delivered; `--save <n|id> [--out <path>]
 * [--force]` downloads one through the bounded artifact.read RPC after checking size and sha256.
 */
export async function deliverablesCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const sessionId = p.positional[1]
  if (!sessionId || p.positional.length > 2) throw new UsageError('sessions deliverables expects <id>')
  if (p.save === undefined && (p.out !== undefined || p.force))
    throw new UsageError('--out and --force need --save')
  const session = await client.session.open(sessionId, p.cwd ? { cwd: p.cwd } : {})
  const files = await listDeliverables(session)
  if (p.save !== undefined) {
    const file = findDeliverable(files, p.save)
    if (!file) throw new UsageError(`no deliverable ${escapeControl(p.save)}`)
    // A plain Error would reach the user only as "The request failed": a refusal to overwrite or a
    // digest mismatch has to be said, so it travels as a CommandError (message kept to one inert line).
    const saved = await saveDeliverable(client, sessionId, file, {
      cwd: p.cwd ?? process.cwd(),
      ...(p.out ? { out: p.out } : {}),
      force: p.force,
    }).catch((error: unknown) => {
      throw new CommandError(escapeControl(error instanceof Error ? error.message : String(error)))
    })
    io.stdout.write(
      p.json
        ? `${JSON.stringify(saved)}\n`
        : `saved ${escapeControl(saved.path)} (${saved.size} bytes, sha256 ${saved.sha256})\n`,
    )
    return ExitCode.OK
  }
  if (p.json)
    io.stdout.write(
      `${JSON.stringify({
        sessionId,
        items: files.map((f) => ({
          index: f.index,
          id: f.id,
          name: f.name,
          description: f.description,
          laneId: f.laneId,
          sha256: f.artifact.sha256,
          size: f.artifact.size,
          mime: f.artifact.mime,
        })),
      })}\n`,
    )
  else io.stdout.write(files.length ? `${files.map(deliverableLine).join('\n')}\n` : 'no deliverables\n')
  return ExitCode.OK
}
