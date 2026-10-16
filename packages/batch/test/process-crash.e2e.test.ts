import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initializeHome } from '@agnes/host'
import { createOwnedStore } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { Repository } from '../src/index.js'
import { id } from './fakes.js'
import { daemonEntry, daemonSocket, descendants, driverEntry, kill, launch } from './process-harness.js'

// guards-allow-platform: SIGKILL and ps exercise the maintained POSIX process gate.
it
  .skipIf(process.platform === 'win32')
  .each(['outbox', 'fence', 'accepted', 'terminal', 'settled', 'worker', 'daemon'] as const)(
  'retains billing and never redispatches accepted work after a real %s process boundary kill',
  async (stage) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-batch-kill-')))
    const children: ReturnType<typeof launch>[] = []
    const requests: string[] = []
    const authorization: (string | undefined)[] = []
    const block = ['accepted', 'worker', 'daemon'].includes(stage)
    const sockets = new Set<import('node:net').Socket>()
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(Buffer.concat(chunks).toString())
      authorization.push(request.headers.authorization)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
      if (block) return
      const event = { id: 'local-batch', object: 'chat.completion.chunk', created: 0, model: 'batch-script' }
      response.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
      )
    })
    provider.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('provider missing')
    let socketPath: string | undefined
    try {
      const home = join(root, 'home'),
        workspace = join(root, 'workspace')
      await mkdir(home, { mode: 0o700 })
      await mkdir(join(workspace, 'inputs'), { recursive: true })
      await mkdir(join(root, 'owned'))
      await writeFile(join(workspace, 'inputs/a.txt'), 'alpha')
      await writeFile(join(workspace, 'inputs/b.txt'), 'beta')
      initializeHome(home, 'local-dev')
      // The real OpenAI-compatible client requires a credential even for this loopback fixture.
      const secretDir = join(root, 'secrets')
      await mkdir(join(secretDir, 'fixture'), { recursive: true, mode: 0o700 })
      await writeFile(join(secretDir, 'fixture', 'model'), 'synthetic-batch-fixture', { mode: 0o600 })
      const baseUrl = `http://127.0.0.1:${address.port}/v1`
      await writeFile(
        join(home, 'profiles/local-dev/profile.yaml'),
        JSON.stringify({
          name: 'local-dev',
          computerUse: { enabled: false },
          adapters: { secrets: { kind: 'file', path: secretDir } },
          provider: {
            package: '@agnes/ai',
            catalog: { include: [] },
            routes: [
              {
                route: 'batch-local',
                api: 'openai-completions',
                baseUrl,
                credentialRef: 'secret://fixture/model',
                models: [
                  {
                    id: 'batch-script',
                    name: 'Batch fixture',
                    route: 'batch-local',
                    api: 'openai-completions',
                    baseUrl,
                    input: ['text'],
                    reasoning: false,
                    cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 100,
                    toolCallFormats: ['native'],
                    thinkingReplay: 'drop',
                    contract_id: null,
                  },
                ],
              },
            ],
          },
        }),
      )
      const startDaemon = async () => {
        const daemon = launch(daemonEntry, [home, workspace], { AGH_HOME: home })
        children.push(daemon)
        await vi.waitFor(() => expect(daemon.stderr(), daemon.stderr()).toContain('agnesd listening on '), {
          timeout: 90_000,
        })
        socketPath = await daemonSocket(root)
        return daemon
      }
      let daemon = await startDaemon()
      const driver = launch(driverEntry, [JSON.stringify({ root, socket: socketPath, stage })])
      children.push(driver)
      if (block)
        await vi.waitFor(
          () => expect(requests, `${driver.stderr()}\n${JSON.stringify(driver.messages)}`).toHaveLength(1),
          { timeout: 60_000 },
        )
      else
        await vi.waitFor(() => expect(driver.messages, driver.stderr()).toContainEqual({ stage }), {
          timeout: 60_000,
        })
      expect(authorization).toEqual(requests.map(() => 'Bearer synthetic-batch-fixture'))
      if (stage === 'daemon' || stage === 'worker') {
        const workers = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/u).map(Number))
          .filter(([, parent]) => parent === daemon.child.pid)
          .map(([pid]) => pid!)
        expect(workers.length).toBeGreaterThan(0)
        if (stage === 'daemon') {
          await kill(daemon.child)
          await vi.waitFor(
            () =>
              expect(
                workers.filter((pid) => {
                  try {
                    process.kill(pid, 0)
                    return true
                  } catch {
                    return false
                  }
                }),
              ).toEqual([]),
            { timeout: 15_000 },
          )
        } else for (const pid of workers) process.kill(pid, 'SIGKILL')
      }
      await kill(driver.child)
      if (stage === 'daemon') daemon = await startDaemon()
      const before = requests.length
      const recovered = launch(driverEntry, [JSON.stringify({ root, socket: socketPath, resume: true })])
      children.push(recovered)
      await vi.waitFor(
        () =>
          expect(
            recovered.messages.some((m) => m.stage === 'recovered'),
            recovered.stderr(),
          ).toBe(true),
        { timeout: 60_000 },
      )
      await recovered.exit
      const database = new DatabaseSync(join(root, 'batch.sqlite'))
      try {
        const repo = new Repository(createOwnedStore(database, 'batch'))
        const status = await repo.status(id)
        if (stage === 'terminal' || stage === 'settled') {
          expect(status).toMatchObject({ status: 'completed', successes: 2, reserved: 0 })
          expect(requests).toHaveLength(2)
          expect(await readFile(join(workspace, 'agh-batch', id, 'results.jsonl'), 'utf8')).toContain(
            '"status":"done"',
          )
        } else {
          expect(status).toMatchObject({ status: 'unknown', uncertain: 1, reserved: 0.5, settled: 0 })
          expect((await repo.page(id)).map((item) => item.state)).toEqual(['unknown', 'pending'])
          expect(requests).toHaveLength(before)
        }
        expect(status.spent + status.reserved).toBeLessThanOrEqual(status.spec.budget)
      } finally {
        database.close()
      }
    } finally {
      const owned = descendants(children.map(({ child }) => child))
      for (const child of children.reverse()) await kill(child.child)
      await vi.waitFor(
        () =>
          expect(
            owned.filter((pid) => {
              try {
                process.kill(pid, 0)
                return true
              } catch {
                return false
              }
            }),
          ).toEqual([]),
        { timeout: 15_000 },
      )
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      if (socketPath && !socketPath.startsWith(root))
        await rm(dirname(socketPath), { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  },
  240_000,
)
