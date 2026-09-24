import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { resolveDaemonScope } from '@agnes/daemon'
import {
  type ComputerUseDriverArchitecture,
  type ComputerUseDriverPlatform,
  defaultProcessIdentity,
  evaluateFixedComputerUsePlatformAdmission,
} from '@agnes/host'
import { appendRowAsOlderBuild, createTestHost } from '@agnes/host/testkit'
import { ResourceOperationFailure } from '@agnes/resource-control-cli'
import { JsonRpcError, TransportClosed } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import {
  agnesVersion,
  type MainIO,
  main,
  safeDaemonDisconnectLine,
  safeExpectedResourceRpcFailureLine,
  safeExpectedSessionRpcFailureLine,
  safeResourceFailureLine,
} from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { bootLocal } from '../src/boot/local.js'
import { say, stalledProvider, TEST_LOCK, testDeps } from './boot-host.js'

// The lazy runtime reports first-use preparation only where the pinned driver is admitted for this
// platform; everywhere else (Linux today) it reports the platform as unsupported instead.
const runtimeBlocker = evaluateFixedComputerUsePlatformAdmission(
  process.platform as ComputerUseDriverPlatform,
  process.arch as ComputerUseDriverArchitecture,
).allowed
  ? 'driver-not-prepared'
  : 'platform-unsupported'

const tmp: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-main-'))
  tmp.push(d)
  return d
}

function harness(
  dir: string,
  tty: { stdin?: boolean; stdout?: boolean } = {},
  // HOME too: without it the home resolver falls back to the real os.homedir() whenever it
  // ignores AGH_HOME, which is exactly what a broken resolver does.
  env: Record<string, string> = { AGH_HOME: dir, HOME: dir },
) {
  const stdout = Object.assign(new PassThrough(), { isTTY: tty.stdout ?? false })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const io: MainIO = {
    env,
    stdin: Object.assign(Readable.from([]), { isTTY: tty.stdin ?? true }),
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: () => undefined,
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir, script: [say('main says hi')] })).host,
  }
  return { io, boot, out: () => out, err: () => err }
}

describe('main', () => {
  it('renders expected resource failures without a bundle stack or absolute path', () => {
    const failure = new ResourceOperationFailure('skill-op-1', 'failed', {
      code: 'RESOURCE_RECONCILE_FAILED',
      message: 'Skill refresh was rejected safely',
    })
    expect(safeResourceFailureLine(failure)).toBe(
      'RESOURCE_RECONCILE_FAILED: Skill refresh was rejected safely operation skill-op-1',
    )
    expect(safeResourceFailureLine(new Error('/private/bundle/index.js'))).toBeUndefined()
  })

  it('keeps a rendered terminal resource failure safe without requiring another stderr line', () => {
    const failure = new ResourceOperationFailure(
      'mcp-op-1',
      'failed',
      { code: 'MCP_RECONCILE_FAILED', message: 'MCP lifecycle adapter failed safely' },
      true,
    )
    expect(safeResourceFailureLine(failure)).toBe(
      'MCP_RECONCILE_FAILED: MCP lifecycle adapter failed safely operation mcp-op-1',
    )
  })

  it('maps only expected resource JSON-RPC outcomes without trusting their message or data', () => {
    const shuttingDown = new JsonRpcError({
      code: -32600,
      message: 'INVALID_REQUEST /private/daemon.mjs secret=not-safe',
      data: { code: 'SHUTTING_DOWN', diagnostic: '/private/daemon.mjs secret=not-safe' },
    })
    expect(safeExpectedResourceRpcFailureLine(shuttingDown)).toBe(
      'DAEMON_SHUTTING_DOWN: local Daemon is shutting down; retry the command.',
    )
    expect(
      safeExpectedResourceRpcFailureLine({
        kind: 'json-rpc',
        code: -32011,
        data: { code: 'RESOURCE_OPERATION_TERMINAL', diagnostic: '/private/worker secret=not-safe' },
      }),
    ).toBe('RESOURCE_OPERATION_TERMINAL: resource operation has already reached a terminal state.')
    expect(
      safeExpectedResourceRpcFailureLine(
        new JsonRpcError({
          code: -32011,
          message: 'SEMANTIC_REJECTED /private/unknown.mjs',
          data: { code: 'MCP_NOT_FOUND' },
        }),
      ),
    ).toBeUndefined()
    expect(
      safeExpectedResourceRpcFailureLine({
        kind: 'json-rpc',
        code: -32600,
        data: { code: 'SHUTTING_DOWN' },
      }),
    ).toBe('DAEMON_SHUTTING_DOWN: local Daemon is shutting down; retry the command.')
  })

  // `-p --model <route>/<typo>` and a home with no account used to print the JSON-RPC name plus a
  // client-side stack, with nothing saying what to fix. Each now gets one fixed line; the server's
  // message and data are still never echoed.
  it('maps expected session refusals to one fixed line without trusting their message or data', () => {
    expect(
      safeExpectedSessionRpcFailureLine(
        new JsonRpcError({
          code: -32008,
          message: 'PRESET_SWITCH_REJECTED /private/daemon.mjs',
          data: { code: 'PRESET_SWITCH_REJECTED', reason: 'secret=not-safe' },
        }),
      ),
    ).toBe(
      'PRESET_SWITCH_REJECTED: the requested preset or model is not available in this profile; `agh doctor provider` lists the configured routes.',
    )
    expect(
      safeExpectedSessionRpcFailureLine({
        kind: 'json-rpc',
        code: -32011,
        data: { code: 'PROVIDER_UNCONFIGURED', reason: '/private/worker secret=not-safe' },
      }),
    ).toBe(
      'PROVIDER_UNCONFIGURED: no model provider is configured for this profile; run `agh config` to add one.',
    )
    expect(
      safeExpectedSessionRpcFailureLine({
        kind: 'json-rpc',
        code: -32011,
        data: { code: 'LEGACY_LEDGER_FORMAT', reason: 'legacy-ledger-format' },
      }),
    ).toBe(
      'LEGACY_LEDGER_FORMAT: this session was created by an older version and cannot be opened by this one; start a new session.',
    )
    expect(
      safeExpectedSessionRpcFailureLine({
        kind: 'json-rpc',
        code: -32011,
        data: { code: 'WORKSPACE_INVALID' },
      }),
    ).toBeUndefined()
    expect(
      safeExpectedSessionRpcFailureLine({ code: -32008, data: { code: 'PRESET_SWITCH_REJECTED' } }),
    ).toBeUndefined()
    expect(safeExpectedSessionRpcFailureLine(new Error('PRESET_SWITCH_REJECTED'))).toBeUndefined()
  })

  it('renders a daemon disconnect as one safe retry line without transport diagnostics', () => {
    const closed = new TransportClosed({ reason: 'error', stderrTail: 'secret=/private/worker.log' })
    expect(safeDaemonDisconnectLine(closed)).toBe(
      'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.',
    )
    expect(safeDaemonDisconnectLine({ kind: 'transport-closed' })).toBe(
      'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.',
    )
    expect(safeDaemonDisconnectLine(new Error('/private/bundle/index.js'))).toBeUndefined()
  })

  it('answers --version and --help without booting anything', async () => {
    const h = harness(scratch())
    expect(await main(['--version'], h.io, h.boot)).toBe(0)
    expect(h.out()).toMatch(/^agh 9\.9\.9 node \S+ protocol _agnes\/v1\n$/)
    const g = harness(scratch())
    expect(await main(['--help'], g.io, g.boot)).toBe(0)
    expect(g.out()).toContain('agh -p [prompt]')
  })

  it('dispatches doctor through the real command entry and writes its JSON once', async () => {
    const h = harness(scratch())
    expect(await main(['doctor', 'storage', '--json'], h.io, h.boot)).toBe(0)
    expect(JSON.parse(h.out())).toEqual([expect.objectContaining({ name: 'storage', status: 'ok' })])
    expect(h.err()).toBe('')
  })

  it('routes both computer-use read-only entry points through the authenticated daemon RPC', async () => {
    const lockedPackageMutations = {
      activationReady: false,
      recoveryReady: false,
      blockers: [
        'store-directory-unavailable',
        'mutation-engine-unavailable',
        'environment-unavailable',
        'publisher-keyring-unavailable',
        'safe-extraction-unavailable',
        'trusted-directory-handle-unavailable',
      ],
    }
    for (const argv of [
      ['computer-use', 'status', '--json'],
      ['doctor', 'computer-use', '--json'],
    ]) {
      const h = harness(scratch())
      expect(await main(argv, h.io, h.boot)).toBe(1)
      expect(JSON.parse(h.out())).toEqual(
        argv[0] === 'doctor'
          ? {
              schemaVersion: 1,
              status: 'blocked',
              admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
              checks: { state: 'not-run', reason: 'production-driver-admission-disabled' },
              lockedPackageMutations,
            }
          : {
              // The lazy computer-use runtime now reports its own not-yet-prepared availability
              // before falling back to the fixed P0 driver-lock admission the doctor path still uses.
              schemaVersion: 1,
              status: 'blocked',
              admission: { state: 'blocked', reason: 'runtime-unavailable' },
              runtime: { state: 'not-started', startAttempted: false },
              blockers: [runtimeBlocker],
              lockedPackageMutations,
            },
      )
      expect(h.err()).toBe('')
    }
  })

  it('rejects malformed computer-use lifecycle arguments before booting a daemon', async () => {
    for (const argv of [
      ['computer-use', 'status', '--continue'],
      ['computer-use', 'status', '--profile', 'other'],
      ['computer-use', 'status', '--raw'],
      ['computer-use', 'permissions', 'status', 'probe'],
      ['computer-use', 'permissions', 'status', '--include', 'binary'],
      ['doctor', 'computer-use', '--continue'],
      ['doctor', 'computer-use', '--profile', 'other'],
      ['doctor', 'computer-use', '--raw'],
    ]) {
      const h = harness(scratch())
      const createHostImpl = vi.fn(h.boot.createHostImpl)
      expect(await main(argv, h.io, { ...h.boot, createHostImpl })).toBe(2)
      expect(createHostImpl).not.toHaveBeenCalled()
    }
  })

  it.each([
    // A real install intentionally polls an asynchronous native operation; its start/poll
    // contract is tested in computer-use.test.ts. This integration test checks authenticated boot.
    ['computer-use', 'operation'],
    ['computer-use', 'permissions', 'grant'],
  ])('boots authenticated local control for %s %s %s', async (...argv) => {
    const h = harness(scratch())
    const createHostImpl = vi.fn(h.boot.createHostImpl)
    const code = await main(
      argv.filter((arg): arg is string => arg !== undefined),
      h.io,
      {
        ...h.boot,
        createHostImpl,
      },
    )
    expect([1, 2]).toContain(code)
    expect(createHostImpl).toHaveBeenCalledOnce()
  })

  it('routes permissions and filtered doctor through authenticated blocked RPCs', async () => {
    for (const argv of [
      ['computer-use', 'permissions', 'status', '--json'],
      ['doctor', 'computer-use', '--include', 'binary', '--skip', 'display', '--json'],
    ]) {
      const h = harness(scratch())
      const createHostImpl = vi.fn(h.boot.createHostImpl)
      expect(await main(argv, h.io, { ...h.boot, createHostImpl })).toBe(1)
      expect(JSON.parse(h.out())).toMatchObject({ admission: { state: 'blocked' } })
      expect(h.err()).toBe('')
      expect(createHostImpl).toHaveBeenCalledOnce()
    }
  })

  it('a flag the grammar does not know exits 2 and prints the usage', async () => {
    const h = harness(scratch())
    expect(await main(['--nope'], h.io, h.boot)).toBe(2)
    expect(h.err()).toContain('unknown flag --nope')
    expect(h.err()).toContain('agh -p [prompt]')
    expect(h.out()).toBe('')
  })

  it('does not echo a credential embedded in an unknown Computer Use flag', async () => {
    const h = harness(scratch())
    const secret = 'S3CR3T_MARKER'
    const createHostImpl = vi.fn(h.boot.createHostImpl)
    expect(
      await main(['doctor', 'computer-use', `--token=${secret}`], h.io, { ...h.boot, createHostImpl }),
    ).toBe(2)
    expect(h.err()).toContain('unknown flag --token')
    expect(h.err()).not.toContain(secret)
    expect(createHostImpl).not.toHaveBeenCalled()
  })

  it('runs a whole one-shot turn and returns its exit code', async () => {
    const dir = scratch()
    const h = harness(dir)
    expect(await main(['-p', 'hello'], h.io, h.boot)).toBe(0)
    expect(h.out()).toBe('main says hi\n')
  })

  it('a --model the profile does not carry ends in one fixed line, not a JSON-RPC stack', async () => {
    const dir = scratch()
    const h = harness(dir)
    expect(await main(['-p', '--model', 'primary=no-such-route/foo', 'hello'], h.io, h.boot)).toBe(1)
    expect(h.err()).toContain(
      'PRESET_SWITCH_REJECTED: the requested preset or model is not available in this profile',
    )
    expect(h.err()).not.toMatch(/^\s+at /m)
    expect(h.out()).toBe('')
  })

  // Design §8.3: nothing names a home, so the run must land under <HOME>/.agh and never create
  // <HOME>/.agnes, which may belong to another product. process.env is stubbed too, so a value the
  // developer's shell exports cannot stand in for the one the test withholds.
  it('a fresh environment with neither home variable boots under <HOME>/.agh and leaves .agnes alone', async () => {
    const dir = scratch()
    vi.stubEnv('AGH_HOME', undefined)
    vi.stubEnv('AGNES_HOME', undefined)
    vi.stubEnv('HOME', dir)
    const h = harness(dir, {}, { HOME: dir })
    const dataDirs: string[] = []
    const code = await main(['-p', 'hello'], h.io, {
      ...h.boot,
      createHostImpl: async (profile) => {
        dataDirs.push(profile.dataDir)
        return (await createTestHost({ dataDir: dir, script: [say('main says hi')] })).host
      },
    })
    expect(code, h.err()).toBe(0)
    expect(h.out()).toBe('main says hi\n')
    expect(dataDirs).toEqual([join(dir, '.agh', 'data')])
    expect(existsSync(join(dir, '.agh'))).toBe(true)
    expect(existsSync(join(dir, '.agnes'))).toBe(false)
  })

  // Legacy compatibility: AGNES_HOME alone still selects the home, and says once that it is
  // deprecated. No earlier test in this file resolves AGNES_HOME, and each test file gets its own
  // module graph, so this is the first legacy resolution and the once-per-module notice shows here.
  it('an environment with only the legacy AGNES_HOME still boots there and warns that it is deprecated', async () => {
    const dir = scratch()
    const legacy = join(dir, 'legacy')
    vi.stubEnv('AGH_HOME', undefined)
    vi.stubEnv('AGNES_HOME', undefined)
    vi.stubEnv('HOME', dir)
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const h = harness(dir, {}, { AGNES_HOME: legacy, HOME: dir })
    const dataDirs: string[] = []
    const code = await main(['-p', 'hello'], h.io, {
      ...h.boot,
      createHostImpl: async (profile) => {
        dataDirs.push(profile.dataDir)
        return (await createTestHost({ dataDir: dir, script: [say('main says hi')] })).host
      },
    })
    expect(code, h.err()).toBe(0)
    expect(h.out()).toBe('main says hi\n')
    expect(dataDirs).toEqual([join(legacy, 'data')])
    expect(existsSync(join(dir, '.agh'))).toBe(false)
    const notices = warn.mock.calls.filter(
      ([, options]) => (options as { code?: string })?.code === 'AGH_DEP_AGNES_HOME',
    )
    expect(notices).toEqual([
      [
        `AGNES_HOME is deprecated; set AGH_HOME instead (using ${legacy}).`,
        { type: 'DeprecationWarning', code: 'AGH_DEP_AGNES_HOME' },
      ],
    ])
  })

  // Not a TTY on either end is what makes the default form print rather than draw.
  it('a redirected stdout picks the print form even without -p', async () => {
    const dir = scratch()
    const h = harness(dir, { stdin: true, stdout: false })
    expect(await main(['hello'], h.io, h.boot)).toBe(0)
    expect(h.out()).toBe('main says hi\n')
  })

  // Explicit connection failures remain named refusals rather than falling back to a local daemon.
  it.each([[['-p', 'x', '--connect', 'unix:/tmp/s'], 'connect', 'connect handshake failed']])(
    '%j is refused or fails by name, with exit 2',
    async (argv, word, detail) => {
      const h = harness(scratch())
      expect(await main(argv as string[], h.io, h.boot)).toBe(2)
      expect(h.err()).toContain(word)
      expect(h.err()).toContain(detail)
    },
  )

  it('lists sessions through the SDK command surface', async () => {
    const h = harness(scratch())
    expect(await main(['sessions'], h.io, h.boot)).toBe(0)
    expect(h.out()).toBe('no sessions\n')
  })

  it('the default TTY form boots the real app, accepts keyboard input and restores raw mode', async () => {
    const h = harness(scratch(), { stdin: true, stdout: true })
    let raw = false
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(value: boolean) {
        raw = value
      },
    })
    h.io.stdin = input
    const signals = new EventEmitter()
    h.io.signals = signals
    const running = main([], h.io, h.boot)
    try {
      await vi.waitFor(() => expect(raw).toBe(true))
      input.write('keyboard from main')
      input.write('\r')
      await vi.waitFor(() => expect(h.out()).toContain('main says hi'))
      // Wait for the persisted terminal turn to reach the projected idle state before quitting.
      await new Promise((resolve) => setTimeout(resolve, 100))
      input.write('\x04')
      expect(await running, h.err()).toBe(0)
      expect(raw).toBe(false)
    } finally {
      signals.emit('SIGTERM')
      await running
      input.destroy()
    }
  })

  it('an OS signal ends idle TUI waiting and restores the terminal', async () => {
    const h = harness(scratch(), { stdin: true, stdout: true })
    let raw = false
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(value: boolean) {
        raw = value
      },
    })
    h.io.stdin = input
    const signals = new EventEmitter()
    h.io.signals = signals
    const running = main([], h.io, h.boot)
    await vi.waitFor(() => expect(raw).toBe(true))
    signals.emit('SIGTERM')
    expect(await running, h.err()).toBe(143)
    expect(raw).toBe(false)
    input.destroy()
  })

  it('a boot that fails comes back as its own exit code, not as a stack trace', async () => {
    const h = harness(scratch())
    const code = await main(['-p', 'x'], h.io, {
      ...h.boot,
      createHostImpl: async () => {
        throw new Error('assembly exploded')
      },
    })
    expect(code).toBe(2)
    expect(h.err()).toBe('host: assembly exploded\n')
  })

  // Proven by making the configured home unusable: a run that read it would fail, so a run that
  // succeeds read something else. Asserting on a temp directory's absence instead would race every
  // other test that makes one.
  it('--ephemeral runs in a home of its own rather than the configured one', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dir, 'profiles', 'local-dev', 'profile.yaml'), '  : not: yaml :\n', 'utf8')

    const configured = harness(dir)
    expect(await main(['-p', 'x'], configured.io, configured.boot)).toBe(2)
    expect(configured.err()).toContain('is not valid yaml')

    const ephemeral = harness(dir)
    expect(await main(['-p', 'x', '--ephemeral'], ephemeral.io, ephemeral.boot)).toBe(0)
    expect(ephemeral.out()).toBe('main says hi\n')
  })

  /**
   * `agnes resume <id>` end to end, over a ledger a dead process left mid-answer.
   *
   * This is the run the whole change is for. cli does not depend on core and never calls `resume()`;
   * it gets a sound session because `session/load` opens one, which is the only reason the turn
   * below runs at all. Without that wiring the transcript comes back and the next turn is refused
   * with `step already open`.
   */
  it('resumes a session a dead process left mid-inference and carries the conversation on', async () => {
    const dir = scratch()
    // The process that dies. Its host is torn down with the model call still outstanding, so what
    // stays on disk is a step nothing closed.
    const dead = await bootLocal(
      parseArgs([]),
      testDeps(dir, {
        createHostImpl: async () =>
          (await createTestHost({ dataDir: dir, provider: stalledProvider() })).host,
      }),
    )
    const killed = await dead.client.session.new({ cwd: dir })
    void killed.prompt([{ type: 'text', text: 'what is the launch code' }]).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 25))
    const sessionId = killed.id
    await dead.close()

    // A fresh process, reaching that ledger by the id a person would type.
    const h = harness(dir)
    expect(await main(['--resume', sessionId, '-p', 'go on then'], h.io, h.boot)).toBe(0)
    expect(h.out()).toBe('main says hi\n')
    expect(h.err()).toBe('')
  })

  it.each(['--resume', 'resume'])(
    'refuses %s of a session an older build wrote with one plain line',
    async (form) => {
      const dir = scratch()
      const first = await bootLocal(parseArgs([]), testDeps(dir))
      const made = await first.client.session.new({ cwd: dir })
      const sessionId = made.id
      await first.close()
      await appendRowAsOlderBuild(dir, sessionId, (last) => ({
        ...last,
        type: 'op.state',
        register: 'op.state',
        lane: 'main',
        data: null,
      }))
      const h = harness(dir)
      const argv =
        form === 'resume' ? ['resume', sessionId, '-p', 'go on'] : ['--resume', sessionId, '-p', 'go on']
      expect(await main(argv, h.io, h.boot)).not.toBe(0)
      expect(h.err()).toBe(
        'LEGACY_LEDGER_FORMAT: this session was created by an older version and cannot be opened by this one; start a new session.\n',
      )
    },
  )

  // `agnes daemon status` no longer reads a home variable itself; the daemon scope resolves it the
  // same way every other process does. Proven with a live owner record planted in one home only: the
  // status comes back running exactly when that home is the one addressed.
  describe('daemon status addresses the home the environment names', () => {
    async function plantLiveOwner(home: string): Promise<void> {
      const scope = await resolveDaemonScope({ home, env: { HOME: home }, allowMissingProfile: true })
      const identity = await defaultProcessIdentity(process.pid)
      if (identity.state !== 'alive')
        throw new Error(`cannot identify this process: ${JSON.stringify(identity)}`)
      mkdirSync(dirname(scope.ownerPath), { recursive: true })
      writeFileSync(
        scope.ownerPath,
        JSON.stringify({
          pid: process.pid,
          processStartId: identity.startId,
          generation: randomUUID(),
          startedAt: new Date().toISOString(),
          socketPath: join(home, 'absent.sock'),
        }),
      )
    }

    it.each([
      ['only AGH_HOME', (planted: string, _other: string) => ({ AGH_HOME: planted })],
      ['only the legacy AGNES_HOME', (planted: string, _other: string) => ({ AGNES_HOME: planted })],
      [
        'AGH_HOME over a different AGNES_HOME',
        (planted: string, other: string) => ({ AGH_HOME: planted, AGNES_HOME: other }),
      ],
    ])('with %s set', async (_name, envFor) => {
      const dir = scratch()
      const planted = join(dir, 'planted')
      const other = join(dir, 'other')
      await plantLiveOwner(planted)
      vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const h = harness(dir, {}, { ...envFor(planted, other), HOME: join(dir, 'os-home') })
      expect(await main(['daemon', 'status'], h.io, h.boot), h.err()).toBe(0)
      expect(JSON.parse(h.out())).toMatchObject({ running: true, owner: { pid: process.pid } })
    })

    it('reports not running for a home that holds no owner record', async () => {
      const dir = scratch()
      await plantLiveOwner(join(dir, 'planted'))
      const h = harness(dir, {}, { AGH_HOME: join(dir, 'other'), HOME: join(dir, 'os-home') })
      expect(await main(['daemon', 'status'], h.io, h.boot), h.err()).toBe(1)
      expect(JSON.parse(h.out())).toEqual({ running: false })
    })
  })

  it('reports the version off the manifest rather than a literal', () => {
    expect(agnesVersion()).toBe('0.0.0')
  })
})
