import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  createWindowsDetachedProcess,
  windowsDetachedCommand,
  windowsDetachedEnvironment,
} from '../src/process-detached.js'

describe.skipIf(process.platform !== 'win32')('detached input compatibility with Node spawn', () => {
  it.each(['\\agnes-missing-path', '/agnes-missing-path', 'C:agnes-missing-path'])(
    'rejects drive-dependent path %s before native startup',
    (path) => {
      expect(() => createWindowsDetachedProcess(path, [], { cwd: process.cwd(), env: {} })).toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      )
      expect(() => createWindowsDetachedProcess(process.execPath, [], { cwd: path, env: {} })).toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      )
    },
  )
  it.each([
    {},
    { PATH: 'first', Path: 'second', EMPTY: '', PROBE: '中文🙂' },
    { PATH: undefined, Path: 'suppressed', EMPTY: '', PROBE: 'a=b' },
  ])('matches actual native argv and environment for %j', async (env) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes 输入 '))
    const baseline = join(root, 'baseline.json')
    const actual = join(root, 'actual.json')
    const argv = [
      '',
      'plain',
      '中文🙂 空格',
      'a"b',
      'a\\"b',
      '\\',
      'end\\',
      'tab\there',
      'line\nnext',
      '&;$()%!',
    ]
    const script =
      "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),path:process.env.PATH,root:process.env.SystemRoot,empty:process.env.EMPTY,probe:process.env.PROBE}));"
    let child: ReturnType<typeof createWindowsDetachedProcess> | undefined
    try {
      const original = spawnSync(process.execPath, ['-e', script, baseline, ...argv], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
      })
      expect(original.error).toBeUndefined()
      expect(original.status).toBe(0)
      child = createWindowsDetachedProcess(process.execPath, ['-e', script, actual, ...argv], {
        cwd: root,
        env,
      })
      const deadline = Date.now() + 5000
      while (child.exitCode() === null && Date.now() < deadline) await delay(10)
      expect(child.exitCode()).toBe(0)
      expect(JSON.parse(await readFile(actual, 'utf8'))).toEqual(JSON.parse(await readFile(baseline, 'utf8')))
    } finally {
      child?.terminate()
      child?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('keeps explicit empty values, excludes unrelated parent variables and does not mutate inputs', () => {
    const env = Object.freeze({ PATH: '', Path: 'ignored', EMPTY: '', PROBE: '中文' })
    const parent = Object.freeze({ Path: 'parent', SystemRoot: 'C:\\Windows', SECRET_PROBE: 'not inherited' })
    const block = windowsDetachedEnvironment(env, parent)
    expect(block.split('\0')).toEqual(['EMPTY=', 'PATH=', 'PROBE=中文', 'SYSTEMROOT=C:\\Windows', '', ''])
    expect(env.Path).toBe('ignored')
  })
  it('rejects invalid input before starting a process', () => {
    expect(() => windowsDetachedCommand(process.execPath, ['bad\0arg'])).toThrow('Invalid')
    expect(() => windowsDetachedCommand(process.execPath, ['x'.repeat(32767)])).toThrow('Invalid')
    expect(() => windowsDetachedEnvironment({ 'A=B': 'c' })).toThrow('Invalid')
    expect(() => windowsDetachedEnvironment({ A: 'b\0c' })).toThrow('Invalid')
    expect(() => createWindowsDetachedProcess('node.exe', [], { cwd: process.cwd(), env: {} })).toThrow(
      'Invalid',
    )
  })
  it('matches coverage inheritance before duplicate filtering, including explicit undefined', () => {
    const parent = { NODE_V8_COVERAGE: 'parent' }
    expect(windowsDetachedEnvironment({ node_v8_coverage: 'lower' }, parent)).toBe(
      'NODE_V8_COVERAGE=parent\0\0',
    )
    expect(windowsDetachedEnvironment({ NODE_V8_COVERAGE: undefined }, parent)).toBe('\0\0')
    expect(windowsDetachedEnvironment({ NODE_V8_COVERAGE: '' }, parent)).toBe('NODE_V8_COVERAGE=\0\0')
  })
})
