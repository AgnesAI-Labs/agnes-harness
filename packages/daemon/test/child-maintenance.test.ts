import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startChildMaintenance } from '../src/supervisor/child-maintenance.js'

describe('child maintenance scheduler', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('runs a real periodic tick and can be stopped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sched-'))
    dirs.push(dir)
    const fires: number[] = []
    const handle = startChildMaintenance({
      dbPath: join(dir, 'sessions.db'),
      intervalMs: 10,
      setTimeout: (fn) => {
        fires.push(1)
        if (fires.length < 2) fn()
        return 1
      },
      clearTimeout: () => undefined,
    })
    expect(handle.runOnce()).toEqual([
      { childKey: '_v1', action: 'skipped', reason: 'automatic repair is disabled in this release' },
    ])
    expect(fires.length).toBeGreaterThan(0)
    handle.stop()
  })
})
