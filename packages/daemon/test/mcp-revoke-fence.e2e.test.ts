import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

const journalBoundary = vi.hoisted(() => ({
  afterFlush: undefined as ((path: string) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              await target.sync()
              if (typeof args[0] === 'string') await journalBoundary.afterFlush?.(args[0])
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

it('acknowledges a real worker downgrade only after fencing an in-flight MCP journal commit', async () => {
  vi.stubEnv('AGNES_FAKE_WORKER_PERMISSION', '1')
  vi.stubEnv('AGNES_FAKE_WORKER_MCP', '1')
  const root = await mkdtemp(join(tmpdir(), 'mcp-fence-'))
  const body = {
    name: 'local-dev',
    dataDir: root,
    seams: { principals: { provider: 'local' } },
    approvals: { mode: 'manual' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
    provider: {
      routes: [
        {
          route: 'faux',
          api: 'faux',
          baseUrl: 'https://invalid.test',
          models: [{ route: 'faux', id: 'faux-1' }],
        },
      ],
    },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  const profile = { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
  const profileFile = join(root, 'profile.json')
  await writeFile(profileFile, JSON.stringify(profile))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let paused = false
  journalBoundary.afterFlush = async (path) => {
    if (!path.endsWith('.tmp') || !path.includes('.mcp.json.')) return
    const pending = JSON.parse(await readFile(path, 'utf8'))
    if (!paused && pending.servers?.['revocation-probe']?.desired === 'enabled') {
      paused = true
      await held
    }
  }
  const tables = sqliteTables(join(root, 'daemon.sqlite'))
  const paths = daemonSocketPaths({ dataDir: root, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  const supervisor = await startSupervisor({
    config: {
      profileName: 'local-dev',
      dataDir: root,
      ...paths,
      limits: { ...DEFAULT_LIMITS, jobsTickMs: 60_000 },
    },
    profile,
    profileDir: join(root, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: root,
    jobTables: tables,
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', 'tsx'],
    workerEntry: fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url)),
  })
  const sdk = createClient({ journal: memoryJournal(), transport: localSdkTransport(supervisor.socketPath) })
  let prompting: Promise<unknown> | undefined
  try {
    const session = await sdk.session.new({ cwd: root })
    await session.setYolo(true)
    prompting = session.prompt('Run the synthetic MCP probe')
    // Keep a rejected prompt observed while the boundary wait is outstanding.
    void prompting.catch(() => undefined)
    await vi.waitUntil(() => paused, { timeout: 20_000 })
    expect(Number(await readFile(join(root, 'mcp-worker-pid'), 'utf8'))).not.toBe(process.pid)
    await session.setYolo(false)
    release()
    await prompting
    expect(paused).toBe(true)
    const journal = JSON.parse(
      await readFile(join(root, 'resource-control', 'mcp', 'local-dev.mcp.json'), 'utf8'),
    )
    expect(journal.servers['revocation-probe'].desired).toBe('disabled')
  } finally {
    release()
    journalBoundary.afterFlush = undefined
    await prompting?.catch(() => undefined)
    await sdk.close()
    await supervisor.close()
    await tables.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}, 60_000)
