import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.argv.length !== 3) throw new Error('Expected native artifact path')
const api = createRequire(import.meta.url)(resolve(process.argv[2]))
assert.equal(typeof api.renameDirectoryNoReplace, 'function')
const root = mkdtempSync(join(tmpdir(), 'agnes-packaged-publication-'))
const privateDirectory = (path) =>
  typeof api.createPrivateDirectory === 'function'
    ? api.createPrivateDirectory(path)
    : mkdirSync(path, { mode: 0o700 })
try {
  const source = join(root, 'source'),
    target = join(root, 'target')
  privateDirectory(source)
  writeFileSync(join(source, 'file'), 'complete contents')
  api.renameDirectoryNoReplace(source, target)
  assert.equal(existsSync(source), false)
  assert.equal(readFileSync(join(target, 'file'), 'utf8'), 'complete contents')
  for (const kind of ['file', 'empty', 'populated']) {
    const candidate = join(root, `source-${kind}`),
      occupied = join(root, `target-${kind}`)
    privateDirectory(candidate)
    writeFileSync(join(candidate, 'file'), 'candidate')
    if (kind === 'file') writeFileSync(occupied, 'original')
    else {
      mkdirSync(occupied)
      if (kind === 'populated') writeFileSync(join(occupied, 'file'), 'original')
    }
    assert.throws(() => api.renameDirectoryNoReplace(candidate, occupied))
    assert.equal(readFileSync(join(candidate, 'file'), 'utf8'), 'candidate')
    if (kind === 'file') assert.equal(readFileSync(occupied, 'utf8'), 'original')
    if (kind === 'populated') assert.equal(readFileSync(join(occupied, 'file'), 'utf8'), 'original')
  }
  console.log(`PASS: ${process.platform} packaged native publishes without replacing existing targets`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
