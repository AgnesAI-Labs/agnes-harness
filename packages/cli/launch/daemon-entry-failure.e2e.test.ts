import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStartupReport } from './startup-report.js'

const entry = join(dirname(fileURLToPath(import.meta.url)), 'daemon-entry.ts')

describe('the real daemon entry point that cannot start', () => {
  it("prints why and leaves the same reason in the launcher's file", () => {
    const report = createStartupReport()
    if (!report) throw new Error('no report')
    try {
      const run = spawnSync(process.execPath, ['--import', 'tsx', entry, '--no-such-flag'], {
        env: { ...process.env, ...report.env },
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('unknown flag --no-such-flag')
      expect(report.read()).toBe('unknown flag --no-such-flag')
    } finally {
      report.dispose()
    }
  })

  it('exits the same way, with nothing written, when no file was given', () => {
    const env = { ...process.env }
    delete env.AGNES_DAEMON_STARTUP_REPORT
    const run = spawnSync(process.execPath, ['--import', 'tsx', entry, '--no-such-flag'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('unknown flag --no-such-flag')
    expect(existsSync(join(dirname(entry), 'startup-failure.txt'))).toBe(false)
    expect(readFileSync(entry, 'utf8')).toContain('reportStartupFailure')
  })
})
