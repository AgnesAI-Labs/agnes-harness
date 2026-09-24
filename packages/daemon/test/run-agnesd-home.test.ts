import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { runAgnesd } from '../src/supervisor/supervisor.js'

// An embedded launcher selects the home by argument alone. Workers read their home from the config
// the supervisor hands WorkerPool, so the argument must reach that config even when the process
// environment names a different home.
it('carries an explicit home argument into the supervisor config over AGH_HOME', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'agnes-run-home-'))
  const home = join(temporary, 'argument-home')
  createPrivateDirectorySync(home)
  vi.stubEnv('AGH_HOME', join(temporary, 'environment-home'))
  const boundary = new Error('config captured')
  let captured: string | undefined
  try {
    await expect(
      runAgnesd(
        { profile: 'local-dev', home, workspace: home },
        {
          startProduction: async (options) => {
            captured = options.config.home
            throw boundary
          },
        },
      ),
    ).rejects.toBe(boundary)
    expect(captured).toBe(await realpath(home))
  } finally {
    vi.unstubAllEnvs()
    rmSync(temporary, { recursive: true, force: true })
  }
})
