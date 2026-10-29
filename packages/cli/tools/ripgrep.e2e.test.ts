import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { copyRipgrep } from './ripgrep.js'

it('delivers the pinned search binary and licenses beside a bundle without node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-ripgrep-delivery-'))
  try {
    await copyRipgrep(root)
    await build({
      stdin: {
        contents:
          "import { ripgrepPath } from './packages/base/extensions/tools-search/src/tools/rg-path.ts'; import { execFileSync } from 'node:child_process'; console.log(execFileSync(ripgrepPath(), ['--version'], { encoding: 'utf8' }));",
        resolveDir: process.cwd(),
      },
      outfile: join(root, 'search.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      define: {
        AGNES_BUNDLED_RIPGREP_PATH: JSON.stringify(
          `./ripgrep/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`,
        ),
      },
    })
    expect(
      execFileSync(process.execPath, [join(root, 'search.mjs')], { cwd: root, encoding: 'utf8' }),
    ).toContain('ripgrep ')
    expect(await readFile(join(root, 'ripgrep', 'LICENSE'), 'utf8')).toContain('MIT')
    expect(await readFile(join(root, 'ripgrep', 'WRAPPER-LICENSE'), 'utf8')).toContain('MIT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
