import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const HOOKS_RUNNER_ENTRY = 'hooks-runner.mjs'
export const HOOKS_RUNNER_MANIFEST = 'hooks-runner.manifest.json'

export type HooksRunnerManifest = {
  schemaVersion: 1
  protocolVersion: 1
  entry: typeof HOOKS_RUNNER_ENTRY
  sha256: string
  node: { minimum: '24.10.0'; major: 24 }
}

/** Build the fixed runner as one reproducible ESM file; no extension source or tsx is needed at runtime. */
export async function buildHooksIsolationRunner(outputDirectory: string): Promise<HooksRunnerManifest> {
  const out = resolve(outputDirectory)
  const temporary = `${out}.tmp-${process.pid}`
  const baseRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  const entry = join(temporary, HOOKS_RUNNER_ENTRY)
  try {
    const built = await build({
      absWorkingDir: baseRoot,
      entryPoints: ['src/hooks-isolation-runner.ts'],
      outfile: entry,
      bundle: true,
      metafile: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import {createRequire as runtimeRequire} from 'node:module'; const require=runtimeRequire(import.meta.url);",
      },
      target: ['node24.10'],
      packages: 'bundle',
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'warning',
    })
    if (
      Object.values(built.metafile.outputs).some((output) =>
        output.imports.some((item) => !isBuiltin(item.path)),
      )
    )
      throw new Error('runner artifact has an external package import')
    const sha256 = createHash('sha256')
      .update(await readFile(entry))
      .digest('hex')
    const manifest: HooksRunnerManifest = {
      schemaVersion: 1,
      protocolVersion: 1,
      entry: HOOKS_RUNNER_ENTRY,
      sha256,
      node: { minimum: '24.10.0', major: 24 },
    }
    await writeFile(join(temporary, HOOKS_RUNNER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
    })
    await rm(out, { recursive: true, force: true })
    await mkdir(dirname(out), { recursive: true })
    await rename(temporary, out)
    return manifest
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  await buildHooksIsolationRunner(join(root, 'dist', 'isolation'))
}
