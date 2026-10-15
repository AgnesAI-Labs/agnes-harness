import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { copyImageRuntime } from '../tools/image-runtime.js'

// Central gate: real native dependencies in a clean directory, runnable on macOS/Linux/Windows.
// The child cannot borrow checkout node_modules through NODE_PATH or a symlink.
it('ships a self-contained local/SEA image runtime with licenses, resize and text-only fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-image-package-'))
  try {
    await copyImageRuntime(dir)
    const require = createRequire(new URL('../../base/package.json', import.meta.url))
    const sharp = require('sharp')
    for (const format of ['png', 'jpeg'] as const) {
      const bytes = await sharp({ create: { width: 1024, height: 512, channels: 3, background: 'white' } })
        [format]()
        .toBuffer()
      await writeFile(join(dir, `input.${format}`), bytes)
    }
    const readTool = fileURLToPath(
      new URL('../../base/extensions/tools-core/src/tools/read.ts', import.meta.url),
    )
    const testkit = fileURLToPath(new URL('../../base/testkit/tool-context.ts', import.meta.url))
    await build({
      stdin: {
        contents: `
        import { readFile } from 'node:fs/promises';
        import { createRequire } from 'node:module';
        import { relative, isAbsolute } from 'node:path';
        import { readTool } from ${JSON.stringify(readTool)};
        import { fakeToolContext } from ${JSON.stringify(testkit)};
        const base = fakeToolContext();
        const ctx = { ...base, fs: { ...base.fs, read: async (path) => path.endsWith('.txt') ? new TextEncoder().encode('ordinary text') : new Uint8Array(await readFile(path)) },
          session: { ...base.session, imageInputPolicy: async () => ({ supported: true, maxWidth: 128, maxHeight: 128, maxPixels: 16384, maxBytes: 100000 }),
            imageInput: async ({bytes, mimeType}) => { const runtime = createRequire(import.meta.url); const location = relative(process.cwd(),runtime.resolve('sharp')); if (location.startsWith('..') || isAbsolute(location)) throw new Error('unpackaged image codec'); const sharp = runtime('sharp'); const info = await sharp(bytes).metadata(); const ref = await base.artifacts.put(bytes,{mime:mimeType}); return {content:[{type:'text',text:JSON.stringify({width:info.width,height:info.height})},{type:'image',ref,mime:mimeType}]}; } } };
        for (const path of ['input.png', 'input.jpeg', 'ordinary.txt']) {
          const value = await readTool.execute({ path }, ctx);
          console.log(JSON.stringify({path, value}));
        }
      `,
        resolveDir: import.meta.dirname,
      },
      outfile: join(dir, 'probe.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: ['sharp'],
    })
    const run = (cwd = dir) =>
      execFileSync(process.execPath, ['probe.mjs'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
        timeout: 30_000,
      })
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const output = run()
    expect(output).toHaveLength(3)
    for (const row of output.slice(0, 2)) {
      expect(row.value.isError).not.toBe(true)
      expect(row.value.content[0].text).toBe(JSON.stringify({ width: 128, height: 64 }))
      expect(row.value.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]))
    }
    // The SEA build transfers this complete native dependency tree beside its bundled worker.
    const sea = join(dir, 'sea-payload')
    await cp(join(dir, 'node_modules'), join(sea, 'node_modules'), { recursive: true, dereference: true })
    for (const file of ['probe.mjs', 'input.png', 'input.jpeg']) await cp(join(dir, file), join(sea, file))
    expect(run(sea)).toEqual(output)
    const native = await readdir(join(dir, 'node_modules', '@img'))
    expect(native.some((name) => name.includes(`${process.platform}-${process.arch}`))).toBe(true)
    expect(await readFile(join(dir, 'node_modules', 'sharp', 'LICENSE'), 'utf8')).toContain('Apache')
    await rm(join(dir, 'node_modules', 'sharp'), { recursive: true })
    const fallback = run()
    expect(JSON.stringify(fallback[0].value)).toContain('codec is unavailable')
    expect(fallback[2].value.isError).not.toBe(true)
    expect(JSON.stringify(fallback[2].value)).toContain('ordinary text')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
