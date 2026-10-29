import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledPluginSource,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  OPTIONAL_BUNDLED_PACKAGES,
} from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { copyBundledExamples } from '../tools/build-local.js'
import { bundledReleaseVersion, stampBundledPackageVersion } from '../tools/bundled-version.js'
import { PUBLIC_PACKAGE_VERSION } from '../tools/release-version.mjs'

vi.mock('@agnes/package-manager', async (original) => {
  const module = await original<typeof import('@agnes/package-manager')>()
  return { ...module, BUNDLED_EXAMPLES: [{ family: 'fixtures', name: 'parent-example' }] }
})

it.each([...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES])(
  'preserves $id declared versions and only raises them for explicit releases',
  async (helper) => {
    const root = await mkdtemp(join(tmpdir(), 'agh-bundle-version-'))
    try {
      const source = bundledPluginSource(helper.ref)
      if (!source) throw new Error('Missing release source')
      const original = await readFile(join(source.root, source.path, 'package.json'), 'utf8')
      await mkdir(root, { recursive: true })
      const file = join(root, 'package.json')
      for (const version of ['0.0.0', '0.1.0-alpha.0', '1.2.3', '1.2.4-alpha.1']) {
        await copyFile(join(source.root, source.path, 'package.json'), file)
        await stampBundledPackageVersion(root, version)
        const stamped = JSON.parse(await readFile(file, 'utf8'))
        expect(stamped).toEqual({
          ...JSON.parse(original),
          version: ['0.0.0', '0.1.0-alpha.0'].includes(version) ? helper.version : version,
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

it.each([
  ['0.0.0', '0.0.0', PUBLIC_PACKAGE_VERSION],
  ['0.0.0', '1.2.3', '1.2.3'],
  ['0.0.0', '1.2.3-alpha.1', '1.2.3-alpha.1'],
  ['0.0.1-alpha.0', '0.0.0', '0.0.1-alpha.0'],
  ['0.2.0', '0.2.0-alpha.1', '0.2.0'],
  ['0.2.0-alpha.2', '0.2.0-alpha.10', '0.2.0-alpha.10'],
  ['0.2.0-alpha.10', '0.2.0-alpha.2', '0.2.0-alpha.10'],
  ['0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.1'],
  ['0.2.0-alpha.1', '0.2.0-alpha', '0.2.0-alpha.1'],
  ['0.2.0-1', '0.2.0-alpha', '0.2.0-alpha'],
  ['0.2.0-alpha', '0.2.0-1', '0.2.0-alpha'],
  ['0.2.0-beta', '0.2.0-alpha', '0.2.0-beta'],
  ['0.2.0-alpha.1', '0.2.0', '0.2.0'],
  ['0.2.0+declared', '0.2.0+build', '0.2.0+declared'],
  ['0.2.0-9007199254740993', '0.2.0-9007199254740992', '0.2.0-9007199254740993'],
  ['1.0.0', '0.9.9', '1.0.0'],
  ['1.2.0', '1.1.9', '1.2.0'],
])('stamps declared %s for build %s as %s without downgrading', async (declared, build, expected) => {
  const root = await mkdtemp(join(tmpdir(), 'agh-bundle-placeholder-'))
  try {
    const file = join(root, 'package.json')
    const manifest = { name: '@fixture/bundled', version: declared }
    await writeFile(file, JSON.stringify(manifest))
    if (declared === '0.0.0')
      await expect(stampBundledPackageVersion(root, '0.0.0-alpha.0')).rejects.toThrow('placeholder')
    await stampBundledPackageVersion(root, build)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...manifest, version: expected })
    const stamped = await readFile(file, 'utf8')
    await expect(stampBundledPackageVersion(root, 'invalid')).rejects.toThrow('release version')
    expect(await readFile(file, 'utf8')).toBe(stamped)
    await writeFile(file, JSON.stringify({ ...manifest, version: 'invalid' }))
    await expect(stampBundledPackageVersion(root, build)).rejects.toThrow('declared SemVer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['0.0.0', '0.1.0-alpha.0', '1.2.3'])(
  'pins a copied synthetic example to its shipped parent version for build %s',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'agh-bundle-parent-'))
    try {
      const parent = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.name === 'plugin-helper')
      if (!parent) throw new Error('Missing bundled parent')
      const source = bundledPluginSource(parent.ref)
      if (!source) throw new Error('Missing bundled parent source')
      const sourceFile = join(source.root, source.path, 'package.json')
      const declared = await readFile(sourceFile, 'utf8')
      await copyFile(sourceFile, join(root, 'package.json'))
      await stampBundledPackageVersion(root, version)
      await copyBundledExamples(root, version)
      const shipped = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      const example = JSON.parse(
        await readFile(join(root, 'bundled-examples/fixtures/parent-example/package.json'), 'utf8'),
      )
      expect(shipped.version).toBe(version === '1.2.3' ? version : parent.version)
      expect(example.dependencies[parent.id]).toBe(shipped.version)
      expect(await readFile(sourceFile, 'utf8')).toBe(declared)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
