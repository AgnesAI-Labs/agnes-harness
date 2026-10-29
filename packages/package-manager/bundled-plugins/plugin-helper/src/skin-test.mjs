/** Structure assertions only: the candidate runner does not install or render this skin. */
export const skinTest = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { fileURLToPath } from 'node:url'
import * as entry from '../index.mjs'
test('skin structure only (install and browser appearance not verified)', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const row of pkg.agnes.plugins) {
    const host = await createPluginTestHost(entry[row.export], { exportName: row.export, packageDir: fileURLToPath(new URL('../', import.meta.url)) })
    try { assert.equal(host.tools.size, 0) } finally { await host.dispose() }
  }
  for (const ref of pkg.agnes.clientDescriptors) {
    assert.ok(pkg.agnes.plugins.some(row => row.id === ref.rowId))
    const path = new URL('../' + ref.path.replace(/^\\.\\//, ''), import.meta.url)
    const descriptor = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(descriptor.skins.length > 0)
    for (const skin of descriptor.skins) assert.ok(readFileSync(new URL(skin.css, path), 'utf8').length > 0)
  }
})
`
