import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledPackageJson } from '@agnes/extension-api'
import { afterEach, expect, it } from 'vitest'
import { createBundledExtensions } from '../../src/runtime/assemble/bundled-extensions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('indexes builtin locations per Host but reads changed capabilities and refuses changed identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-builtin-index-'))
  roots.push(root)
  const extension = join(root, 'extension')
  mkdirSync(extension)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ agnes: { extensions: ['./extension'] } }))
  writeFileSync(join(extension, 'index.js'), '')
  const write = (id: string, skills: boolean) =>
    writeFileSync(
      join(extension, 'package.json'),
      JSON.stringify(
        bundledPackageJson({
          id,
          version: '1.0.0',
          apiRange: '^4.0.0',
          entry: './index.js',
          capabilities: {},
          ...(skills ? { liveResources: ['skills'] } : {}),
        }),
      ),
    )
  write('fixture/reader', true)
  type Inputs = Parameters<typeof createBundledExtensions>
  const assemble = (trust = 'builtin', enabled = true) =>
    createBundledExtensions(
      {
        profile: {
          packages: [{ id: 'fixture/pkg', version: '1.0.0', enabled, trust, integrity: 'fixture' }],
        },
      } as unknown as Inputs[0],
      { dirs: new Map([['fixture/pkg', root]]), modules: new Map() } as Inputs[1],
      { dispatchExtensionShutdown: () => undefined } as unknown as Inputs[2],
      { rowExtensions: { activate: () => undefined } } as unknown as Inputs[3],
    )
  const bundled = assemble()
  expect(bundled.findBundledExtension('fixture/reader')?.spec.package).toBe('fixture/pkg')
  expect(bundled.declaredExtensionIds.has('fixture/reader')).toBe(true)
  expect(bundled.consumesSkills('fixture/reader')).toBe(true)
  write('fixture/reader', false)
  expect(bundled.consumesSkills('fixture/reader')).toBe(false)
  write('fixture/replacement', true)
  expect(bundled.authorManifestOf('fixture/reader')).toBe('unreadable')
  expect(assemble().findBundledExtension('fixture/reader')).toBeUndefined()
  expect(assemble().findBundledExtension('fixture/replacement')).toBeDefined()
  expect(assemble('trusted').findBundledExtension('fixture/replacement')).toBeUndefined()
  expect(assemble('builtin', false).findBundledExtension('fixture/replacement')).toBeUndefined()
  writeFileSync(join(extension, 'package.json'), '{invalid')
  expect(bundled.authorManifestOf('fixture/reader')).toBe('unreadable')
})
