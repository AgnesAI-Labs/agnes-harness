import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { createExec, type ExecAdapter } from '../../src/adapters/exec.js'

const adapters: ExecAdapter[] = []
const roots: string[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.killAll()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'agnes-win-exec-中文 '))
  roots.push(cwd)
  const exec = createExec({ windowsNodeExecutable: process.execPath })
  adapters.push(exec)
  return { cwd, exec }
}
function tree(marker: string) {
  return [
    process.execPath,
    '-e',
    `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],
      {detached:true,windowsHide:true,stdio:'ignore'});
    child.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid)));
    setTimeout(()=>{},15000);
  `,
  ]
}

describe.skipIf(process.platform !== 'win32')('Host Windows Job execution', () => {
  it('lets explicit environment names override inherited names regardless of case', async () => {
    const { cwd } = setup()
    const exec = createExec({
      windowsNodeExecutable: process.execPath,
      baseEnv: { PATH: 'inherited', Path: 'duplicate', SystemRoot: process.env.SystemRoot ?? '' },
    })
    adapters.push(exec)
    for (const env of [{ Path: '中文 path' }, { PATH: 'uppercase' }, { path: '' }]) {
      const result = await exec.run(
        [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({path:process.env.PATH,keys:Object.keys(process.env).filter(k=>k.toUpperCase()==="PATH")}))',
        ],
        { cwd, env },
      )
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ path: Object.values(env)[0], keys: Object.keys(env) })
    }
  })

  it('keeps argv, stdin, UTF-8 and explicit env while excluding host secrets', async () => {
    const { cwd, exec } = setup()
    const previous = process.env.AGNES_EXEC_TEST_PRIVATE
    process.env.AGNES_EXEC_TEST_PRIVATE = 'private'
    try {
      const result = await exec.run(
        [
          process.execPath,
          '-e',
          `
        let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);
        process.stdin.on('end',()=>{
          process.stdout.write(JSON.stringify({args:process.argv.slice(1),text,visible:process.env.VISIBLE,hidden:process.env.AGNES_EXEC_TEST_PRIVATE??null}));
          process.stderr.write('错误');process.exitCode=2;
        });
      `,
          '',
          '中文 "引用"',
          '$HOME && echo nope',
        ],
        { cwd, stdin: '输入🌱', env: { VISIBLE: 'yes' } },
      )
      expect(result).toMatchObject({ code: 2, stderr: '错误', timedOut: false, truncated: false })
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['', '中文 "引用"', '$HOME && echo nope'],
        text: '输入🌱',
        visible: 'yes',
        hidden: null,
      })
    } finally {
      if (previous === undefined) delete process.env.AGNES_EXEC_TEST_PRIVATE
      else process.env.AGNES_EXEC_TEST_PRIVATE = previous
    }
  })

  it('uses the existing separate byte caps for both output streams', async () => {
    const { cwd, exec } = setup()
    const result = await exec.run(
      [process.execPath, '-e', 'process.stdout.write("🌱".repeat(20));process.stderr.write("x".repeat(20))'],
      { cwd, maxOutputBytes: 8 },
    )
    expect(result).toMatchObject({ stdout: '🌱🌱', stderr: 'xxxxxxxx', truncated: true, code: 0 })
  })

  it.each(['abort', 'killAll'])('waits for the entire tree to exit on %s', async (method) => {
    const { cwd, exec } = setup()
    const marker = join(cwd, 'pid')
    const controller = new AbortController()
    const pending = exec.run(tree(marker), { cwd, signal: controller.signal })
    await expect.poll(() => existsSync(marker)).toBe(true)
    const pid = Number(readFileSync(marker, 'utf8'))
    expect(windowsProcessStartTimeSync(pid)).toBeTypeOf('string')
    if (method === 'abort') controller.abort()
    else await exec.killAll()
    expect(await pending).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    expect(windowsProcessStartTimeSync(pid)).toBeNull()
    await exec.killAll()
  })

  it('terminates descendants on timeout and preserves timedOut', async () => {
    const { cwd, exec } = setup()
    const marker = join(cwd, 'pid')
    const result = await exec.run(tree(marker), { cwd, timeoutMs: 1000 })
    expect(result.timedOut).toBe(true)
    const text = readFileSync(marker, 'utf8')
    expect(text).toMatch(/^[1-9][0-9]*$/)
    expect(windowsProcessStartTimeSync(Number(text))).toBeNull()
  })

  it('includes a not-yet-started command in killAll and never runs its business code', async () => {
    const { cwd, exec } = setup()
    const marker = join(cwd, 'must-not-run')
    const pending = exec.run(
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
      { cwd },
    )
    await exec.killAll()
    expect(await pending).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a pre-aborted request with its reason and recovers from missing executables', async () => {
    const { cwd, exec } = setup()
    const controller = new AbortController(),
      reason = new Error('cancel before spawn')
    controller.abort(reason)
    await expect(exec.run([process.execPath, '-e', '0'], { cwd, signal: controller.signal })).rejects.toBe(
      reason,
    )
    await expect(exec.run(['agnes-no-such-executable'], { cwd })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await exec.run([process.execPath, '-e', 'process.stdout.write("ok")'], { cwd })).toMatchObject({
      code: 0,
      stdout: 'ok',
    })
  })
})
