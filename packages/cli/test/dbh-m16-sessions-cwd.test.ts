import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { sessionsCommand } from '../src/commands/sessions.js'

// Deep Bug Hunt M-16. Oracle: sdk client.ts:265-266 -- a caller-supplied cwd gets "the same Host
// canonicalization as session.new"; the write path (session/new via workspace.add) stores the
// realpath, so the same user-typed --cwd must find the session on the read path. Tests assert the
// correct behaviour; a failure reproduces the defect.
//
// Note: a main()-level variant (create with `-p --cwd`, then a second main() `sessions list`) is not
// usable here: the embedded endpoint keeps workspace bindings in a per-process MemoryWorkspaceStore
// and lists through RegistryLister, so even the canonical control finds nothing across two main()
// calls; the shared daemon that persists bindings must not be started by this suite.

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dbh-m16-'))
  tmp.push(d)
  return d
}

describe('dbh M-16: sessions list|show --cwd uses the same canonical workspace as session creation', () => {
  it('sessionsCommand over a real endpoint: --cwd <typed dir> finds a session created with that dir', async () => {
    const base = scratch()
    const dir = join(base, 'work')
    const alias = join(base, 'alias')
    mkdirSync(dir)
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const canonical = realpathSync.native(dir)
    const { host } = await createTestHost({ dataDir: base, script: [] })
    const endpoint = createLocalEndpoint(host, { pollMs: 5 })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    try {
      await client.workspace.add(dir)
      const session = await client.session.new({ cwd: dir })
      const run = async (argv: string[]): Promise<string> => {
        let out = ''
        const stdout = new PassThrough()
        stdout.on('data', (b: Buffer) => {
          out += String(b)
        })
        const code = await sessionsCommand(parseArgs(argv), client, { stdout, stderr: new PassThrough() })
        return code === 0 ? out : `exit ${code}: ${out}`
      }
      const ids = (json: string): string[] =>
        (JSON.parse(json) as { items: Array<{ sessionId: string }> }).items.map((i) => i.sessionId)
      // Controls: canonical spelling finds it, and the unfiltered listing contains it.
      expect(ids(await run(['sessions', 'list', '--json']))).toContain(session.id)
      expect(ids(await run(['sessions', 'list', '--cwd', canonical, '--json']))).toContain(session.id)
      expect({
        aliasDiffersFromCanonical: alias !== canonical,
        listAlias: ids(await run(['sessions', 'list', '--cwd', alias, '--json'])).includes(session.id),
        listTrailingSlash: ids(await run(['sessions', 'list', '--cwd', `${canonical}/`, '--json'])).includes(
          session.id,
        ),
        showAlias: (await run(['sessions', 'show', session.id, '--cwd', alias])).includes(session.id),
      }).toEqual({
        aliasDiffersFromCanonical: true,
        listAlias: true,
        listTrailingSlash: true,
        showAlias: true,
      })
      // Preserved: a directory that does not exist is not an error, it simply has no sessions.
      expect(await run(['sessions', 'list', '--cwd', join(base, 'missing')])).toBe('no sessions\n')
    } finally {
      await client.close()
      await endpoint.close()
      await host.close()
    }
  })
})
