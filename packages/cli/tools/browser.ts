import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../package-manager/bundled-plugins/browser/', import.meta.url))

/** Playwright loads dynamic files: preserve its complete pinned, licensed runtime instead of bundling it. */
export async function prepareBrowser(destination: string): Promise<void> {
  const require = createRequire(join(source, 'package.json'))
  const root = dirname(require.resolve('playwright-core/package.json'))
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.version !== '1.63.0') throw new Error('Unexpected browser engine version')
  const runtime = join(destination, 'dist', 'runtime', 'playwright')
  await mkdir(dirname(runtime), { recursive: true })
  await copyFile(require.resolve('@agnes/system-node/owner-lock'), join(dirname(runtime), 'owner-lock.mjs'))
  await cp(root, runtime, { recursive: true, dereference: true, errorOnExist: true, force: false })
}
