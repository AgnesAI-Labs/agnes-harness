import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import { localSdkTransport } from './local-socket-path.js'

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 90_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

it('enables single and multiple client contributions and retains their roster after cold restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-client-restart-')))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  createPrivateDirectorySync(home)
  initializeHome(home, 'local-dev')
  const start = async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url)),
        home,
        workspace,
      ],
      {
        env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: home },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
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
    const close = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      try {
        expect(await deadline(exited, 'daemon shutdown')).toBe(0)
      } catch (error) {
        child.kill('SIGKILL')
        await exited
        throw error
      }
    }
    try {
      await deadline(ready, 'daemon startup')
      const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8')) as {
        socketPath: string
      }
      return { socketPath: owner.socketPath, close }
    } catch (error) {
      await close()
      throw error
    }
  }
  let daemon: Awaited<ReturnType<typeof start>> | undefined
  let client: ReturnType<typeof createClient> | undefined
  const connect = async () => {
    if (!daemon) throw new Error('daemon missing')
    const connected = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: localSdkTransport(daemon.socketPath),
      timeouts: { request: 90_000 },
    })
    await connected.initialize()
    await connected.workspace.add(workspace)
    return connected
  }
  try {
    daemon = await start()
    client = await connect()
    const admin = client.packages
    const command = async () => ({
      profile: 'local-dev',
      clientId: await client!.clientId(),
      commandId: randomUUID(),
    })
    const complete = async (receipt: PackageOperationReceipt) => {
      for (let attempt = 0; attempt < 900; attempt++) {
        const operation = await admin.operation.get({
          profile: 'local-dev',
          operationId: receipt.operationId,
        })
        if (['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)) {
          expect(operation.error, JSON.stringify(operation)).toBeUndefined()
          expect(operation.state).toBe('completed')
          return operation
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('package operation timed out')
    }
    for (const count of [1, 2]) {
      const name = `@acme/client-${count}`
      const directory = join(root, `client-${count}`)
      await mkdir(directory)
      const plugins = Array.from({ length: count }, (_, index) => ({
        apiRange: '^5.0.0',
        export: `panel${index}`,
        id: `ext:acme/client-${count}/panel${index}`,
        runtime: 'in-process',
      }))
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          license: 'MIT',
          type: 'module',
          exports: './index.mjs',
          agnes: {
            plugins,
            clientDescriptors: plugins.map((plugin, index) => ({
              rowId: plugin.id,
              path: `./panel${index}/agnes.client.json`,
            })),
          },
        }),
      )
      await writeFile(
        join(directory, 'index.mjs'),
        plugins.map((plugin) => `export const ${plugin.export} = { apply() {} };`).join('\n'),
      )
      for (let index = 0; index < count; index++) {
        const clientDirectory = join(directory, `panel${index}`)
        await mkdir(clientDirectory)
        await writeFile(join(clientDirectory, 'client.js'), 'export default { apply() {} };')
        await writeFile(
          join(clientDirectory, 'agnes.client.json'),
          JSON.stringify({
            client: { entry: './client.js', slots: ['workbench.panel'], services: [], projections: [] },
          }),
        )
      }
      const source = { type: 'file' as const, ref: `file:${directory}` }
      const preview = (await complete(await admin.inspect({ ...(await command()), source }))).preview
      if (!preview) throw new Error('preview missing')
      if (!preview.capabilityHash) throw new Error('capability hash missing')
      expect(preview.blockers).toEqual([])
      await complete(
        await admin.install({ ...(await command()), source, expectedIntegrity: preview.integrity }),
      )
      await complete(
        await admin.trust({
          ...(await command()),
          id: name,
          expectedIntegrity: preview.integrity,
          capabilityHash: preview.capabilityHash,
        }),
      )
      await complete(await admin.enable({ ...(await command()), id: name }))
    }
    const roster = (await client.clientModules.list('local-dev')).rows.filter((row) =>
      row.packageId?.startsWith('@acme/client-'),
    )
    expect(roster).toHaveLength(3)
    expect(roster.every((row) => row.phase === 'ready')).toBe(true)
    await client.close()
    client = undefined
    await daemon.close()
    daemon = undefined
    daemon = await start()
    client = await connect()
    await client.session.new({ cwd: workspace })
    expect(
      (await client.clientModules.list('local-dev')).rows.filter((row) =>
        row.packageId?.startsWith('@acme/client-'),
      ),
    ).toEqual(roster)
  } finally {
    await client?.close()
    await daemon?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 240_000)
