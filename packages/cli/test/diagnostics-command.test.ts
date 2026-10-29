import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeClient } from '@agnes/sdk'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { diagnosticsCommand } from '../src/commands/diagnostics.js'

it('exports a session bundle to the client path without sending the path to the server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-diagnostics-cli-'))
  const request = vi.fn(async () => ({ schemaVersion: 1, errors: [] }))
  const client = { request } as unknown as NodeClient
  try {
    const parsed = parseArgs([
      'diagnostics',
      'export',
      '--session',
      'synthetic-session',
      '--out',
      'bundle.json',
    ])
    await diagnosticsCommand(parsed, client, home)
    expect(request).toHaveBeenCalledWith('_agnes/v1/diagnostics.export', { sessionId: 'synthetic-session' })
    expect(JSON.parse(await readFile(join(home, 'bundle.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      errors: [],
    })
    if (process.platform === 'win32')
      expect(hasPrivateDaclSync(join(home, 'bundle.json'))).toBe(true) // guards-allow-platform: private Windows ACL assertion.
    else expect((await stat(join(home, 'bundle.json'))).mode & 0o777).toBe(0o600) // guards-allow-platform: POSIX private file mode.
    await expect(diagnosticsCommand(parseArgs(['diagnostics', 'export']), client, home)).rejects.toThrow(
      'usage:',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
