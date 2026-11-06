// Confined launches through the Windows Job gate on any OS: Windows path rules, the native binding
// and the broker process are replaced by fakes. process-restricted.e2e.test.ts runs the real
// restricted launch on Windows.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SpawnModule = typeof import('../src/process-spawn.js')
type Message = Record<string, unknown>
type Reply = (message: Message, broker: Broker) => void

const fake = vi.hoisted(() => ({
  loads: 0,
  jobs: 0,
  spawns: 0,
  job: undefined as unknown,
  broker: undefined as unknown,
  files: new Set<string>(),
}))

vi.mock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...win32, default: win32 }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const statSync = ((path: string, options?: never) =>
    fake.files.has(path) ? { isFile: () => true } : actual.statSync(path, options)) as typeof actual.statSync
  return { ...actual, statSync, default: { ...actual, statSync } }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => {
      fake.spawns++
      return fake.broker
    },
  }
})
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const binding = {
    abiVersion: 1,
    processStartTime: () => '133',
    environmentNamesEqual: (left: string, right: string) => left.toUpperCase() === right.toUpperCase(),
    createProcessJob: () => {
      fake.jobs++
      return fake.job
    },
  }
  const native = () =>
    new Proxy(binding, {
      get: (target, key) =>
        key in target ? target[key as keyof typeof target] : key === 'testFaults' ? undefined : () => {},
    })
  return {
    ...actual,
    createRequire: (url: string) => {
      const real = actual.createRequire(url)
      return Object.assign((id: string) => {
        if (id !== '@agnes/system-node/native') return real(id)
        fake.loads++
        return native()
      }, real)
    },
  }
})

class Broker extends EventEmitter {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly sent: Message[] = []
  killed = false
  constructor(private readonly reply: Reply) {
    super()
    setImmediate(() => {
      this.emit('spawn')
      this.emit('message', { type: 'ready', version: 1 })
    })
  }
  send(message: Message, done?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    setImmediate(() => {
      done?.(null)
      this.reply(message, this)
    })
    return true
  }
  answer(message: Message): void {
    setImmediate(() => this.emit('message', message))
  }
  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    setImmediate(() => {
      this.emit('exit', null, 'SIGKILL')
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null, 'SIGKILL')
    })
    return true
  }
}

function job(contains: () => boolean = () => true) {
  return {
    assign: vi.fn(),
    terminate: vi.fn(),
    activeProcessCount: vi.fn(() => 2),
    terminationComplete: vi.fn(() => true),
    close: vi.fn(),
    contains: vi.fn(contains),
  }
}
type FakeJob = ReturnType<typeof job>

/** Replies as a broker that creates the target, waits for resume, then reports `code`. */
const restricted =
  (code = 7): Reply =>
  (message, broker) => {
    if (message.type === 'run-restricted') broker.answer({ type: 'created', pid: 99, start: '555' })
    if (message.type === 'resume') {
      broker.answer({ type: 'started', pid: 99 })
      setTimeout(() => broker.answer({ type: 'exit', code, signal: null }), 5)
    }
  }
const direct: Reply = (message, broker) => {
  if (message.type !== 'run') return
  broker.answer({ type: 'started', pid: 98 })
  setTimeout(() => broker.answer({ type: 'exit', code: 7, signal: null }), 5)
}

const original = Object.getOwnPropertyDescriptor(process, 'platform')
async function load(platform: NodeJS.Platform): Promise<SpawnModule> {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await import('../src/process-spawn.js')
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

const tool = 'C:\\tools\\tool.exe'
const script = 'C:\\tools\\run.cmd'
const workspaceSid = 'S-1-4-1-2-3-4-5'
const tempSid = 'S-1-4-6-7-8-9-10'
const writable = {
  mode: 'workspace-write',
  root: 'C:\\work\\项目 一',
  writeSids: [workspaceSid, tempSid],
  tempRoot: 'C:\\Users\\me\\AppData\\Local\\AgnesHarness\\acl-temp\\v1\\lease-1',
} as const
const readOnly = { mode: 'read-only', root: 'C:\\work\\项目 一', writeSids: [] } as const
const options = () => ({
  cwd: 'C:\\work\\项目 一',
  nodeExecutable: 'C:\\node\\node.exe',
  env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', GATE: '值' },
})
const code = (expected: string) => expect.objectContaining({ code: expected })
const savedRoot = process.env.SystemRoot

let current: FakeJob
beforeEach(() => {
  process.env.SystemRoot = 'C:\\Windows'
  fake.files = new Set([tool, script])
  current = job()
  fake.job = current
})
afterEach(() => {
  if (savedRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = savedRoot
  fake.loads = 0
  fake.jobs = 0
  fake.spawns = 0
  fake.broker = undefined
})

function broker(reply: Reply): Broker {
  const value = new Broker(reply)
  fake.broker = value
  return value
}

describe('Windows confinement sealing', () => {
  it('seals a frozen copy of what a launch may use', async () => {
    const { sealWindowsConfinement } = await load('win32')
    const sealed = sealWindowsConfinement({ ...writable, writeSids: [...writable.writeSids] })
    expect(sealed).toEqual(writable)
    expect(Object.isFrozen(sealed)).toBe(true)
    expect(Object.isFrozen(sealed.writeSids)).toBe(true)
    expect(sealWindowsConfinement(readOnly)).toEqual(readOnly)
    const single = { mode: 'workspace-write', root: writable.root, writeSids: [workspaceSid] } as const
    expect(sealWindowsConfinement(single)).toEqual(single)
    expect(fake.loads).toBe(0)
  })

  it.each([
    ['an unknown mode', { ...writable, mode: 'full-access' }],
    ['a relative root', { ...writable, root: 'work' }],
    ['a drive-relative root', { ...writable, root: 'C:work' }],
    ['a UNC root', { ...writable, root: '\\\\server\\share\\work' }],
    ['a root with NUL', { ...writable, root: 'C:\\wo\0rk' }],
    ['write SIDs for read-only', { ...readOnly, writeSids: [workspaceSid] }],
    ['a temp root for read-only', { ...readOnly, tempRoot: writable.tempRoot }],
    ['no write SID for writing', { ...writable, writeSids: [], tempRoot: undefined }],
    ['a non-capability SID', { ...writable, writeSids: ['S-1-5-32-544', tempSid] }],
    ['Everyone as a write SID', { ...writable, writeSids: ['S-1-1-0', tempSid] }],
    ['a repeated SID', { ...writable, writeSids: [workspaceSid, workspaceSid] }],
    ['three SIDs', { ...writable, writeSids: [workspaceSid, tempSid, 'S-1-4-11'] }],
    ['a temp SID without its root', { ...writable, tempRoot: undefined }],
    ['a temp root without its SID', { ...writable, writeSids: [workspaceSid] }],
    ['a relative temp root', { ...writable, tempRoot: 'temp' }],
    ['a non-array SID list', { ...writable, writeSids: workspaceSid }],
    ['a non-object', 'workspace-write'],
  ])('refuses %s', async (_name, input) => {
    const { sealWindowsConfinement } = await load('win32')
    expect(() => sealWindowsConfinement(input as never)).toThrow(code('EINVAL'))
  })
})

describe('Windows confined launch', () => {
  it('rejects forged, copied and reused confinements before any native call', async () => {
    const spawn = await load('win32')
    const sealed = spawn.sealWindowsConfinement(writable)
    const forgeries = [
      { ...writable },
      JSON.parse(JSON.stringify(sealed)),
      structuredClone(sealed),
      { ...sealed },
      Object.create(sealed),
      new Proxy(sealed, {}),
      Object.freeze({ ...sealed }),
    ]
    for (const confinement of forgeries)
      await expect(
        spawn.startWindowsJobProcess([tool], { ...options(), confinement } as never),
      ).rejects.toMatchObject({ code: 'E_WINDOWS_CONFINEMENT_INVALID' })
    expect(fake.loads).toBe(0)
    expect(fake.jobs).toBe(0)
    expect(fake.spawns).toBe(0)

    broker(restricted())
    const child = await spawn.startWindowsJobProcess([tool], { ...options(), confinement: sealed })
    await child.completion
    await expect(
      spawn.startWindowsJobProcess([tool], { ...options(), confinement: sealed }),
    ).rejects.toMatchObject({ code: 'E_WINDOWS_CONFINEMENT_INVALID' })
    expect(fake.spawns).toBe(1)
  })

  it('does not accept a confinement sealed by another module instance', async () => {
    const other = await load('win32')
    const sealed = other.sealWindowsConfinement(readOnly)
    const spawn = await load('win32')
    await expect(
      spawn.startWindowsJobProcess([tool], { ...options(), confinement: sealed }),
    ).rejects.toMatchObject({ code: 'E_WINDOWS_CONFINEMENT_INVALID' })
    expect(fake.spawns).toBe(0)
  })

  it.each(['darwin', 'linux'] as const)('reports ENOSYS on %s without loading native code', async (os) => {
    const spawn = await load(os)
    const confinement = spawn.sealWindowsConfinement(writable)
    await expect(spawn.startWindowsJobProcess([tool], { ...options(), confinement })).rejects.toMatchObject({
      code: 'ENOSYS',
    })
    expect(fake.loads).toBe(0)
    expect(fake.spawns).toBe(0)
  })

  it('sends the resolved literal command, environment and write SIDs to the broker', async () => {
    const spawn = await load('win32')
    const gate = broker(restricted())
    const child = await spawn.startWindowsJobProcess([tool, 'a b', '中文', 'q"x', 'tail\\', ''], {
      ...options(),
      env: { ...options().env, Temp: 'C:\\shared-temp' },
      confinement: spawn.sealWindowsConfinement(writable),
    })
    expect(child.pid).toBe(99)
    expect(gate.sent[0]).toEqual({
      type: 'run-restricted',
      application: tool,
      commandLine: `"${tool}" "a b" "中文" "q\\"x" "tail\\\\" ""`,
      cwd: options().cwd,
      environment: [
        'GATE=值',
        'PATH=C:\\bin',
        'SystemRoot=C:\\Windows',
        `TEMP=${writable.tempRoot}`,
        `TMP=${writable.tempRoot}`,
      ]
        .map((entry) => `${entry}\0`)
        .join('')
        .concat('\0'),
      writeSids: [workspaceSid, tempSid],
      readOnly: false,
    })
    expect(current.assign).toHaveBeenCalledWith(4242, '133')
    expect(current.contains).toHaveBeenCalledWith(99, '555')
    expect(gate.sent.map((message) => message.type)).toEqual(['run-restricted', 'resume'])
    expect(current.assign.mock.invocationCallOrder[0]).toBeLessThan(
      current.contains.mock.invocationCallOrder[0] as number,
    )
    child.stdin.end()
    expect(await child.completion).toEqual({ code: 7, signal: null, cancelled: false, stoppedProcesses: 1 })
    expect(current.terminate).toHaveBeenCalled()
    expect(current.close).toHaveBeenCalled()
  })

  it('keeps the caller environment and no write SID for a read-only launch', async () => {
    const spawn = await load('win32')
    const gate = broker(restricted(0))
    const child = await spawn.startWindowsJobProcess([tool], {
      ...options(),
      env: { ...options().env, TEMP: 'C:\\caller-temp' },
      confinement: spawn.sealWindowsConfinement(readOnly),
    })
    expect(gate.sent[0]).toMatchObject({
      environment: 'GATE=值\0PATH=C:\\bin\0SystemRoot=C:\\Windows\0TEMP=C:\\caller-temp\0\0',
      writeSids: [],
      readOnly: true,
    })
    expect(await child.completion).toMatchObject({ code: 0, cancelled: false })
  })

  it('runs a batch file through cmd.exe with the verbatim command line', async () => {
    const spawn = await load('win32')
    const { windowsCommand } = await import('../runtime/windows-command.mjs')
    const gate = broker(restricted())
    const argv = [script, 'x y', '50%']
    const child = await spawn.startWindowsJobProcess(argv, {
      ...options(),
      confinement: spawn.sealWindowsConfinement(readOnly),
    })
    const command = windowsCommand(argv, options().cwd, options().env, 'script')
    expect(command.verbatim).toBe(true)
    expect(gate.sent[0]).toMatchObject({
      application: 'C:\\Windows\\System32\\cmd.exe',
      commandLine: command.argv.join(' '),
    })
    await child.completion
  })

  it('refuses a command it cannot resolve before creating a Job', async () => {
    const spawn = await load('win32')
    await expect(
      spawn.startWindowsJobProcess(['C:\\tools\\missing.exe'], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(readOnly),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fake.jobs).toBe(0)
    expect(fake.spawns).toBe(0)
  })

  it.each([
    ['reports it outside the Job', () => false, 'E_JOB_MEMBERSHIP'],
    [
      'cannot check it',
      () => {
        throw Object.assign(new Error('EIO: IsProcessInJob failed'), { code: 'EIO' })
      },
      'EIO',
    ],
  ])('never resumes the target when the owned Job %s', async (_name, contains, expected) => {
    const spawn = await load('win32')
    current = job(contains)
    fake.job = current
    const gate = broker(restricted())
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(writable),
      }),
    ).rejects.toMatchObject({ code: expected })
    expect(gate.sent.map((message) => message.type)).toEqual(['run-restricted'])
    expect(current.terminate).toHaveBeenCalled()
    expect(gate.killed).toBe(true)
    expect(current.close).toHaveBeenCalled()
  })

  it.each([
    ['a start before creation', { type: 'started', pid: 99 }],
    ['a creation without identity', { type: 'created', pid: 99 }],
    ['a creation with an invalid pid', { type: 'created', pid: 0, start: '555' }],
  ])('refuses %s', async (_name, reply) => {
    const spawn = await load('win32')
    const gate = broker((message, owner) => {
      if (message.type === 'run-restricted') owner.answer(reply)
    })
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(readOnly),
      }),
    ).rejects.toMatchObject({ code: 'EPROTO' })
    expect(gate.sent.map((message) => message.type)).toEqual(['run-restricted'])
    expect(current.contains).not.toHaveBeenCalled()
  })

  it('refuses a start for a different process than the one verified', async () => {
    const spawn = await load('win32')
    broker((message, owner) => {
      if (message.type === 'run-restricted') owner.answer({ type: 'created', pid: 99, start: '555' })
      if (message.type === 'resume') owner.answer({ type: 'started', pid: 100 })
    })
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(readOnly),
      }),
    ).rejects.toMatchObject({ code: 'EPROTO' })
  })

  it('passes a broker launch failure through without any other launch', async () => {
    const spawn = await load('win32')
    const gate = broker((message, owner) => {
      if (message.type === 'run-restricted') owner.answer({ type: 'error', code: 'EACCES' })
    })
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(writable),
      }),
    ).rejects.toMatchObject({ code: 'EACCES' })
    expect(gate.sent.map((message) => message.type)).toEqual(['run-restricted'])
    expect(fake.spawns).toBe(1)
  })

  it('does not resume a created target after cancellation', async () => {
    const spawn = await load('win32')
    const controller = new AbortController()
    const gate = broker((message, owner) => {
      if (message.type !== 'run-restricted') return
      controller.abort()
      owner.answer({ type: 'created', pid: 99, start: '555' })
    })
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        signal: controller.signal,
        confinement: spawn.sealWindowsConfinement(readOnly),
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(gate.sent.map((message) => message.type)).toEqual(['run-restricted'])
    expect(current.terminate).toHaveBeenCalled()
  })

  it('refuses a native artifact without Job membership checks before starting the broker', async () => {
    const spawn = await load('win32')
    const { contains: _absent, ...old } = job()
    fake.job = old
    broker(restricted())
    await expect(
      spawn.startWindowsJobProcess([tool], {
        ...options(),
        confinement: spawn.sealWindowsConfinement(readOnly),
      }),
    ).rejects.toMatchObject({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
    expect(old.close).toHaveBeenCalled()
    expect(fake.spawns).toBe(0)
  })

  it('leaves an unconfined launch on the direct broker protocol', async () => {
    const spawn = await load('win32')
    const gate = broker(direct)
    const child = await spawn.startWindowsJobProcess([tool, 'a b'], options())
    expect(child.pid).toBe(98)
    expect(gate.sent).toEqual([
      { type: 'run', argv: [tool, 'a b'], cwd: options().cwd, env: options().env, windowsBatch: 'script' },
    ])
    expect(await child.completion).toEqual({ code: 7, signal: null, cancelled: false, stoppedProcesses: 1 })
    expect(current.contains).not.toHaveBeenCalled()
  })
})
