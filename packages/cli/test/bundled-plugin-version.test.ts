import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledPluginSource, DEFAULT_ENABLED_BUNDLED_PACKAGES } from '@agnes/package-manager'
import { expect, it } from 'vitest'
import { bundledReleaseVersion, stampBundledPackageVersion } from '../tools/bundled-version.js'
import { PUBLIC_PACKAGE_VERSION } from '../tools/release-version.mjs'

it.each(DEFAULT_ENABLED_BUNDLED_PACKAGES)(
  'stamps $id with the distribution version without changing declarations',
  async (helper) => {
    const root = await mkdtemp(join(tmpdir(), 'agh-bundle-version-'))
    try {
      const source = bundledPluginSource(helper.ref)
      if (!source) throw new Error('Missing release source')
      const original = await readFile(join(source.root, source.path, 'package.json'), 'utf8')
      await mkdir(root, { recursive: true })
      const file = join(root, 'package.json')
      await copyFile(join(source.root, source.path, 'package.json'), file)
      for (const version of ['0.0.0', '1.2.3', '1.2.4-alpha.1']) {
        await stampBundledPackageVersion(root, version)
        const stamped = JSON.parse(await readFile(file, 'utf8'))
        expect(stamped).toEqual({
          ...JSON.parse(original),
          version: version === '0.0.0' ? PUBLIC_PACKAGE_VERSION : version,
        })
        expect(stamped.version).not.toBe('0.0.0')
      }
      expect(await readFile(join(source.root, source.path, 'package.json'), 'utf8')).toBe(original)
      expect(() => bundledReleaseVersion('invalid')).toThrow('release version')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
