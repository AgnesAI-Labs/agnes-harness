import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

// Use an isolated AGH_HOME when learning. Local stdio is an owner-authenticated administrator.
const home = process.env.AGH_HOME
if (!home) throw new Error('Set AGH_HOME to an absolute isolated directory first')
const workspace = resolve(process.argv[2] ?? '.')
const executable = process.env.AGH_BIN ?? 'agh'
const child = spawn(
  executable,
  ['app-server', '--stdio', '--home', home, '--profile', 'local-dev', '--cwd', workspace],
  { stdio: ['pipe', 'pipe', 'inherit'] },
)
const pending = new Map()
let serial = 0
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'session/request_permission') {
    // Real integrations should display the request and ask their user; this teaching client declines.
    send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
  } else if (message.method) {
    process.stderr.write(JSON.stringify(message) + '\n')
  } else {
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  }
})
const ended = new Promise((done, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('stdio closed'))
    }
    pending.clear()
    lines.close()
    code === 0 ? done() : reject(new Error(`bridge exited ${code}`))
  })
})
void ended.catch(() => undefined)
function call(method, params) {
  const id = ++serial
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
try {
  await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      _meta: { 'ai.agnes.harness': { capabilities: { permission: true } } },
    },
  })
  await call('_agnes/v1/workspace.add', { path: workspace })
  const session = await call('session/new', { cwd: workspace, mcpServers: [] })
  await call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] })
} finally {
  child.stdin.end()
  await ended
}
