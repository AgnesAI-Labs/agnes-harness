import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'

const launcher = resolve(import.meta.dirname, '../bin/agh')
const built = existsSync(resolve(import.meta.dirname, '../dist/local/agnes.mjs'))

function run(timing: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'agh-timing-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, AGH_HOME: home }
    if (timing) env.AGH_TIMING = '1'
    else delete env.AGH_TIMING
    return spawnSync(process.execPath, [launcher, '--help'], { env, encoding: 'utf8' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

it.skipIf(!built)(
  'marks launcher, bootstrap and main-loaded in order on stderr only, and only when asked',
  () => {
    const plain = run(false)
    const timed = run(true)
    expect(plain.stderr).toBe('')
    expect(timed.stdout).toBe(plain.stdout)
    const marks = [...timed.stderr.matchAll(/^agh-timing (\S+) (\d+\.\d)$/gm)]
    expect(marks.map((m) => m[1])).toEqual([
      'launcher',
      'bootstrap',
      'main-loaded',
      'main-returned',
      'stdio-flush-enter',
      'stdio-flush-leave',
    ])
    const times = marks.map((m) => Number(m[2]))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  },
)

it('delivers all pending stdout to a live pipe reader that resumes after a delay', async () => {
  const payload = Buffer.alloc(1024 * 1024, 'x')
  const source = new URL('../src/bin.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '--eval',
      `import { once } from 'node:events';
       import { Writable } from 'node:stream';
       const { runExecutable } = await import(${JSON.stringify(source)});
       // Windows can block on stdout writes. Queue bytes now and forward them once the parent reads.
       const pipe = process.stdout;
       const readerReady = once(process.stdin, 'data');
       const stdout = new Writable({
         write(chunk, _encoding, done) {
           void readerReady.then(() => pipe.write(chunk, done)).catch(done);
         },
       });
       Object.defineProperty(process, 'stdout', { value: stdout });
       process.argv = [process.execPath, 'fixture', '--version'];
       stdout.write(Buffer.alloc(${payload.length}, 'x'));
       await runExecutable();`,
    ],
    { env: { ...process.env, AGH_TIMING: '1' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000 },
  )
  const closed = once(child, 'close')
  void closed.catch(() => undefined)
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text
  })
  try {
    await vi.waitFor(() => expect(stderr).toContain('stdio-flush-enter'), { timeout: 35_000 })
    await delay(1_600)
    expect(stderr).not.toContain('stdio-flush-leave')
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    const released = once(child.stdin, 'finish')
    child.stdin.end('read')
    await released
    await expect(closed).resolves.toEqual([0, null])
    const output = Buffer.concat(chunks)
    expect(output.subarray(0, payload.length).equals(payload)).toBe(true)
    expect(output.subarray(payload.length).toString()).toMatch(/^agh /u)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed.catch(() => undefined)
  }
}, 60_000)
