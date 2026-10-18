import { chmod, copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const browserRuntimeSource = fileURLToPath(
  new URL('../../package-manager/bundled-plugins/browser-runtime/', import.meta.url),
)

/** Ship only the target's pinned control daemon; other platforms inflate every plugin integrity read. */
export async function prepareBrowserRuntime(
  destination = browserRuntimeSource,
  target: { platform: NodeJS.Platform; arch: string } = process, // guards-allow-platform: native payload build target
): Promise<void> {
  // Keep packaging and execution on the same platform mapping, including Windows ARM emulation.
  const { binaryName } = await import(pathToFileURL(join(browserRuntimeSource, 'src/engine.mjs')).href)
  const binary: string = binaryName(target.platform, target.arch)
  const require = createRequire(join(browserRuntimeSource, 'package.json'))
  const root = dirname(require.resolve('agent-browser/package.json'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.version !== '0.39.1') throw new Error('Unreviewed agent-browser protocol version')
  if (!(await readdir(join(root, 'bin'))).includes(binary))
    throw new Error(`Missing browser platform payload: ${binary}`)
  const output = join(destination, 'dist', 'bin')
  await mkdir(output, { recursive: true })
  await copyFile(join(root, 'bin', binary), join(output, binary))
  await chmod(join(output, binary), 0o755)
  // Source builds reuse this directory. Remove only known obsolete payloads, never user data or pins.
  for (const name of await readdir(output)) {
    if (name !== binary && /^agent-browser-(darwin|win32|linux)-(x64|arm64)(\.exe)?$/.test(name))
      await unlink(join(output, name))
  }
  await copyFile(join(root, 'LICENSE'), join(destination, 'dist', 'agent-browser-LICENSE'))
  await writeFile(
    join(destination, 'dist', 'provenance.json'),
    `${JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license, source: 'https://github.com/vercel-labs/agent-browser/tree/v0.39.1', binaries: [binary] }, null, 2)}\n`,
  )
}
