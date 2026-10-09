import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readWebStyleSource, webStyleInputs } from './web-style-source.mjs'

it('preserves manifest order and exact fragment bytes in the existing style asset', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-style-source-'))
  try {
    mkdirSync(join(root, 'styles'))
    const manifest = join(root, 'style.css')
    writeFileSync(manifest, '@import "./styles/02-overrides.css";\n@import "./styles/01-base.css";\n')
    writeFileSync(join(root, 'styles', '02-overrides.css'), '.button { color: red; }\n')
    writeFileSync(join(root, 'styles', '01-base.css'), '.button { color: blue; }')
    expect(readWebStyleSource(pathToFileURL(manifest))).toBe(
      '.button { color: red; }\n.button { color: blue; }',
    )
    expect(webStyleInputs(manifest)).toEqual([
      manifest,
      join(root, 'styles', '02-overrides.css'),
      join(root, 'styles', '01-base.css'),
    ])
    for (const source of ['@import "../outside.css";', '@import "https://example.test/style.css";', '']) {
      writeFileSync(manifest, source)
      expect(() => readWebStyleSource(manifest)).toThrow('Invalid Web style source manifest')
    }
    writeFileSync(manifest, '@import "./styles/missing.css";\n')
    expect(() => readWebStyleSource(manifest)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
