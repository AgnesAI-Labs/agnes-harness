import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoader } from '@agnes/host'
import { sourceTranspileCache } from '../../packages/daemon/test/source-transpile-cache.js'

// Source-worker contract tests share this compiled-source cache; cold compiler work belongs to
// CI preparation. The subsequent worker still evaluates every plugin through the production loader.
const repository = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(repository, 'packages', 'daemon', 'package.json'))
const loader = createLoader({
  cacheDir: sourceTranspileCache(),
  hostRoot: repository,
  agnesVersion: '0.0.0',
})
for (const name of ['@agnes/base', '@agnes/code', '@agnes/ai']) {
  await loader.import(require.resolve(name))
  console.log(`Prepared source transpile cache: ${name}`)
}
