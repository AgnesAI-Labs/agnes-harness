import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { readApplicationAsset } from '../src/application-assets.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('only reads bounded in-package raster assets matching path, type, length and digest; rejects symlinks and SVG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-brand-'))
  roots.push(root)
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
    'base64',
  )
  const asset = {
    path: 'assets/mark.png',
    mime: 'image/png' as const,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, asset.path), bytes)
  expect(await readApplicationAsset(root, asset)).toEqual(bytes)
  for (const [format, extension] of [
    ['jpeg', 'jpg', 'image/jpeg'],
    ['gif', 'gif', 'image/gif'],
    ['webp', 'webp', 'image/webp'],
  ] as const) {
    const encoded = await sharp(bytes).toFormat(format).toBuffer()
    const path = `assets/valid.${extension}`
    writeFileSync(join(root, path), encoded)
    expect(await readApplicationAsset(root, path)).toEqual(encoded)
  }
  const large = await sharp({ create: { width: 1025, height: 1024, channels: 4, background: '#000000' } })
    .png()
    .toBuffer()
  expect(large.length).toBeLessThan(128 * 1024)
  writeFileSync(join(root, 'assets/large.png'), large)
  await expect(readApplicationAsset(root, 'assets/large.png')).rejects.toThrow('decode')
  const icon = Buffer.alloc(22 + bytes.length)
  icon.writeUInt16LE(1, 2)
  icon.writeUInt16LE(1, 4)
  icon[6] = 1
  icon[7] = 1
  icon.writeUInt32LE(bytes.length, 14)
  icon.writeUInt32LE(22, 18)
  bytes.copy(icon, 22)
  writeFileSync(join(root, 'assets/valid.ico'), icon)
  expect(await readApplicationAsset(root, 'assets/valid.ico')).toEqual(icon)

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
    await expect(readApplicationAsset(root, { ...asset, ...changed })).rejects.toThrow()
  writeFileSync(join(root, asset.path), bytes.subarray(0, 8))
  await expect(readApplicationAsset(root, 'assets/mark.png')).rejects.toThrow('decode')
  writeFileSync(join(root, asset.path), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await expect(readApplicationAsset(root, asset)).rejects.toThrow()
  rmSync(join(root, 'assets'), { recursive: true })
  const outside = mkdtempSync(join(tmpdir(), 'agh-brand-outside-'))
  roots.push(outside)
  writeFileSync(join(outside, 'mark.png'), bytes)
  symlinkSync(outside, join(root, 'assets'))
  await expect(readApplicationAsset(root, asset)).rejects.toThrow('symlink')
})
