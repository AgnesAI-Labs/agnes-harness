import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * A profile `cacheDir` that source-worker tests share across runs, so a worker does not transpile
 * every official plugin again under each test's fresh home. Only jiti's transpile cache lives
 * there; each test keeps its own home, data and profile.
 *
 * jiti names each entry after the source path and accepts it only when the stored trailer carries
 * its own version and a hash of the current source, so an edited file is transpiled again. The
 * directory is also keyed by the installed (patched) jiti and the Node version, whose behaviour
 * the trailer does not cover. It lives under `node_modules/.cache`, which CI can restore.
 */
export function sourceTranspileCache(): string {
  // The production loader imports jiti from @agnes/host-extensions.
  const loader = createRequire(join(repository, 'packages', 'host-extensions', 'package.json'))
  const jiti = realpathSync(dirname(dirname(loader.resolve('jiti'))))
  const key = createHash('sha256').update(`${jiti}\0${process.version}`).digest('hex').slice(0, 16)
  const directory = join(repository, 'node_modules', '.cache', 'agnes-source-transpile', key)
  mkdirSync(directory, { recursive: true })
  return directory
}
