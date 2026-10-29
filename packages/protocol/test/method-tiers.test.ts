import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { METHOD_TIERS, METHODS } from '../src/index.js'

const docs = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/reference')

// Method names listed under each H2 of a tiers page, split at the admin heading.
function listed(file: string, adminHeading: string): { client: string[]; admin: string[] } {
  const [client = '', admin = ''] = readFileSync(join(docs, file), 'utf8').split(`## ${adminHeading}`)
  const names = (text: string) => [...text.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1] as string)
  return { client: names(client), admin: names(admin) }
}

describe('protocol method tiers', () => {
  const byTier = (tier: string) =>
    Object.keys(METHODS)
      .filter((m) => METHOD_TIERS[m as keyof typeof METHODS] === tier)
      .sort()

  it('classifies every method and nothing else', () => {
    expect(Object.keys(METHOD_TIERS).sort()).toEqual(Object.keys(METHODS).sort())
  })

  it.each([
    ['protocol-tiers.md', 'Admin contract'],
    ['protocol-tiers.zh-CN.md', '管理契约'],
  ])('%s lists each method once under its tier', (file, heading) => {
    const { client, admin } = listed(file, heading)
    expect([...client].sort()).toEqual(byTier('client'))
    expect([...admin].sort()).toEqual(byTier('admin'))
  })
})
