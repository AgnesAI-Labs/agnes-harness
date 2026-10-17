import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readApplicationAsset } from '../src/application-assets.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('only reads bounded in-package raster assets matching path, type, length and digest; rejects symlinks and SVG', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-brand-'))
  roots.push(root)
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const asset = {
    path: 'assets/mark.png',
    mime: 'image/png' as const,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, asset.path), bytes)
  expect(readApplicationAsset(root, asset)).toEqual(bytes)
  for (const changed of [
    { path: '../escape.png' },
    { path: '/assets/mark.png' },
    { path: 'assets\\mark.png' },
    { size: 0 },
    { size: 131073 },
    { size: 9 },
    { sha256: '0'.repeat(64) },
    { mime: 'image/jpeg' as const },
  ])
    expect(() => readApplicationAsset(root, { ...asset, ...changed })).toThrow()
  writeFileSync(join(root, asset.path), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  expect(() => readApplicationAsset(root, asset)).toThrow()
  rmSync(join(root, 'assets'), { recursive: true })
  const outside = mkdtempSync(join(tmpdir(), 'agh-brand-outside-'))
  roots.push(outside)
  writeFileSync(join(outside, 'mark.png'), bytes)
  symlinkSync(outside, join(root, 'assets'))
  expect(() => readApplicationAsset(root, asset)).toThrow('symlink')
})
