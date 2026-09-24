import { mkdtempSync, rmSync } from 'node:fs'
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
 * That part is measured outside the suite, where a real route exists to assemble.
 */
describe('startup budget', () => {
  it('bootLocal plus session.new stays under 300 ms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-home-'))
    try {
      const t0 = performance.now()
      const b = await bootLocal(parseArgs(['-p', 'x']), testDeps(dir))
      await b.client.session.new({ cwd: dir })
      const ms = performance.now() - t0
      await b.close()
      expect(ms, `boot plus session.new took ${ms.toFixed(0)} ms`).toBeLessThan(process.env.CI ? 900 : 300)
      // The number bootLocal reports is the boot alone, so it is necessarily the smaller half.
      expect(b.bootMs).toBeLessThanOrEqual(ms)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
