import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AutoReviewSettingsStore } from '../src/auto-review-settings.js'

it('persists only explicit profile-local reviewer settings and refuses invalid stored or incoming data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-review-settings-'))
  try {
    const first = new AutoReviewSettingsStore(dir, 'one', true)
    const other = new AutoReviewSettingsStore(dir, 'two')
    expect(await first.read()).toEqual({ enabled: true })
    const config = {
      enabled: true,
      maxReviews: 3,
      overrides: [
        { tool: 'shell', scopeHash: 'a'.repeat(64), decision: 'deny' as const, risk: 'medium' as const },
      ],
    }
    await first.save(config)
    expect(await new AutoReviewSettingsStore(dir, 'one').read()).toEqual(config)
    expect(await other.read()).toEqual({ enabled: false })
    await expect(first.save({ maxReviews: -1 })).rejects.toThrow('CONFIG_INVALID_INPUT')
    expect(await first.read()).toEqual(config)
    const file = (await readdir(join(dir, 'approval-review')))[0]!
    await writeFile(join(dir, 'approval-review', file), '{invalid')
    await expect(first.read()).rejects.toThrow('CONFIG_INVALID_STATE')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
