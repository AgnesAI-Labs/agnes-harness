import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWindowsJobProcess, type WindowsJobProcess } from '../src/process-spawn.js'

const roots: string[] = []
const live: WindowsJobProcess[] = []
afterEach(async () => {
  for (const child of live.splice(0)) {
    child.terminate()
    await child.completion
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
  windowsBatch?: 'script' | 'argv-proxy',
) {
  const child = await startWindowsJobProcess(argv, {
    cwd,
    nodeExecutable: process.execPath,
    ...(windowsBatch === undefined ? {} : { windowsBatch }),
    env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', ...env },
  })
  live.push(child)
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
  child.stdin.end()
  const result = await child.completion
  return {
    ...result,
    stdout: Buffer.concat(chunks).toString('utf8'),
    stderr: Buffer.concat(errors).toString('utf8'),
  }
}
describe.skipIf(process.platform !== 'win32')('Windows batch launch', () => {
  it.each([false, true])('forwards literal argv through a batch proxy (npm shim: %s)', async (shim) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-batch-中文 & %AGNES_EXPAND% ! ^ '))
    roots.push(root)
    const bin = shim ? join(root, 'node_modules', '.bin') : root
    mkdirSync(bin, { recursive: true })
    const script = join(root, 'echo.cjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(bin, 'echo.cmd'), '@echo off\r\n"%AGNES_TEST_NODE%" "%AGNES_TEST_SCRIPT%" %*\r\n')
    const args = [
      '',
      '中文 空格',
      'a"b',
      'tail\\',
      'a&b|c',
      '%AGNES_EXPAND%',
      '!AGNES_EXPAND!',
      '^()<>',
      '"&echo INJECTED>marker.txt&"',
    ]
    const result = await run(
      ['echo.cmd', ...args],
      root,
      {
        PATH: bin,
        AGNES_EXPAND: 'expanded',
        AGNES_TEST_NODE: process.execPath,
        AGNES_TEST_SCRIPT: script,
      },
      'argv-proxy',
    )
    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
    expect(existsSync(join(root, 'marker.txt'))).toBe(false)
  })
  it('runs the installed npm batch entry without bypassing its own version selection', async () => {
    const result = await run(['npm', '--version'], process.cwd(), {}, 'argv-proxy')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('packs a local package through npm with literal destination and lifecycle scripts disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-pack-中文 & '))
    roots.push(root)
    const destination = join(root, 'output %AGNES_EXPAND% !')
    mkdirSync(destination)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'agnes-windows-local-fixture',
        version: '1.0.0',
        files: ['hello.txt'],
        scripts: { prepack: "node -e \"require('node:fs').writeFileSync('lifecycle-ran','bad')\"" },
      }),
    )
    writeFileSync(join(root, 'hello.txt'), 'hello')
    const result = await run(
      ['npm', 'pack', '.', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination],
      root,
      { AGNES_EXPAND: 'expanded' },
      'argv-proxy',
    )
    expect(result.code, JSON.stringify(result)).toBe(0)
    const packed = JSON.parse(result.stdout)
    expect(packed[0].name).toBe('agnes-windows-local-fixture')
    expect(existsSync(join(destination, packed[0].filename))).toBe(true)
    expect(existsSync(join(root, 'lifecycle-ran'))).toBe(false)
  }, 15_000) // Real npm pack takes several seconds before full-suite CPU contention.
  it('preserves a batch script reading its own first parameter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-batch-owned-'))
    roots.push(root)
    const command = join(root, 'read.bat')
    writeFileSync(command, '@echo off\r\nif "%~1"=="hello world" (exit /b 0) else (exit /b 7)\r\n')
    const result = await run([command, 'hello world'], root)
    expect(result.code, JSON.stringify(result)).toBe(0)
  })
  it('keeps ordinary script parameters literal without enabling proxy parsing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-batch-parameter-'))
    roots.push(root)
    const command = join(root, 'read.cmd')
    writeFileSync(
      command,
      '@echo off\r\nset "AGNES_BATCH_VALUE=%~1"\r\nnode -e "process.stdout.write(JSON.stringify(process.env.AGNES_BATCH_VALUE ?? \'\'))"\r\n',
    )
    for (const value of ['hello world', '中文', '', '%AGNES_EXPAND%', '!AGNES_EXPAND!', 'a&b', 'x^y']) {
      const result = await run([command, value], root, { AGNES_EXPAND: 'expanded' })
      expect(result.code, JSON.stringify(result)).toBe(0)
      expect(JSON.parse(result.stdout)).toBe(value)
    }
  })
  it('rejects unknown batch modes before starting a command', async () => {
    await expect(
      startWindowsJobProcess([process.execPath, '-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        nodeExecutable: process.execPath,
        env: {},
        windowsBatch: 'unknown' as 'script',
      }),
    ).rejects.toMatchObject({ code: 'EINVAL' })
  })
  it('rejects unrepresentable batch arguments before executing its body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-batch-reject-'))
    roots.push(root)
    const command = join(root, 'marker.bat')
    writeFileSync(command, '@echo off\r\necho ran > "%~dp0marker.txt"\r\n')
    for (const arg of ['line\nnext', 'line\rnext', 'x'.repeat(10000)])
      await expect(run([command, arg], root)).rejects.toMatchObject({ code: 'E_WINDOWS_BATCH_ARGUMENT' })
    await expect(run(['missing & echo ran > marker.txt'], root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(join(root, 'marker.txt'))).toBe(false)
  })
})
