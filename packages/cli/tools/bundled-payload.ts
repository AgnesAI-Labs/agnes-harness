import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUNDLED_EXAMPLES,
  BUNDLED_PLUGIN_DIGESTS,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  hashDirectory,
  OPTIONAL_BUNDLED_PACKAGES,
} from '@agnes/package-manager'
import { buildPresentations, verifyPresentation } from '../../../tools/presentation-build.mjs'
import { buildJevPayload } from '../../package-manager/tools/build-jev-payload.mjs'
import { buildJudgmentPayload } from '../../package-manager/tools/build-judgment-payload.mjs'
import {
  buildSuperagentPayload,
  SUPERAGENT_RESOURCE_FOLDERS,
} from '../../package-manager/tools/build-superagent-payload.mjs'
import { prepareBrowser } from './browser.js'
import { bundledPackageVersion, stampBundledPackageVersion } from './bundled-version.js'
import { checkPackagedClientModules } from './client-module-check.js'
import { prepareDocumentReader } from './document-reader.js'
import { copyExamplePayload } from './example-payload.js'

const repoPackages = join(import.meta.dirname, '../..')

/** Copy only runtime payload, never repository tests or personal working files. */
export async function copyBundledPlugins(outputDirectory: string, version = '0.0.0'): Promise<void> {
  const presentations = await buildPresentations()
  for (const { name: helper } of [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES]) {
    const destination = join(outputDirectory, 'bundled-plugins', helper)
    const source = join(repoPackages, 'package-manager', 'bundled-plugins', helper)
    await mkdir(destination, { recursive: true })
    // The Jev payload entry is generated from packages/loop-jev and is not committed.
    if (helper === 'jev-loop') await buildJevPayload(source)
    if (helper === 'judgment') await buildJudgmentPayload(source)
    // The Superagent entry reads its generated prompts, skills and locale folders next to it.
    if (helper === 'superagent') await buildSuperagentPayload(source)
    for (const name of [
      'package.json',
      'index.mjs',
      ...(existsSync(join(source, 'src')) ? ['src'] : []),
      ...(helper === 'superagent' ? SUPERAGENT_RESOURCE_FOLDERS : []),
      'README.md',
      'LICENSE',
    ])
      await cp(join(source, name), join(destination, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
    if (existsSync(join(source, 'README.zh-CN.md')))
      await cp(join(source, 'README.zh-CN.md'), join(destination, 'README.zh-CN.md'))
    if (existsSync(join(source, 'NOTICE'))) await cp(join(source, 'NOTICE'), join(destination, 'NOTICE'))
    // Licenses of adapted third-party code (THIRD-PARTY-NOTICES, LICENSE.<name>) travel with the code they cover.
    for (const name of await readdir(source))
      if (/^(THIRD-PARTY-NOTICES|LICENSE\..+)$/.test(name))
        await cp(join(source, name), join(destination, name))
    if (presentations.some((record) => record.name === helper)) {
      await cp(join(source, 'client-build.json'), join(destination, 'client-build.json'))
      await verifyPresentation(destination)
    }
    if (helper === 'document-reader') await prepareDocumentReader(destination)
    if (helper === 'browser') await prepareBrowser(destination)
    await stampBundledPackageVersion(destination, version)
    await checkPackagedClientModules(destination)
  }
  // Boot compares installed defaults with these final-payload digests instead of re-hashing them.
  const digests = Object.fromEntries(
    [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].map(({ name }) => [
      `bundled-plugins/${name}`,
      hashDirectory(join(outputDirectory, 'bundled-plugins', name)),
    ]),
  )
  await writeFile(join(outputDirectory, BUNDLED_PLUGIN_DIGESTS), `${JSON.stringify(digests, null, 2)}\n`)
}

/** Ship the curated example payload independently of the user's workspace. */
export async function copyBundledExamples(outputDirectory: string, version = '0.0.0'): Promise<void> {
  const parentVersions = new Map<string, string>()
  for (const pkg of [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES]) {
    const parent = JSON.parse(await readFile(join(repoPackages, pkg.sourcePath, 'package.json'), 'utf8'))
    parentVersions.set(pkg.id, bundledPackageVersion(parent.version, version))
  }
  for (const { family, name } of BUNDLED_EXAMPLES) {
    const source = join(repoPackages, '..', 'examples', family, name)
    if (!existsSync(join(source, 'package.json'))) continue
    const destination = join(outputDirectory, 'bundled-examples', family, name)
    await copyExamplePayload(source, destination)
    const manifestPath = join(destination, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const [id, parentVersion] of parentVersions)
      if (manifest.dependencies?.[id]) manifest.dependencies[id] = parentVersion
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await checkPackagedClientModules(destination)
  }
}
