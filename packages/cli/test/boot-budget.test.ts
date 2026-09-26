import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootLocal } from '../src/boot/local.js'
import { testDeps } from './boot-host.js'

/**
 * The startup budget from the design (a usable session.new within 300 ms). It is measured against
 * the test host, so what it bounds is everything cli and daemon and sdk do -- profile resolution,
 * the endpoint, the handshake, the registry -- and not the provider assembly a real profile adds.
 * That part is measured outside the suite, where a real route exists to assemble. Shared runners
 * report this measurement; set AGH_ENFORCE_BOOT_BUDGET=1 on a controlled machine to gate at 300 ms.
 */
describe('startup budget', () => {
  it('boots and creates a session, reporting elapsed time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-home-'))
    let booted: Awaited<ReturnType<typeof bootLocal>> | undefined
    try {
      const t0 = performance.now()
      booted = await bootLocal(parseArgs(['-p', 'x']), testDeps(dir))
      await booted.client.session.new({ cwd: dir })
      const ms = performance.now() - t0
      // The number bootLocal reports is the boot alone, so it is necessarily the smaller half.
      expect(booted.bootMs).toBeLessThanOrEqual(ms)
      console.info(`CLI_STARTUP_BUDGET ${JSON.stringify({ platform: process.platform, elapsedMs: ms })}`)
      if (process.env.AGH_BOOT_BUDGET_REPORT === '1' && process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### CLI startup budget\n\n${process.platform}: bootLocal + session.new took ${ms.toFixed(0)} ms (300 ms target; diagnostic only).\n`,
        )
      if (process.env.AGH_ENFORCE_BOOT_BUDGET === '1')
        expect(ms, `boot plus session.new took ${ms.toFixed(0)} ms`).toBeLessThan(300)
    } finally {
      try {
        await booted?.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 30_000)
})
