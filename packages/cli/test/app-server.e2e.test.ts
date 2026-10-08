import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const entry = resolve('packages/cli/dist/local/agnes.mjs')
it('embeds JSONL on the shared daemon, streams a turn, answers approval, and leaves daemon alive on EOF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-as-'))
  const home = join(root, 'h'),
    cwd = join(root, 'w')
  await mkdir(cwd)
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
        prompt: [{ type: 'text', text: 'call shell {"command":"printf AGH_STDIO_APPROVED"}' }],
      }),
    ).toHaveProperty('stopReason', 'end_turn')
    expect(first.approved()).toBe(true)
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
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
