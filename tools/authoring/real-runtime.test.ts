import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ home: '', createClient: vi.fn(), execFile: vi.fn() }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => fixture.home,
}))
vi.mock('node:child_process', () => ({ execFile: fixture.execFile, spawn: vi.fn() }))
vi.mock('@agnes/sdk', () => ({ createClient: fixture.createClient, memoryJournal: () => ({}) }))

afterEach(async () => {
  if (fixture.home) await rm(fixture.home, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['pipe', 'unix'])(
  'binds the %s owner and isolates child homes without forwarding secrets',
  async (kind) => {
    fixture.home = await mkdtemp(join(tmpdir(), 'agh-eval-runtime-'))
    const client = { initialize: vi.fn(), workspace: { add: vi.fn() } }
    fixture.createClient.mockReturnValue(client)
    fixture.execFile.mockImplementation((_exe, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'ok', ''))
      return { stdin: { end() {} } }
    })
    vi.stubEnv('AGH_DEMO_API_KEY', 'synthetic-eval-secret')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const { realRuntime } = await import(new URL('./real-runtime.mjs', import.meta.url).href)
    const rt = await realRuntime('fixture', join(fixture.home, 'agh-real-eval', 'run'))
    const owner = {
      socketPath: kind === 'pipe' ? '\\\\.\\pipe\\agh-fixture' : '/tmp/agh-fixture.sock',
      pid: 1234,
      processStartId: 'synthetic-start',
    }
    await mkdir(join(rt.home, 'daemon'), { recursive: true })
    await writeFile(join(rt.home, 'daemon', 'owner.json'), JSON.stringify(owner))
    await rt.connect(false)
    expect(fixture.createClient.mock.calls[0]?.[0].transport).toEqual({
      kind: 'unix',
      path: owner.socketPath,
      ...(kind === 'pipe'
        ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
        : {}),
    })
    await rt.cli(['daemon', 'status'])
    // Command grammars differ: cwd scopes all commands without appending an unsupported flag.
    expect(fixture.execFile.mock.calls[0]?.[1].slice(1)).toEqual(['daemon', 'status'])
    const options = fixture.execFile.mock.calls[0]?.[2]
    expect(options.cwd).toBe(rt.workspace)
    expect(options.env).toMatchObject({ HOME: rt.root, USERPROFILE: rt.root, SystemRoot: 'C:\\Windows' })
    expect(options.env.TMP).toBe(options.env.TEMP)
    expect(options.env.TMPDIR).toBe(options.env.TEMP)
    expect(options.env.TEMP).toBe(join(rt.root, 'tmp'))
    expect(options.env).not.toHaveProperty('AGH_DEMO_API_KEY')
    expect(options.windowsHide).toBe(true)
  },
)
