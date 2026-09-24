import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>

describe('@agnes/cordis-loader package boundary', () => {
  it('exports only the stable root and depends downward only on Cordis', () => {
    expect(manifest.exports).toEqual({ '.': './src/index.ts' })
    expect(manifest.dependencies).toEqual({ '@agnes/cordis': 'workspace:*' })
  })
})
