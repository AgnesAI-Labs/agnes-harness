import { randomUUID } from 'node:crypto'
import { closeSync, writeFileSync } from 'node:fs'
import { chmod, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { NodeClient } from '@agnes/sdk'
import { windowsCreateTemporaryPrivateFileSync } from '@agnes/system-node'
import { UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

const windows = process.platform === 'win32' // guards-allow-platform: private diagnostics file primitive.

/** Server returns metadata only; output paths are local client authority, never RPC parameters. */
export async function diagnosticsCommand(p: ParsedArgs, client: NodeClient, cwd: string): Promise<void> {
  if (p.positional.length !== 1 || p.positional[0] !== 'export' || !p.out)
    throw new UsageError('usage: agh diagnostics export [--session <id>] --out <file>')
  const bundle = await client.request('_agnes/v1/diagnostics.export', {
    ...(p.key ? { sessionId: p.key } : {}),
  })
  const file = resolve(cwd, p.out),
    temporary = `${file}.${randomUUID()}.tmp`
  try {
    const bytes = `${JSON.stringify(bundle, null, 2)}\n`
    if (windows) {
      const fd = windowsCreateTemporaryPrivateFileSync(temporary)
      try {
        writeFileSync(fd, bytes, { flush: true })
      } finally {
        closeSync(fd)
      }
    } else {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await chmod(temporary, 0o600)
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
