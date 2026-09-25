import { rmSync } from 'node:fs'
import { createTestHost } from '@agnes/host/testkit'
import { main } from '../../src/bin.js'
import { say, TEST_LOCK } from '../boot-host.js'

const configuredDataDir = process.env.AGNES_ACP_FIXTURE_DIR
if (!configuredDataDir) throw new Error('AGNES_ACP_FIXTURE_DIR is required')
const dataDir: string = configuredDataDir

/**
 * Test-only Host seam: the real daemon LocalEndpoint still validates and executes the entire ACP
 * exchange against the test kit's in-memory Host, while the provider side is scripted and opens
 * neither a port nor a production faux-provider switch. This keeps the concurrency measurement
 * about CLI/ACP process startup.
 */
async function run(): Promise<void> {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      {
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        cwd: dataDir,
        agnesVersion: '0.0.0-test',
      },
      {
        lock: TEST_LOCK,
        createHostImpl: async () => (await createTestHost({ dataDir, script: [say('concurrency ok')] })).host,
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
  process.exitCode = 1
})
