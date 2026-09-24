import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('single-file Node bundle starts all five real OAuth flows and forwards authorization notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-oauth-bundle-'))
  try {
    const outfile = join(root, 'login.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/oauth-start.ts', import.meta.url))],
      outfile,
      bundle: true,
      packages: 'bundle',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    })
    const result = await promisify(execFile)(process.env.npm_node_execpath ?? process.execPath, [outfile], {
      timeout: 25_000,
    })
    expect(result.stdout.match(/authorization notice delivered/g)).toHaveLength(5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
