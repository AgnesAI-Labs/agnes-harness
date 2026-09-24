import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

type Owned = { pid: number; exitCode(): number | null; terminate(): void; close(): void }
type Native = { spawnDetached(exe: string, command: string, cwd: string, env: string): Owned }
const windows = process.platform === 'win32'
const nativeModule = windows
  ? (createRequire(import.meta.url)('../dist/native/agnes-system.node') as Native)
  : undefined
function native(): Native {
  if (!nativeModule) throw new Error('Windows native module unavailable')
  return nativeModule
}
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
// Probe serialization, not the eventual production argv adapter.
function quote(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}
function environment(): string {
  return `${Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('\0')}\0\0`
}
async function waitExit(child: Owned): Promise<number> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const code = child.exitCode()
    if (code !== null) return code
    await delay(10)
  }
  throw new Error('Detached child did not exit')
}
function launch(script: string, argv: string[] = [], cwd = process.cwd(), env = environment()): Owned {
  const child = native().spawnDetached(
    process.execPath,
    [process.execPath, '-e', script, ...argv].map(quote).join(' '),
    cwd,
    env,
  )
  cleanup.push(async () => {
    try {
      child.terminate()
      await waitExit(child)
    } catch (error) {
      if ((error as { code?: string }).code !== 'E_PROCESS_CLOSED') throw error
    } finally {
      child.close()
    }
  })
  return child
}
describe.skipIf(!windows)('native detached process ownership', () => {
  it('preserves arguments, Unicode cwd/environment and supports ignored console output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes 后台 '))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const values = ['', '中文 空格', 'a"b', 'trailing\\', '\\"']
    const child = launch(
      "console.log('stdout'); console.error('stderr'); require('node:fs').writeFileSync('result.json',JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),value:process.env.PROBE_UNICODE}));",
      values,
      root,
      `${environment().slice(0, -1)}PROBE_UNICODE=中文🙂\0\0`,
    )
    expect(await waitExit(child)).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))).toEqual({
      argv: values,
      cwd: root,
      value: '中文🙂',
    })
  })
  it('reports an actual exit status of 259 instead of treating it as still running', async () => {
    expect(await waitExit(launch('process.exit(259)'))).toBe(259)
  })
  it('terminates only its owned process and allows repeated termination after exit', async () => {
    const child = launch('setTimeout(()=>{},30000)')
    expect(child.exitCode()).toBeNull()
    child.terminate()
    expect(await waitExit(child)).toBe(1)
    expect(() => child.terminate()).not.toThrow()
  })
  it('close releases ownership without killing the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-detached-close-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const child = launch("setTimeout(()=>require('node:fs').writeFileSync('done','alive'),300)", [], root)
    child.close()
    child.close()
    expect(() => child.exitCode()).toThrow('closed')
    expect(() => child.terminate()).toThrow('closed')
    await expect.poll(() => readFile(join(root, 'done'), 'utf8'), { timeout: 5000 }).toBe('alive')
  })
  it('rejects borrowed receivers, relative paths and malformed environment blocks', () => {
    const child = launch('setTimeout(()=>{},30000)')
    expect(() => child.close.call({})).toThrow('receiver')
    for (const env of ['', '\0', 'bad\0\0', 'A=B\0\0tail', 'A=B\0\0\0'])
      expect(() => native().spawnDetached(process.execPath, 'node', process.cwd(), env)).toThrow()
    expect(() => native().spawnDetached('node.exe', 'node', process.cwd(), environment())).toThrow('absolute')
    expect(() => native().spawnDetached(process.execPath, 'node\0bad', process.cwd(), environment())).toThrow(
      'NUL',
    )
    expect(() =>
      native().spawnDetached(process.execPath, 'x'.repeat(32767), process.cwd(), environment()),
    ).toThrow()
  })
  it('fails immediately for a missing executable or working directory; accepts empty environment', async () => {
    expect(() =>
      native().spawnDetached(
        join(process.cwd(), 'missing-no-such.exe'),
        'missing',
        process.cwd(),
        environment(),
      ),
    ).toThrow('CreateProcessW')
    expect(() => launch('process.exit(0)', [], join(process.cwd(), 'missing-no-such-directory'))).toThrow(
      'CreateProcessW',
    )
    // Node itself requires SystemRoot on this host; verify Win32's empty environment using cmd.
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const child = native().spawnDetached(
      executable,
      `${quote(executable)} /d /c exit 0`,
      process.cwd(),
      '\0\0',
    )
    try {
      expect(await waitExit(child)).toBe(0)
    } finally {
      child.terminate()
      child.close()
    }
    expect(
      await waitExit(
        launch('process.exit(0)', [], process.cwd(), `SystemRoot=${process.env.SystemRoot}\0\0`),
      ),
    ).toBe(0)
  })
})
