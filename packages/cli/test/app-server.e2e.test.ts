import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { createConfigurationService, initializeHome } from '@agnes/host'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
it('embeds JSONL on the shared daemon, streams a turn, answers approval, and leaves daemon alive on EOF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-as-'))
  const distribution = join(root, 'distribution')
  const entry = join(distribution, 'agnes.mjs')
  const home = join(root, 'h'),
    cwd = join(root, 'w')
  await mkdir(cwd)
  initializeHome(home)
  const command = `node -e "process.stdout.write('AGH_STDIO_APPROVED')"`
  let sawApprovedOutput = false
  // Exercise the real model adapter and shell without depending on an account or a live model.
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
      messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>
      tools?: unknown[]
    }
    sawApprovedOutput ||= body.messages.some(
      (message) => message.role === 'tool' && JSON.stringify(message.content).includes('AGH_STDIO_APPROVED'),
    )
    const callShell = body.tools?.length && !body.messages.some((message) => message.tool_calls?.length)
    const delta = callShell
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'approved-shell',
              type: 'function',
              function: { name: 'shell', arguments: JSON.stringify({ command }) },
            },
          ],
        }
      : { role: 'assistant', content: 'Completed the app-server turn.' }
    const event = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    response.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: callShell ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
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
  const children: ChildProcessWithoutNullStreams[] = []
  const bridge = () => {
    const child = spawn(process.execPath, [entry, 'app-server', '--stdio', '--cwd', cwd], {
      env,
      cwd,
      stdio: 'pipe',
    })
    children.push(child)
    let serial = 0,
      stderr = ''
    const events: Record<string, any>[] = []
    const replies = new Map<
      number,
      { resolve: (v: any) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
    >()
    let approval = false
    child.stderr.on('data', (data) => {
      stderr += String(data)
    })
    const lines = createInterface({ input: child.stdout })
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n')
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'session/request_permission') {
        const option = message.params.options.find((o: { kind: string }) => o.kind === 'allow_once')
        if (!option) throw new Error('missing allow_once approval option')
        approval = true
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: option.optionId } },
        })
      } else if (message.method) events.push(message)
      else {
        const pending = replies.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          replies.delete(message.id)
          message.error ? pending.reject(message.error) : pending.resolve(message.result)
        }
      }
    })
    child.once('exit', () => {
      for (const pending of replies.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('bridge exited: ' + stderr))
      }
      replies.clear()
    })
    return {
      child,
      events,
      approved: () => approval,
      call: (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = ++serial
          const timer = setTimeout(() => {
            replies.delete(id)
            reject(new Error('timeout ' + method + ': ' + stderr))
          }, 40_000)
          replies.set(id, { resolve, reject, timer })
          send({ jsonrpc: '2.0', id, method, params })
        }),
      close: async () => {
        const exited = new Promise<void>((resolve, reject) => {
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error('bridge exit ' + code + ': ' + stderr)),
          )
        })
        child.stdin.end()
        await exited
        lines.close()
      },
    }
  }
  try {
    await exec(
      process.execPath,
      ['--import', 'tsx', resolve('packages/cli/tools/build-local.ts'), '--output-dir', distribution],
      { env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    )
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', resolve)
    })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('missing provider address')
    await createConfigurationService({ home, profile: 'local-dev' }).save({
      providerId: 'deepseek',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-app-server',
      model: 'deepseek-flash',
      expectedRevision: 0,
    })
    const first = bridge()
    const init = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { 'ai.agnes.harness': { capabilities: { permission: true } } },
      },
    }
    expect(await first.call('initialize', init)).toHaveProperty('protocolVersion', 1)
    const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
    await first.call('_agnes/v1/workspace.add', { path: cwd })
    const session = await first.call('session/new', { cwd, mcpServers: [] })
    expect(session.sessionId).toEqual(expect.any(String))
    expect(
      await first.call('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `call shell ${JSON.stringify({ command })}` }],
      }),
    ).toHaveProperty('stopReason', 'end_turn')
    expect(first.approved()).toBe(true)
    expect(sawApprovedOutput).toBe(true)
    expect(
      first.events.some(
        (event) =>
          event.method === 'session/update' && event.params.update.sessionUpdate === 'agent_message_chunk',
      ),
    ).toBe(true)
    expect(JSON.stringify(first.events)).toContain('AGH_STDIO_APPROVED')
    await first.close()
    const second = bridge()
    await second.call('initialize', init)
    expect(JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8')).pid).toBe(owner.pid)
    const list = await second.call('_agnes/v1/session.list', {})
    expect(list.items.some((item: { sessionId: string }) => item.sessionId === session.sessionId)).toBe(true)
    const signalled = new Promise<number | null>((done) => second.child.once('exit', done))
    second.child.kill('SIGTERM')
    expect(await signalled).toBe(143)
    expect((await cli(['daemon', 'status'])).stdout).toContain(String(owner.pid))
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await cli(['daemon', 'stop']).catch(() => undefined)
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
