import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const windows = process.platform === 'win32' // guards-allow-platform: make dev supports macOS/Linux.

it.skipIf(windows)(
  'creates a private daemon directory and releases its transition lock after a build failure',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'agnes-dev-startup-'))
    const node = join(home, 'node')
    const outputFile = join(home, 'build-output')
    let output: string | undefined
    const probe = createServer()
    try {
      await new Promise<void>((resolvePort) => probe.listen(0, '127.0.0.1', resolvePort))
      const address = probe.address()
      if (!address || typeof address === 'string') throw new Error('Missing test port')
      await new Promise<void>((resolveClose, reject) =>
        probe.close((error) => (error ? reject(error) : resolveClose())),
      )
      await writeFile(
        node,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'v24.10.0'
  exit 0
fi
printf '%s\\n' "$5" > "$AGH_HOME/build-output"
exit 42
`,
        { mode: 0o700 },
      )
      await expect(
        execute(
          '/bin/sh',
          [
            '-c',
            'umask 022; exec "$@"',
            'dev-test',
            process.execPath,
            join(root, 'tools', 'dev.mjs'),
            '--home',
            home,
            '--node',
            node,
            '--port',
            String(address.port),
          ],
          { cwd: root, timeout: 20_000 },
        ),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Command failed (42)') })
      output = (await readFile(outputFile, 'utf8')).trim()
      const daemonDir = join(home, 'data', 'daemon')
      expect((await stat(daemonDir)).mode & 0o777).toBe(0o700)
      await expect(stat(join(daemonDir, 'dev-launch.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(daemonDir, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (output?.startsWith(join(root, 'packages', 'cli', 'dist', 'dev-')) && output.endsWith('/runtime'))
        await rm(dirname(output), { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  },
)
