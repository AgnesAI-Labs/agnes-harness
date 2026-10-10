import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

// Same worker entry as supervisor.e2e.test.ts. AGNES_EXAMPLE_LOOP selects the example Host
// inside that entry; the supervisor profile file stays the faux profile those tests already hello with.
const fakeWorkerEntry = fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url))
const workerSpawnOpts = {
  workerExecPath: process.execPath,
  workerEntry: fakeWorkerEntry,
  workerExecArgv: ['--import', 'tsx'],
}
const processIdentity = async (pid: number) =>
  pid === process.pid
    ? ({ state: 'alive', startId: 'example-loop-e2e' } as const)
    : ({ state: 'dead' } as const)

const prompt = 'Read report.md and summarize the refund window using the selected loop.'
const reply = 'Refund window is 30 days.'

function buildProfile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    seams: { principals: '@agnes/base' },
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
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

function buildConfigFor(dir: string): DaemonConfig {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  return {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 20_000, jobsTickMs: 60_000 },
  }
}

async function runExample(kind: 'react' | 'dag'): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-ex-loop-'))
  const previous = process.env.AGNES_EXAMPLE_LOOP
  process.env.AGNES_EXAMPLE_LOOP = kind
  let sup: Awaited<ReturnType<typeof startSupervisor>> | undefined
  let sdk: ReturnType<typeof createClient> | undefined
  let tables: ReturnType<typeof sqliteTables> | undefined
  try {
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    tables = sqliteTables(join(dir, 'daemon.sqlite'))
    sup = await startSupervisor({
      config: buildConfigFor(dir),
      profile,
      profileDir: join(dir, 'profiles', 'local-dev'),
      profileFile,
      workspaceRoot: dir,
      jobTables: tables,
      processIdentity,
      ...workerSpawnOpts,
    })
    sdk = createClient({
      journal: memoryJournal(),
      transport: localSdkTransport(sup.socketPath),
    })
    const sessionKey = `example-${kind}-turn`
    const session = await sdk.session.new({
      cwd: dir,
      sessionKey,
      loop: { id: `example.${kind}`, version: '1.0.0' },
      preset: 'standard',
    })
    expect(session.id).toBe(sessionKey)
    const result = await session.prompt(prompt)
    let rendered = ''
    try {
      rendered = JSON.stringify((await session.projectUI()).nodes)
    } catch (error) {
      rendered = error instanceof Error ? error.message : String(error)
    }
    expect({ sessionId: session.id, result, rendered }).toMatchObject({
      sessionId: sessionKey,
      result: { reason: 'completed' },
    })
    expect(rendered).toContain(reply)
  } finally {
    await sdk?.close()
    await sup?.close()
    await tables?.close()
    rmSync(dir, { recursive: true, force: true })
    if (sup && process.platform !== 'win32') rmSync(dirname(sup.socketPath), { recursive: true, force: true })
    if (previous === undefined) delete process.env.AGNES_EXAMPLE_LOOP
    else process.env.AGNES_EXAMPLE_LOOP = previous
  }
}

it('completes a scripted ReAct example turn through daemon session/new and session/prompt', async () => {
  await runExample('react')
}, 90_000)

it('completes a scripted dynamic DAG example turn through daemon session/new and session/prompt', async () => {
  await runExample('dag')
}, 90_000)
