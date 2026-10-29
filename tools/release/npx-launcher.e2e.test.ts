import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each([false, true])(
  'launches an empty prebuild directory with vendor payload = %s',
  async (withVendor) => {
    const root = await mkdtemp(join(tmpdir(), 'agh-launcher-test-'))
    try {
      const triple = `${process.platform}-${process.arch}` // guards-allow-platform: synthetic prebuild fixture for this host.
      await mkdir(join(root, 'bin'))
      await mkdir(join(root, 'dist/prebuilds', triple), { recursive: true })
      await copyFile(join(import.meta.dirname, '../../packages/cli/bin/agh'), join(root, 'bin/agh'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      if (withVendor) {
        const runtime = join(root, 'dist/vendor/@fixture/runtime')
        await mkdir(runtime, { recursive: true })
        await writeFile(join(runtime, 'package.json'), '{"type":"module","exports":"./index.mjs"}')
        await writeFile(join(runtime, 'index.mjs'), 'export const value = "launcher-ready"')
      }
      await writeFile(
        join(root, 'dist/agnes.mjs'),
        withVendor
          ? 'import { value } from "@fixture/runtime"; console.log(value)'
          : 'console.log("launcher-ready")',
      )
      const { stdout } = await execute(process.execPath, [join(root, 'bin/agh'), '--version'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, AGH_HOME: join(root, 'agh') },
        timeout: 10_000,
      })
      expect(stdout).toBe('launcher-ready\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
