import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
it.each(['business-agent', 'hot-upgrade', 'growing-skills'])(
  'proves %s through a fresh real daemon without browser automation or retries',
  async (name) => {
    const { stdout, stderr } = await exec(process.execPath, [`examples/demos/${name}/run.mjs`, '--check'], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        AGH_DEMO_MODEL: undefined,
        AGH_DEMO_API_KEY: undefined,
        AGH_DEMO_BASE_URL: undefined,
      },
    })
    expect(stderr).toBe('')
    expect(stdout).toContain(`PASS ${name}: every claim verified against persisted backend results.`)
  },
  130_000,
)
