import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, toNamespacedPath } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { expect, it } from 'vitest'
import { resolveEntry } from '../src/entry-path.js'
import { fetchSource } from '../src/sources.js'

it('admits nested internal link chains while refusing sibling escapes and missing entries', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agh-entry-path-'))
  try {
    const root = join(temp, '中文 package with spaces'),
      nested = join(root, 'nested'),
      outside = join(temp, 'outside')
    mkdirSync(nested, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(nested, 'entry.js'), 'inside')
    writeFileSync(join(outside, 'entry.js'), 'outside')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(nested, join(root, 'first'), linkType)
    symlinkSync(join(root, 'first'), join(root, 'second'), linkType)
    symlinkSync(outside, join(root, 'escape'), linkType)
    for (const entry of ['nested/entry.js', 'first/entry.js', 'second/entry.js'])
      expect(resolveEntry(root, entry)).toBe(nativeRealpathSync(join(nested, 'entry.js')))
    for (const entry of ['escape/entry.js', 'missing.js'])
      expect(() => resolveEntry(root, entry)).toThrow(
        expect.objectContaining({
          code: 'E_PACKAGE_STATE',
          detail: expect.objectContaining({ reason: 'entry-escape' }),
        }),
      )
    expect(resolveEntry(toNamespacedPath(root), 'second/entry.js')).toBe(
      nativeRealpathSync(join(nested, 'entry.js')),
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

it('refuses a destination inside the source through a different parent spelling', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agh-native-destination-'))
  try {
    const source = join(temp, 'source'),
      alias = join(temp, 'alias')
    mkdirSync(source)
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      fetchSource({ type: 'file', ref: `file:${source.split(sep).join('/')}` }, join(alias, 'destination'), {
        cwd: temp,
      }),
    ).rejects.toMatchObject({ detail: { reason: 'destination-inside-source' } })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
