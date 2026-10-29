import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Source-preview examples use the public starter's declared dist entry, regardless of family. */
export async function copyExamplePayload(source: string, destination: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    exports?: unknown
    files?: unknown
  }
  const declared = Array.isArray(manifest.files) ? manifest.files : []
  const payload = (await readdir(source)).filter(
    (file) =>
      [
        'package.json',
        'LICENSE',
        'fixtures',
        'skills',
        'client',
        'assets',
        'dist',
        'resources',
        'NOTICE',
        'mcp',
        'dag',
        'seed-docs',
        'provider.example.json',
      ].includes(file) ||
      file.startsWith('README') ||
      (file.endsWith('.md') && declared.includes(file)) ||
      (/\.(mjs|mts|json)$/.test(file) && file !== 'tsconfig.json'),
  )
  await mkdir(destination, { recursive: true })
  for (const file of payload) await cp(join(source, file), join(destination, file), { recursive: true })
  const entry = join(source, 'src', 'index.ts')
  if (manifest.exports === './dist/index.js' && existsSync(entry))
    await build({
      entryPoints: [entry],
      outfile: join(destination, 'dist', 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node24'],
      packages: 'external',
      legalComments: 'eof',
    })
}
