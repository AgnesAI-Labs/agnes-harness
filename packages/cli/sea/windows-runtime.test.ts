import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const binary = process.env.AGNES_SEA_BIN
it.skipIf(process.platform !== 'win32' || !binary)(
  'delivers the Windows native module and Job broker with the SEA Node runtime',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-sea-runtime-中文 '))
    try {
      await cp(dirname(binary as string), root, { recursive: true })
      expect(existsSync(join(root, basename(binary as string))), 'copied SEA executable').toBe(true)
      const packages = fileURLToPath(new URL('../../', import.meta.url))
      const entry = join(root, 'runtime-check.mjs')
      await build({
        stdin: {
          resolveDir: packages,
          contents: `
            import {startWindowsJobProcess} from ${JSON.stringify(join(packages, 'system-node/src/process-spawn.ts'))};
            const child=await startWindowsJobProcess([process.execPath,'-e','process.stdout.write("SEA 中文");process.exitCode=7'],{
              cwd:process.cwd(),env:{SystemRoot:process.env.SystemRoot},nodeExecutable:process.execPath
            });
            const output=[];child.stdout.on('data',chunk=>output.push(chunk));child.stderr.resume();child.stdin.end();
            const result=await child.completion;
            if(result.error)throw result.error;
            console.log(JSON.stringify({code:result.code,text:Buffer.concat(output).toString('utf8')}));
          `,
        },
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
      })
      const options = {
        cwd: root,
        encoding: 'utf8' as const,
        timeout: 15000,
        windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, NODE_PATH: '' },
      }
      expect(execFileSync(join(root, basename(binary as string)), ['--version'], options)).toMatch(/^agh /)
      const runtime = join(root, 'runtime', 'node.exe')
      expect(JSON.parse(execFileSync(runtime, [entry], options))).toEqual({ code: 7, text: 'SEA 中文' })
      const native = join(root, 'node_modules/@agnes/system-node/dist/native/agnes-system.node')
      renameSync(native, `${native}.unavailable`)
      const missing = spawnSync(runtime, [entry], options)
      expect(missing.error).toBeUndefined()
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('E_SYSTEM_NATIVE_UNAVAILABLE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  // Copy the distribution and allow three independently bounded 15-second child processes.
  60_000,
)
