import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import type { RuntimeAdminSnapshot } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
// The source-form worker transpiles the whole bundled-plugin graph (~1500 modules, node_modules
// included) through jiti with forceTranspile, so no cache applies. Measured on a cold home: boot ~9s,
// first session/new ~35s, reloadLocal ~20s. Every step needs headroom over the SDK's 30s default.
const STEP_MS = 120_000
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('isolated daemon deadline')), STEP_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function shutdown(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    expect(await bounded(exited)).toBe(0)
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

it('a fresh home does not evaluate repository plugins or other repository code until explicit workspace trust', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-clone-trust-')))
  const home = join(root, 'home'),
    workspace = join(root, 'repository')
  const source = join(workspace, '.agh', 'plugins', 'side-effect')
  mkdirSync(source, { recursive: true })
  initializeHome(home, 'local-dev')
  const marker = join(workspace, 'plugin-evaluated')
  const otherMarker = join(workspace, 'other-code-executed')
  const entry = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'evaluated'); export const main = { apply() {} };`
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'side-effect',
      version: '1.0.0',
      type: 'module',
      license: 'MIT',
      exports: './index.mjs',
      agnes: { plugins: [{ apiRange: '^5.0.0', export: 'main' }] },
    }),
  )
  writeFileSync(join(source, 'index.mjs'), entry)
  const script = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(otherMarker)}, 'executed')`)}`
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'repository', scripts: { postinstall: script, start: script } }),
  )
  mkdirSync(join(workspace, '.agh', 'skills', 'repo-code'), { recursive: true })
  writeFileSync(
    join(workspace, '.agh', 'skills', 'repo-code', 'SKILL.md'),
    '---\nname: repo-code\ndescription: synthetic skill\n---\nRun the helper only when requested.\n',
  )
  writeFileSync(
    join(workspace, '.agh', 'skills', 'repo-code', 'helper.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(otherMarker)}, 'skill')`,
  )
  writeFileSync(
    join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { repo: { command: 'sh', args: ['-c', script] } } }),
  )
  writeFileSync(
    join(workspace, '.agh', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: script }] }] } }),
  )
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, home, workspace], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  let stderr = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.includes('agnesd listening on ')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`daemon exited ${code}: ${stderr}`)))
  })
  let sdk: ReturnType<typeof createClient> | undefined
  try {
    await bounded(ready)
    const owner = JSON.parse(readFileSync(join(home, 'daemon', 'owner.json'), 'utf8'))
    sdk = createClient({
      journal: memoryJournal(),
      transport: { kind: 'unix', path: owner.socketPath },
      timeouts: { request: STEP_MS },
    })
    await sdk.initialize()
    await bounded(sdk.session.new({ cwd: workspace }))
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(otherMarker)).toBe(false)
    const client = sdk
    const runtime = () => client.call<RuntimeAdminSnapshot>('_agnes/v1/sessionSelection.runtime', {})
    expect((await runtime()).workspaceDeployments).toContainEqual(
      expect.objectContaining({ deployDir: workspace, pluginCount: 1, state: 'untrusted' }),
    )
    const offeredHash = (await runtime()).workspaceDeployments?.find(
      (item) => item.deployDir === workspace,
    )?.trustHash
    if (!offeredHash) throw new Error('repository trust offer has no hash')
    await sdk.packages.trustWorkspace({
      profile: 'local-dev',
      clientId: await sdk.clientId(),
      commandId: 'trust-local-repository',
      deployDir: workspace,
      expectedHash: offeredHash,
    })
    await sdk.call('_agnes/v1/sessionSelection.reloadLocal', {})
    await bounded(sdk.session.new({ cwd: workspace }))
    expect(existsSync(marker)).toBe(true)
    expect((await runtime()).workspaceDeployments).toContainEqual(
      expect.objectContaining({ deployDir: workspace, pluginCount: 1, state: 'trusted' }),
    )
  } finally {
    await sdk?.close()
    await shutdown(child, exited)
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)
