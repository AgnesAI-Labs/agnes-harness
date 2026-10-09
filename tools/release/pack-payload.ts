import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Strip build metadata only from the copied distribution, never workspace manifests. */
export async function preparePackPayload(stage: string, repo: string): Promise<void> {
  async function walk(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'package.json') {
        const pkg = JSON.parse(await readFile(path, 'utf8'))
        delete pkg.devDependencies
        delete pkg.scripts
        if (pkg.name === '@agnes/system-node') pkg.license = 'Apache-2.0'
        // Remaining workspace dependencies are an error, not silently rewritten versions.
        await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`)
      }
    }
  }
  await walk(join(stage, 'dist'))
  await cp(join(repo, 'LICENSE'), join(stage, 'dist/vendor/@agnes/system-node/LICENSE'))
  // esbuild's optional executable package shares the parent package's upstream license.
  const binaries = join(stage, 'dist/vendor/@esbuild')
  for (const name of await readdir(binaries))
    await cp(join(stage, 'dist/vendor/esbuild/LICENSE.md'), join(binaries, name, 'LICENSE.md'))
  await cp(join(repo, 'third-party', 'pack-licenses'), join(stage, 'dist', 'license-provenance'), {
    recursive: true,
  })
  const notices = join(stage, 'dist', 'project-notices')
  await mkdir(notices, { recursive: true })
  for (const [name, source] of [
    ['cordis-LICENSE', 'packages/cordis/LICENSE'],
    ['cosmokit-LICENSE', 'packages/cosmokit/LICENSE'],
    ['tools-web-LICENSE', 'packages/base/extensions/tools-web/DEEPSEEK-LICENSE.txt'],
    ['public-fetch-LICENSE', 'packages/host-infrastructure/src/adapters/public-fetch/DEEPSEEK-LICENSE.txt'],
    ['acp-UPSTREAM.md', 'packages/protocol/schema/acp/UPSTREAM.md'],
  ])
    await cp(join(repo, source), join(notices, name))
}
