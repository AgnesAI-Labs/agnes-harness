// The broker's restricted-launch protocol on any OS. The broker runs as a real child process; a
// module hook replaces its native module with a recording fake, so no process is created.
import { type ChildProcess, fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const broker = fileURLToPath(new URL('../runtime/process-broker.mjs', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'agnes-broker-'))
const nativeFile = join(scratch, 'native.cjs')
const hooksFile = join(scratch, 'hooks.mjs')
writeFileSync(
  hooksFile,
  `import { registerHooks } from 'node:module'
const target = ${JSON.stringify(pathToFileURL(nativeFile).href)}
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === '@agnes/system-node/native'
      ? { url: target, format: 'commonjs', shortCircuit: true }
      : next(specifier, context),
})
`,
)
writeFileSync(
  nativeFile,
  `const { appendFileSync } = require('node:fs')
const log = (entry) => appendFileSync(process.env.AGNES_FAKE_LOG, JSON.stringify(entry) + '\\n')
const mode = process.env.AGNES_FAKE_MODE
const fault = (code) => Object.assign(new Error(code), { code })
const native = {
  abiVersion: 1,
  spawnInherited() {
    log({ call: 'spawnInherited' })
    throw fault('E_FAKE_DIRECT')
  },
}
if (mode === 'test-build') native.testFaults = true
if (mode !== 'missing')
  native.spawnRestricted = (...args) => {
    log({ call: 'spawnRestricted', args })
    if (mode === 'throws') throw fault('EACCES')
    let resumed = false
    let polls = 0
    return {
      pid: 77,
      startTime: '888',
      resume() {
        log({ call: 'resume' })
        if (mode === 'resume-throws') throw fault('EIO')
        resumed = true
      },
      exitCode: () => (resumed && ++polls > 2 ? 7 : null),
      close: () => log({ call: 'close', resumed }),
    }
  }
module.exports = native
`,
)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type Message = Record<string, unknown>
const live: ChildProcess[] = []
afterEach(() => {
  for (const child of live.splice(0)) if (child.exitCode === null) child.kill()
})

let runs = 0
function start(mode: string) {
  const log = join(scratch, `log-${++runs}.jsonl`)
  const child = fork(broker, [], {
    execArgv: ['--import', pathToFileURL(hooksFile).href],
    env: { PATH: process.env.PATH ?? '', AGNES_FAKE_LOG: log, AGNES_FAKE_MODE: mode },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  live.push(child)
  const messages: Message[] = []
  const waiters: Array<() => void> = []
  child.on('message', (message) => {
    messages.push(message as Message)
    for (const wake of waiters.splice(0)) wake()
  })
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  const next = async (): Promise<Message> => {
    while (messages.length === 0) await new Promise<void>((resolve) => waiters.push(resolve))
    return messages.shift() as Message
  }
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Message)
      : []
  return { child, next, exited, calls, messages }
}

const payload = () => ({
  type: 'run-restricted',
  application: 'C:\\tools\\tool.exe',
  commandLine: '"C:\\tools\\tool.exe" "中文 参数"',
  cwd: 'C:\\work',
  environment: 'A=1\0B=2\0\0',
  writeSids: ['S-1-4-1-2', 'S-1-4-3-4'],
  readOnly: false,
})

describe('process broker restricted launch', () => {
  it('creates the target suspended and resumes it only when told to', async () => {
    const run = start('ok')
    expect(await run.next()).toEqual({ type: 'ready', version: 1 })
    run.child.send(payload())
    expect(await run.next()).toEqual({ type: 'created', pid: 77, start: '888' })
    const sent = payload()
    expect(run.calls()).toEqual([
      {
        call: 'spawnRestricted',
        args: [sent.application, sent.commandLine, sent.cwd, sent.environment, sent.writeSids, sent.readOnly],
      },
    ])
    run.child.send({ type: 'resume' })
    expect(await run.next()).toEqual({ type: 'started', pid: 77 })
    expect(await run.next()).toEqual({ type: 'exit', code: 7, signal: null })
    expect((await run.exited)[0]).toBe(0)
    expect(run.calls().map(({ call }) => call)).toEqual(['spawnRestricted', 'resume', 'close'])
  })

  it.each([
    ['a missing restricted launch', 'missing', 'E_SYSTEM_NATIVE_UNAVAILABLE'],
    ['a test build of the native artifact', 'test-build', 'E_SYSTEM_NATIVE_UNAVAILABLE'],
    ['a refused launch', 'throws', 'EACCES'],
  ])('reports %s without any other launch', async (_name, mode, code) => {
    const run = start(mode)
    await run.next()
    run.child.send(payload())
    expect(await run.next()).toEqual({ type: 'error', code })
    expect((await run.exited)[0]).toBe(1)
    expect(run.calls().filter(({ call }) => call !== 'spawnRestricted')).toEqual([])
  })

  it('refuses a test build of the native artifact for a direct launch too', async () => {
    const run = start('test-build')
    await run.next()
    run.child.send({ type: 'run', argv: [process.execPath], cwd: scratch, env: {}, windowsBatch: 'script' })
    expect(await run.next()).toEqual({ type: 'error', code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
    expect(run.calls()).toEqual([])
  })

  it.each([
    ['no application', { application: '' }],
    ['a NUL in the command line', { commandLine: 'a\0b' }],
    ['no working directory', { cwd: undefined }],
    ['a non-string environment', { environment: ['A=1'] }],
    ['three write SIDs', { writeSids: ['S-1-4-1', 'S-1-4-2', 'S-1-4-3'] }],
    ['a non-string write SID', { writeSids: [1] }],
    ['a non-boolean mode', { readOnly: 'yes' }],
  ])('exits without launching on %s', async (_name, change) => {
    const run = start('ok')
    await run.next()
    run.child.send({ ...payload(), ...change })
    expect((await run.exited)[0]).toBe(1)
    expect(run.messages).toEqual([])
    expect(run.calls()).toEqual([])
  })

  it('discards the suspended target on anything but resume', async () => {
    const run = start('ok')
    await run.next()
    run.child.send(payload())
    await run.next()
    run.child.send({ type: 'run-restricted' })
    expect((await run.exited)[0]).toBe(1)
    expect(run.messages).toEqual([])
    expect(run.calls().slice(1)).toEqual([{ call: 'close', resumed: false }])
  })

  it('discards the suspended target when its Host goes away', async () => {
    const run = start('ok')
    await run.next()
    run.child.send(payload())
    await run.next()
    run.child.disconnect()
    expect((await run.exited)[0]).toBe(1)
    expect(run.calls().slice(1)).toEqual([{ call: 'close', resumed: false }])
  })

  it('discards the target and reports a failed resume', async () => {
    const run = start('resume-throws')
    await run.next()
    run.child.send(payload())
    await run.next()
    run.child.send({ type: 'resume' })
    expect(await run.next()).toEqual({ type: 'error', code: 'EIO' })
    expect((await run.exited)[0]).toBe(1)
    expect(run.calls().slice(1)).toEqual([{ call: 'resume' }, { call: 'close', resumed: false }])
  })
})
