import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

it('lists the optional Jev loop in the built-in catalog with its run-mode tag and display text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-jev-catalog-'))
  try {
    const catalog = await discoverLocalExamples(root)
    const result = await catalog.read({ offline: true })
    expect(result.entries.find((entry) => entry.id === '@agnes/jev-loop')).toMatchObject({
      version: '0.1.2',
      sourceId: 'builtin-plugins',
      source: { type: 'file', ref: 'file:./bundled-plugins/jev-loop' },
      provides: ['loop'],
      metadata: { displayName: 'Jev Agent Loop', locales: { 'zh-CN': { displayName: 'Jev 运行方式' } } },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
