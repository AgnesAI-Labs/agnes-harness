import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { createConfigurationService, initializeHome } from '@agnes/host'
import { expect, it, vi } from 'vitest'

const exec = promisify(execFile)

// A real built `agh`, a real daemon in an isolated home and a loopback provider. The provider holds
// the first model request open, so `agh queue` from a separate process lands while a turn is running.
it('agh queue from another process runs after the current turn ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-queue-'))
  const distribution = join(root, 'distribution')
  const entry = join(distribution, 'agnes.mjs')
  const home = join(root, 'h')
  const cwd = join(root, 'w')
  await mkdir(cwd)
  initializeHome(home)
  const prompts: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((done) => {
    release = done
  })
  const provider = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string
      messages: Array<{ role: string; content?: unknown }>
    }
    prompts.push(JSON.stringify(body.messages.filter((m) => m.role === 'user').map((m) => m.content)))
    if (prompts.length === 1) await gate
    const event = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`,
    )
    response.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    TMPDIR: tmpdir(),
  }
  const cli = (args: string[]) =>
    exec(process.execPath, [entry, ...args], { env, cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  let bridge: ChildProcessWithoutNullStreams | undefined
  try {
    await exec(
      process.execPath,
      ['--import', 'tsx', resolve('packages/cli/tools/build-local.ts'), '--output-dir', distribution],
      { env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    )
    await new Promise<void>((done, fail) => {
      provider.once('error', fail)
      provider.listen(0, '127.0.0.1', done)
    })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('missing provider address')
    await createConfigurationService({ home, profile: 'local-dev' }).save({
      providerId: 'deepseek',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-queue',
      model: 'deepseek-flash',
      expectedRevision: 0,
    })
    // The ACP bridge is the session's owner: it starts the daemon, makes the session and runs turn one.
    const child = spawn(process.execPath, [entry, 'app-server', '--stdio', '--cwd', cwd], {
      env,
      cwd,
      stdio: 'pipe',
    })
    bridge = child
    const replies = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === undefined) replies.get(message.id)?.(message)
    })
    let serial = 0
    const call = (method: string, params: unknown) =>
      new Promise<unknown>((done, fail) => {
        const id = ++serial
        replies.set(id, (m) => (m.error ? fail(m.error) : done(m.result)))
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { 'ai.agnes.harness': { capabilities: { permission: true } } },
      },
    })
    await call('_agnes/v1/workspace.add', { path: cwd })
    const session = (await call('session/new', { cwd, mcpServers: [] })) as { sessionId: string }
    const turn = call('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first message' }],
    })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 30_000 })

    const queued = await cli(['queue', session.sessionId, 'second message from another shell'])
    expect(queued.stdout).toMatch(/^queued followUp \(seq \d+\)\n$/)
    // The turn is still held open, so the follow-up has not been run yet.
    expect(prompts).toHaveLength(1)

    release()
    await turn
    await vi.waitFor(
      () => expect(prompts.some((p) => p.includes('second message from another shell'))).toBe(true),
      { timeout: 30_000 },
    )
  } finally {
    release()
    if (bridge && bridge.exitCode === null) bridge.kill('SIGKILL')
    await cli(['daemon', 'stop']).catch(() => undefined)
    provider.closeAllConnections()
    await new Promise<void>((done) => provider.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
