import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const emptySkills: SkillRuntimeInput = {
  list: () => [],
  read: () => ({ ok: false, code: 'NOT_FOUND' }),
  readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
}

it('retries an unloaded Skills row even when its effective revision is unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-skill-row-'))
  let attempts = 0
  try {
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      skillResources: emptySkills,
      packages: {
        '@agnes/base': {
          ecosystem: {
            ...baseEcosystem,
            'agnes/skills': (init) => {
              attempts++
              if (attempts === 1) throw new Error('synthetic first load failure')
              return baseEcosystem['agnes/skills'](init)
            },
          },
        },
      },
    })
    try {
      expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(false)
      await host.refreshSkillRow(emptySkills)
      expect(attempts).toBe(2)
      expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(true)
      await host.refreshSkillRow(emptySkills)
      expect(attempts).toBe(2)
    } finally {
      await host.close()
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
