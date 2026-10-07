import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** esbuild's JS launcher and platform binary must remain together; its API cannot be bundled. */
export async function copyPluginPackRuntime(outputDirectory: string): Promise<void> {
  const require = createRequire(import.meta.url)
  for (const name of ['esbuild', `@esbuild/${process.platform}-${process.arch}`]) {
    const source = dirname(require.resolve(name + '/package.json'))
    const destination = join(outputDirectory, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, dereference: true })
  }
}
