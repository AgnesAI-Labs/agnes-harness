import type { Client } from '@agnes/sdk'
import { ExitCode } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { exportSession } from './export.js'

export type ExportIntoRequest = {
  sessionId: string
  format: 'agnes' | 'html' | 'sharegpt' | 'claude-code'
  out: string
}

/**
 * What the TUI's /export runs: `agh export ID [--format F | --html] --out FILE` (redacted, never raw) on
 * a connection booted for the purpose and closed afterwards. The TUI's own connection has the session
 * open, which `readLedger` refuses, so the export reads the ledger from a second one. Failures are thrown
 * for the caller to show.
 */
export async function exportInto(
  p: ParsedArgs,
  boot: (args: ParsedArgs) => Promise<{ client: Client; close(): Promise<unknown> }>,
  where: { cwd: string },
  request: ExportIntoRequest,
): Promise<void> {
  const { format: _format, ...base } = p
  const named = request.format === 'sharegpt' || request.format === 'claude-code' ? request.format : undefined
  const args: ParsedArgs = {
    ...base,
    command: 'export',
    positional: [request.sessionId],
    rest: [],
    out: request.out,
    html: request.format === 'html',
    raw: false,
    ...(named ? { format: named } : {}),
  }
  const booted = await boot(args)
  try {
    const sink = { write: () => true }
    const code = await exportSession(
      args,
      { cwd: where.cwd, io: { stdout: sink, stderr: sink } },
      booted.client,
    )
    if (code !== ExitCode.OK) throw new Error(`export exited with ${code}`)
  } finally {
    await booted.close().catch(() => undefined)
  }
}
