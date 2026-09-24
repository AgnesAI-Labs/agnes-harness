import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsEnvironmentNamesEqual, windowsProcessStartTimeSync } from '../src/index.js'
import {
  mergeWindowsEnvironment,
  startWindowsJobProcess,
  type WindowsJobProcess,
} from '../src/process-spawn.js'

const roots: string[] = []
it
  .runIf(process.platform === 'win32')
  .each(['\\agnes-missing-path', '/agnes-missing-path', 'C:agnes-missing-path'])(
  'rejects drive-dependent Job paths %s before startup',
  async (path) => {
    await expect(
      startWindowsJobProcess([process.execPath], { ...options(), cwd: path }),
    ).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(
      startWindowsJobProcess([process.execPath], { ...options(), nodeExecutable: path }),
    ).rejects.toMatchObject({ code: 'EINVAL' })
  },
)
const live: WindowsJobProcess[] = []
const options = () => ({
  cwd: process.cwd(),
  nodeExecutable: process.execPath,
  env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' },
})
async function start(argv: string[], extra: Partial<Parameters<typeof startWindowsJobProcess>[1]> = {}) {
  const process = await startWindowsJobProcess(argv, { ...options(), ...extra })
  live.push(process)
  return process
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-gate-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const child of live.splice(0)) {
    child.terminate()
    await child.completion
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Windows process start gate', () => {
  it('merges Windows environment names without collapsing distinct Unicode names', async () => {
    expect(windowsEnvironmentNamesEqual('Path', 'PATH')).toBe(true)
    expect(windowsEnvironmentNamesEqual('é', 'É')).toBe(true)
    expect(windowsEnvironmentNamesEqual('ß', 'SS')).toBe(false)
    for (const name of ['', 'a=b', 'a\0b']) expect(() => windowsEnvironmentNamesEqual(name, 'PATH')).toThrow()
    const first = { PATH: 'old', é: 'old-accent', ß: 'sharp', SS: 'double' }
    const override = JSON.parse('{"Path":"", "É":"new-accent", "__proto__":"literal"}') as Record<
      string,
      string
    >
    const merged = mergeWindowsEnvironment(first, override)
    expect(merged).toEqual(
      JSON.parse('{"Path":"", "É":"new-accent", "ß":"sharp", "SS":"double", "__proto__":"literal"}'),
    )
    expect(first.PATH).toBe('old')
    const child = await start(
      [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify([process.env.PATH,process.env["é"],process.env["ß"],process.env.SS,process.env.__proto__]))',
      ],
      { env: { ...options().env, PATH: 'old', ...override, ß: 'sharp', SS: 'double' } },
    )
    const output = collect(child.stdout)
    child.stderr.resume()
    child.stdin.end()
    expect(await child.completion).toMatchObject({ code: 0 })
    expect(JSON.parse(await output)).toEqual(['', 'new-accent', 'sharp', 'double', 'literal'])
  })

  it('preserves argv, Unicode, empty arguments, stdin, environment and target exit code', async () => {
    const args = ['', '中文 空格', 'a"b', 'trailing\\', '$HOME && echo nope']
    const child = await start(
      [
        process.execPath,
        '-e',
        `
      let input = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({args: process.argv.slice(1), input, env: process.env.GATE_VALUE}));
        process.stderr.write('错误信息'); process.exitCode = 7;
      });
    `,
        ...args,
      ],
      { env: { ...options().env, GATE_VALUE: '环境值' } },
    )
    const stdout = collect(child.stdout),
      stderr = collect(child.stderr)
    child.stdin.end('输入🌱')
    expect(await child.completion).toEqual({ code: 7, signal: null, cancelled: false })
    expect(JSON.parse(await stdout)).toEqual({ args, input: '输入🌱', env: '环境值' })
    expect(await stderr).toBe('错误信息')
    expect(windowsProcessStartTimeSync(child.pid)).toBeNull()
  })

  it('reaps descendants when the finite command root exits normally', async () => {
    const child = await start([
      process.execPath,
      '-e',
      `
      const {spawn} = require('node:child_process');
      const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'],
        {detached:true, windowsHide:true, stdio:'ignore'});
      c.once('spawn', () => process.stdout.write(String(c.pid), () => process.exit(3)));
    `,
    ])
    const output = collect(child.stdout)
    child.stderr.resume()
    child.stdin.end()
    expect(await child.completion).toEqual({ code: 3, signal: null, cancelled: false })
    const pid = await output
    expect(pid).toMatch(/^[1-9][0-9]*$/)
    expect(windowsProcessStartTimeSync(Number(pid))).toBeNull()
  })

  it('cancels the assigned tree and waits for it to disappear', async () => {
    const child = await start([
      process.execPath,
      '-e',
      `
      const {spawn} = require('node:child_process');
      const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'],
        {detached:true, windowsHide:true, stdio:'ignore'});
      c.once('spawn', () => process.stdout.write(String(c.pid)));
      setTimeout(()=>{},15000);
    `,
    ])
    const [chunk] = await once(child.stdout, 'data')
    const pid = Number(chunk.toString())
    expect(pid).toBeGreaterThan(0)
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end()
    child.terminate()
    expect(await child.completion).toEqual({ code: 1, signal: null, cancelled: true })
    expect(windowsProcessStartTimeSync(pid)).toBeNull()
  })

  it('tracks a burst of short-lived and surviving descendants before reporting completion', async () => {
    const child = await start([
      process.execPath,
      '-e',
      `
      const {spawn} = require('node:child_process');
      const pids = [];
      for (let i=0; i<12; i++) {
        const c = spawn(process.execPath, ['-e', i % 2 ? 'setTimeout(()=>{},15000)' : 'process.exit(0)'],
          {detached:true, windowsHide:true, stdio:'ignore'});
        c.once('spawn', () => {
          pids.push(c.pid);
          if (pids.length === 12) process.stdout.write(JSON.stringify(pids), () => process.exit(9));
        });
      }
    `,
    ])
    const output = collect(child.stdout)
    child.stderr.resume()
    child.stdin.end()
    expect(await child.completion).toEqual({ code: 9, signal: null, cancelled: false })
    const pids = JSON.parse(await output) as number[]
    expect(pids).toHaveLength(12)
    for (const pid of pids) expect(windowsProcessStartTimeSync(pid)).toBeNull()
  })

  it.each(['before', 'during'])('does not run business code when cancelled %s startup', async (when) => {
    const marker = join(temporary(), 'must-not-run')
    const controller = new AbortController()
    if (when === 'before') controller.abort()
    const pending = startWindowsJobProcess(
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
      { ...options(), signal: controller.signal },
    )
    if (when === 'during') controller.abort()
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(existsSync(marker)).toBe(false)
  })

  it('reports an unavailable target without falling back to an uncontrolled launch', async () => {
    await expect(
      startWindowsJobProcess(['agnes-no-such-process-gate-command'], options()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not inherit host NODE_OPTIONS into the trusted broker', async () => {
    const dir = temporary(),
      marker = join(dir, 'preloaded'),
      preload = join(dir, 'preload.cjs')
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
    try {
      const child = await start([process.execPath, '-e', 'process.stdout.write("ok")'])
      const output = collect(child.stdout)
      child.stderr.resume()
      child.stdin.end()
      expect(await child.completion).toEqual({ code: 0, signal: null, cancelled: false })
      expect(await output).toBe('ok')
      expect(existsSync(marker)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
    }
  })
})
