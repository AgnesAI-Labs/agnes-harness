import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseOptions, replaceRuntime, selectSettings } from './dev.mjs'
import { loadDevEnvironment, saveDevEnvironment } from './dev-environment.mjs'
import { acquireLock, assertDaemonSelection, sameOwner } from './dev-lifecycle.mjs'
import { parseServeCommand, stopWeb } from './dev-process.mjs'

const settings = {
  port: 4189,
  home: '/test/agh home',
  profile: 'local-dev',
  dataDir: '/test/agh data',
  cwd: '/test/work space',
  node: '/test/node runtime/bin/node',
}
const entry = '/test/old runtime/agnes.mjs'
const command = `${settings.node} ${entry} serve --port ${settings.port} --home ${settings.home} --data-dir ${settings.dataDir} --cwd ${settings.cwd} --profile ${settings.profile}`
const existing = { ...settings, entry, command, pid: 12345, start: 'verified-start' }
const runtime = '/test/new runtime'
const owner = { pid: 12345, processStartId: 'daemon-start', generation: 'daemon-generation' }
const temporaryScopes: string[] = []

afterEach(async () => {
  await Promise.all(temporaryScopes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function isolatedScope() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-dev-unit-'))
  temporaryScopes.push(dataDir)
  const daemonDir = join(dataDir, 'daemon')
  await mkdir(daemonDir)
  return { selected: { ...settings, dataDir }, daemonDir }
}

function replacementPorts() {
  const events: string[] = []
  const child = { owned: true }
  return {
    events,
    child,
    build: vi.fn(async () => {
      events.push('build')
      return runtime
    }),
    inspect: vi.fn(async () => {
      events.push('inspect')
      return existing as typeof existing | null
    }),
    stopDaemon: vi.fn(async () => {
      events.push('daemon stop')
    }),
    stopWeb: vi.fn(async () => {
      events.push('web stop')
    }),
    listeners: vi.fn(async () => {
      events.push('port free')
      return [] as number[]
    }),
    start: vi.fn(async () => {
      events.push('start')
      return child
    }),
  }
}

function webPorts() {
  return {
    identity: vi.fn(async () => existing.start as string | null),
    command: vi.fn(async () => existing.command),
    kill: vi.fn(),
    wait: vi.fn(async () => undefined),
  }
}

describe('dev options and selected scope', () => {
  it('accepts separate argv values with spaces and defaults to port 4189', () => {
    expect(parseOptions([])).toEqual({ port: 4189 })
    expect(parseOptions(['--save-env'])).toEqual({ port: 4189, 'save-env': true })
    expect(parseOptions(['--home', settings.home, '--node', settings.node, '--check'])).toEqual({
      port: 4189,
      home: settings.home,
      node: settings.node,
      check: true,
    })
  })

  it.each([
    ['--unknown', 'value'],
    ['--home'],
    ['--home', '--check'],
    ['--home', '/first', '--home', '/second'],
    ['--port', '4189', '--port', '4189'],
    ['--check', '--check'],
    ['--save-env', '--save-env'],
    ['--check', '--save-env'],
    ['--save-env', '--check'],
    ['--port', '0'],
    ['--port', '65536'],
    ['--port', '4189.5'],
    ['--port', 'not-a-port'],
  ])('refuses malformed or repeated options: %j', (...args) => {
    expect(() => parseOptions(args)).toThrow()
  })

  it('prefers the verified listener scope over saved settings, retaining paths with spaces', () => {
    const selected = { ...settings, node: process.execPath }
    expect(selectSettings({ port: 4189 }, {}, { ...settings, home: '/stale/home' }, existing)).toEqual(
      selected,
    )
    expect(selectSettings({ port: 4189 }, {}, settings, null)).toEqual(selected)
  })

  it('uses explicit home for the default data directory and permits a new Node for the same scope', () => {
    expect(selectSettings({ port: 4189, home: '/new home' }, {}, settings, null)).toMatchObject({
      home: '/new home',
      dataDir: '/new home/data',
    })
    expect(selectSettings({ port: 4189 }, { AGH_DEV_NODE: '/env/bin/node' }, settings, existing)).toEqual({
      ...settings,
      node: '/env/bin/node',
    })
    expect(
      selectSettings(
        { port: 4189, node: '/new/bin/node' },
        { AGH_DEV_NODE: '/env/bin/node' },
        settings,
        existing,
      ),
    ).toEqual({
      ...settings,
      node: '/new/bin/node',
    })
  })

  it.each([
    { home: '/another/home' },
    { dataDir: '/another/data' },
    { cwd: '/another/workspace' },
    { profile: 'another-profile' },
  ])('refuses explicit scope mismatch before any stop: %j', (override) => {
    expect(() => selectSettings({ port: 4189, ...override }, {}, undefined, existing)).toThrow(
      /another AGH scope/,
    )
  })

  it.each([{ AGH_HOME: '/another/home' }, { AGNES_HOME: '/another/home' }, { AGNES_PROFILE: 'other' }])(
    'does not let environment defaults authorize replacing another scope: %j',
    (env) => {
      expect(() => selectSettings({ port: 4189 }, env, undefined, existing)).toThrow(/another AGH scope/)
    },
  )

  it.each([{ profile: '../other' }, { node: 'node' }])(
    'refuses invalid selected settings: %j',
    (override) => {
      expect(() => selectSettings({ port: 4189, ...override }, {}, settings, null)).toThrow()
    },
  )
})

describe('dev serve process recognition', () => {
  it('parses only the explicitly scoped Node serve shape, preserving spaces in every path', () => {
    expect(parseServeCommand(command, 4189)).toEqual({ ...settings, entry })
    expect(parseServeCommand(command.replace(' --profile local-dev', ''), 4189)).toEqual({
      ...settings,
      entry,
      profile: undefined,
    })
  })

  it.each([
    ['wrong port', command.replace('--port 4189', '--port 4190')],
    ['another application', command.replace('agnes.mjs', 'another-app.mjs')],
    ['another executable', command.replace(settings.node, '/usr/bin/python')],
    ['relative executable', command.replace(settings.node, 'node')],
    ['another subcommand', command.replace(' serve ', ' daemon ')],
    ['command merely mentioned in text', `/usr/bin/printf ${command}`],
    ['unknown option', `${command} --user-name alice`],
    ['repeated option', `${command} --cwd /another/workspace`],
    ['missing explicit home', command.replace(` --home ${settings.home}`, '')],
    ['relative home', command.replace(settings.home, 'relative-home')],
    ['relative data directory', command.replace(settings.dataDir, 'relative-data')],
    ['relative workspace', command.replace(settings.cwd, 'relative-workspace')],
    ['invalid profile', command.replace('--profile local-dev', '--profile ../other')],
    ['embedded newline', command.replace(settings.cwd, '/test/work\nspace')],
    ['trailing flag without a value', `${command.replace(' --profile local-dev', '')} --help`],
  ])('refuses %s instead of matching a process name or command substring', (_reason, candidate) => {
    expect(parseServeCommand(candidate, 4189)).toBeUndefined()
  })
})

describe('dev runtime replacement', () => {
  it('builds, revalidates, stops daemon and Web, checks the port, then starts the new runtime', async () => {
    const ports = replacementPorts()
    await expect(replaceRuntime(settings, existing, ports)).resolves.toEqual({ runtime, child: ports.child })
    expect(ports.events).toEqual(['build', 'inspect', 'daemon stop', 'web stop', 'port free', 'start'])
    expect(ports.build).toHaveBeenCalledWith(settings)
    expect(ports.inspect).toHaveBeenCalledWith(settings.port)
    expect(ports.stopDaemon).toHaveBeenCalledWith(dirname(entry), settings)
    expect(ports.stopWeb).toHaveBeenCalledWith(existing)
    expect(ports.listeners).toHaveBeenCalledWith(settings.port)
    expect(ports.start).toHaveBeenCalledWith(runtime, settings)
  })

  it('uses the new runtime control command to stop a daemon even without an existing Web listener', async () => {
    const ports = replacementPorts()
    ports.inspect.mockResolvedValue(null)
    await replaceRuntime(settings, null, ports)
    expect(ports.stopDaemon).toHaveBeenCalledWith(runtime, settings)
    expect(ports.stopWeb).not.toHaveBeenCalled()
    expect(ports.start).toHaveBeenCalledWith(runtime, settings)
  })

  it('does not inspect or stop the running service when the build fails', async () => {
    const ports = replacementPorts()
    ports.build.mockRejectedValue(new Error('build failed'))
    await expect(replaceRuntime(settings, existing, ports)).rejects.toThrow('build failed')
    expect(ports.inspect).not.toHaveBeenCalled()
    expect(ports.stopDaemon).not.toHaveBeenCalled()
    expect(ports.stopWeb).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it.each([
    ['listener disappeared', null],
    ['PID changed', { ...existing, pid: 54321 }],
    ['PID reused', { ...existing, start: 'another-start' }],
    ['command changed', { ...existing, command: `${command} --unexpected value` }],
  ])('stops nothing when the %s during the build', async (_reason, current) => {
    const ports = replacementPorts()
    ports.inspect.mockResolvedValue(current)
    await expect(replaceRuntime(settings, existing, ports)).rejects.toThrow(/changed during build/)
    expect(ports.stopDaemon).not.toHaveBeenCalled()
    expect(ports.stopWeb).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('stops nothing when a listener appeared during the build or inspection cannot verify its owner', async () => {
    const ports = replacementPorts()
    await expect(replaceRuntime(settings, null, ports)).rejects.toThrow(/changed during build/)
    ports.inspect.mockRejectedValue(new Error('unknown port owner'))
    await expect(replaceRuntime(settings, existing, ports)).rejects.toThrow('unknown port owner')
    expect(ports.stopDaemon).not.toHaveBeenCalled()
    expect(ports.stopWeb).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it.each(['stopDaemon', 'stopWeb'] as const)('does not proceed after %s refuses', async (phase) => {
    const ports = replacementPorts()
    ports[phase].mockRejectedValue(new Error('shutdown refused'))
    await expect(replaceRuntime(settings, existing, ports)).rejects.toThrow('shutdown refused')
    if (phase === 'stopDaemon') expect(ports.stopWeb).not.toHaveBeenCalled()
    expect(ports.listeners).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('does not start if a port owner remains or appears after shutdown', async () => {
    const ports = replacementPorts()
    ports.listeners.mockResolvedValue([54321])
    await expect(replaceRuntime(settings, existing, ports)).rejects.toThrow(/still occupied/)
    expect(ports.start).not.toHaveBeenCalled()
  })
})

describe('dev Web shutdown identity boundary', () => {
  it.each(['start', 'command', 'unknown'] as const)(
    'refuses to signal when %s identity differs',
    async (kind) => {
      const ports = webPorts()
      if (kind === 'start') ports.identity.mockResolvedValue('reused-pid-start')
      if (kind === 'command') ports.command.mockResolvedValue('/usr/bin/node /another/application.mjs')
      if (kind === 'unknown') ports.identity.mockRejectedValue(new Error('identity unavailable'))
      await expect(stopWeb(existing, ports)).rejects.toThrow()
      expect(ports.kill).not.toHaveBeenCalled()
      expect(ports.wait).not.toHaveBeenCalled()
    },
  )

  it('does nothing when the process has already exited', async () => {
    const ports = webPorts()
    ports.identity.mockResolvedValue(null)
    await stopWeb(existing, ports)
    expect(ports.kill).not.toHaveBeenCalled()
    expect(ports.command).not.toHaveBeenCalled()
  })

  it.each([null, 'reused-pid-start'])(
    'sends one TERM to the exact positive PID and accepts exit: %s',
    async (end) => {
      const ports = webPorts()
      ports.identity
        .mockResolvedValueOnce(existing.start)
        .mockResolvedValueOnce(existing.start)
        .mockResolvedValue(end)
      await stopWeb(existing, ports)
      expect(ports.kill.mock.calls).toEqual([[existing.pid, 'SIGTERM']])
      expect(ports.identity).toHaveBeenCalledWith(existing.pid, dirname(existing.entry))
      expect(ports.command).toHaveBeenCalledWith(existing.pid)
    },
  )

  it('rejects a shutdown timeout without sending another signal or killing a process group', async () => {
    const ports = webPorts()
    await expect(stopWeb(existing, ports)).rejects.toThrow(/timed out/)
    expect(ports.kill.mock.calls).toEqual([[existing.pid, 'SIGTERM']])
    expect(ports.wait).toHaveBeenCalled()
  })

  it('propagates signal denial rather than escalating', async () => {
    const ports = webPorts()
    ports.kill.mockImplementation(() => {
      throw Object.assign(new Error('signal denied'), { code: 'EPERM' })
    })
    await expect(stopWeb(existing, ports)).rejects.toThrow('signal denied')
    expect(ports.kill.mock.calls).toEqual([[existing.pid, 'SIGTERM']])
    expect(ports.wait).not.toHaveBeenCalled()
  })
})

describe('dev daemon transition ownership', () => {
  it('refuses a second owner of the same filesystem lock and permits reacquisition after release', async () => {
    const { daemonDir } = await isolatedScope()
    const path = join(daemonDir, 'dev-launch.lock')
    const release = await acquireLock(path)
    const original = await readFile(join(path, 'owner.json'), 'utf8')
    await expect(acquireLock(path)).rejects.toThrow(/Another dev transition/)
    expect(await readFile(join(path, 'owner.json'), 'utf8')).toBe(original)
    await release()
    const releaseAgain = await acquireLock(path)
    await releaseAgain()
    await expect(readFile(join(path, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    [undefined, undefined, true],
    [null, undefined, true],
    [owner, undefined, false],
    [undefined, owner, false],
    [owner, { ...owner }, true],
    [owner, { ...owner, pid: 54321 }, false],
    [owner, { ...owner, processStartId: 'reused-pid-start' }, false],
    [owner, { ...owner, generation: 'replacement-generation' }, false],
  ])('compares absence and the full owner generation: %j / %j', (left, right, equal) => {
    expect(sameOwner(left, right)).toBe(equal)
  })

  it('accepts no daemon, or a matching owner, profile and exact Web origin', async () => {
    const { selected, daemonDir } = await isolatedScope()
    await expect(assertDaemonSelection(selected, undefined)).resolves.toBeUndefined()
    await writeFile(join(daemonDir, 'owner.json'), JSON.stringify(owner))
    await writeFile(
      join(daemonDir, 'discovery.json'),
      JSON.stringify({ owner, profile: selected.profile, web: { origin: 'http://127.0.0.1:4189' } }),
    )
    await expect(assertDaemonSelection(selected, owner)).resolves.toBeUndefined()
  })

  it.each(['replaced', 'disappeared', 'appeared'] as const)(
    'refuses when the daemon owner %s after selection',
    async (change) => {
      const { selected, daemonDir } = await isolatedScope()
      if (change !== 'disappeared')
        await writeFile(
          join(daemonDir, 'owner.json'),
          JSON.stringify({ ...owner, generation: 'replacement-generation' }),
        )
      await expect(
        assertDaemonSelection(selected, change === 'appeared' ? undefined : owner),
      ).rejects.toThrow(/owner changed/)
    },
  )

  it.each(['missing discovery', 'other owner', 'other profile', 'other port', 'missing Web'] as const)(
    'refuses matching owner data with %s',
    async (mismatch) => {
      const { selected, daemonDir } = await isolatedScope()
      await writeFile(join(daemonDir, 'owner.json'), JSON.stringify(owner))
      if (mismatch !== 'missing discovery')
        await writeFile(
          join(daemonDir, 'discovery.json'),
          JSON.stringify({
            owner: mismatch === 'other owner' ? { ...owner, generation: 'another-generation' } : owner,
            profile: mismatch === 'other profile' ? 'another-profile' : selected.profile,
            ...(mismatch === 'missing Web'
              ? {}
              : { web: { origin: `http://127.0.0.1:${mismatch === 'other port' ? 4190 : 4189}` } }),
          }),
        )
      await expect(assertDaemonSelection(selected, owner)).rejects.toThrow(/not ready for this profile/)
    },
  )
})

describe('dev private environment', () => {
  it('round-trips only Jev settings into a 0600 file and keeps shell values authoritative', async () => {
    const { selected } = await isolatedScope()
    const home = join(selected.dataDir, 'private home')
    const allowed = {
      AGNES_JEV_API_KEY: 'unit-test-fake-jev-key',
      AGNES_JEV_BASE_URL: 'https://example.invalid/jev?label=test value#fragment',
      TYPESAFE_API_KEY: 'unit-test-fake-typesafe-key',
    }
    const path = await saveDevEnvironment(home, {
      ...allowed,
      AGNES_JEV_EMPTY: '',
      OPENAI_API_KEY: 'unit-test-unrelated-key',
      PATH: '/do-not-save/bin',
      AGH_HOME: '/do-not-save/home',
    })
    expect(path).toBe(join(home, 'dev.env'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(parseEnv(await readFile(path, 'utf8'))).toEqual(allowed)
    expect(await loadDevEnvironment(home, {})).toEqual(allowed)
    const shell = { AGNES_JEV_API_KEY: 'unit-test-shell-key', PATH: '/shell/bin' }
    expect(await loadDevEnvironment(home, shell)).toEqual({ ...allowed, ...shell })
    expect(shell).toEqual({ AGNES_JEV_API_KEY: 'unit-test-shell-key', PATH: '/shell/bin' })
  })

  it('refuses to overwrite an existing file and leaves its bytes unchanged', async () => {
    const { selected } = await isolatedScope()
    const path = await saveDevEnvironment(selected.dataDir, { TYPESAFE_API_KEY: 'unit-test-original' })
    const original = await readFile(path, 'utf8')
    await expect(
      saveDevEnvironment(selected.dataDir, { TYPESAFE_API_KEY: 'unit-test-replacement' }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses group-readable stored settings', async () => {
    const { selected } = await isolatedScope()
    const path = await saveDevEnvironment(selected.dataDir, { TYPESAFE_API_KEY: 'unit-test-fake-key' })
    await chmod(path, 0o640)
    await expect(loadDevEnvironment(selected.dataDir, {})).rejects.toThrow(/owner-only regular file/)
  })

  it('refuses even a private file containing a non-whitelisted variable', async () => {
    const { selected } = await isolatedScope()
    await writeFile(
      join(selected.dataDir, 'dev.env'),
      'TYPESAFE_API_KEY="unit-test-fake-key"\nPATH="/untrusted/bin"\n',
      { mode: 0o600 },
    )
    await expect(loadDevEnvironment(selected.dataDir, { PATH: '/shell/bin' })).rejects.toThrow(
      /accepts only AGNES_JEV_\*/,
    )
  })

  it('leaves the supplied environment unchanged when no dev.env exists', async () => {
    const { selected } = await isolatedScope()
    const env = { PATH: '/shell/bin', TYPESAFE_API_KEY: 'unit-test-shell-only' }
    const result = await loadDevEnvironment(selected.dataDir, env)
    expect(result).toEqual(env)
    expect(result).not.toBe(env)
    await expect(readFile(join(selected.dataDir, 'dev.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
