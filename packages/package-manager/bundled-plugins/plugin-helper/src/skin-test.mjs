/** Structure assertions only: the candidate runner does not install or render this skin. */
export const skinTest = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
test('skin structure only (install and browser appearance not verified)', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const entry = await import(new URL('../' + pkg.exports.replace(/^\\.\\//, ''), import.meta.url))
  for (const row of pkg.agnes.plugins) assert.equal(typeof entry[row.export].apply, 'function')
  for (const ref of pkg.agnes.clientDescriptors) {
    assert.ok(pkg.agnes.plugins.some(row => row.id === ref.rowId))
    const path = resolve(ref.path)
    const descriptor = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(descriptor.skins.length > 0)
    for (const skin of descriptor.skins) assert.ok(readFileSync(resolve(dirname(path), skin.css), 'utf8').length > 0)
  }
})
`
