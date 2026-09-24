import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { buildWindowsRuntime, copyWindowsRuntime, withBuiltWindowsRuntime } from '../tools/windows-runtime.js'

it.runIf(process.platform === 'win32')(
  'cleans temporary native output when distribution assembly fails',
  async () => {
    const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const failure = new Error('distribution assembly fixture failed')
    let compilerDirectory = ''
    await expect(
      withBuiltWindowsRuntime(packages, async (directory) => {
        compilerDirectory = directory
        expect(existsSync(join(directory, 'agnes-system.node'))).toBe(true)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(compilerDirectory).not.toBe('')
    expect(existsSync(compilerDirectory)).toBe(false)
  },
  30_000,
)

it.runIf(process.platform === 'win32')(
  'runs bundled Windows file and process primitives outside the source checkout',
  async () => {
    const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const root = mkdtempSync(join(tmpdir(), 'agnes-portable-中文 '))
    try {
      // A live shared addon reproduces the whole-suite build collision on Windows.
      createRequire(import.meta.url)(join(packages, 'system-node', 'dist', 'native', 'agnes-system.node'))
      const nativeOutput = join(root, 'fresh-native')
      buildWindowsRuntime(packages, nativeOutput)
      await copyWindowsRuntime(packages, root, nativeOutput)
      const entry = join(root, 'probe.mjs')
      await build({
        stdin: {
          resolveDir: packages,
          contents: `
        import {createRequire} from 'node:module';
        import {dirname,join} from 'node:path';
        import {fileURLToPath} from 'node:url';
        import {closeSync,writeFileSync} from 'node:fs';
        import {createPrivateDirectorySync,createPrivateFileSync,hasPrivateDaclSync} from ${JSON.stringify(join(packages, 'system-node', 'src', 'index.ts'))};
        import {startWindowsJobProcess} from ${JSON.stringify(join(packages, 'system-node', 'src', 'process-spawn.ts'))};
        const root=dirname(fileURLToPath(import.meta.url));
        const loaded=createRequire(import.meta.url).resolve('@agnes/system-node/native');
        if(!loaded.startsWith(join(root,'node_modules')))throw Error('loaded source native module');
        const privateDir=join(root,'private');createPrivateDirectorySync(privateDir);
        const file=join(privateDir,'test.txt'),fd=createPrivateFileSync(file);
        writeFileSync(fd,'private');closeSync(fd);
        const child=await startWindowsJobProcess([process.execPath,'-e','process.stdout.write("portable 中文");process.exitCode=7'],{
          cwd:root,nodeExecutable:process.execPath,env:{SystemRoot:process.env.SystemRoot??''}
        });
        const chunks=[];child.stdout.on('data',x=>chunks.push(x));child.stderr.resume();child.stdin.end();
        const result=await child.completion;
        console.log(JSON.stringify({code:result.code,text:Buffer.concat(chunks).toString('utf8'),private:hasPrivateDaclSync(file)}));
      `,
        },
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
      })
      const output = execFileSync(process.execPath, [entry], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, NODE_PATH: '' },
      })
      expect(JSON.parse(output)).toEqual({ code: 7, text: 'portable 中文', private: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)
