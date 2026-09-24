import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const lines = createInterface({ input: process.stdin })
let pending
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
process.stderr.write('echo-server up\n')
if (mode === 'kill') process.on('SIGTERM', () => process.stderr.write('SIGTERM observed\n'))
if (mode === 'term' || mode === 'kill') setInterval(() => {}, 1000)
lines.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') {
    process.stderr.write('shutdown observed\n')
    if (mode !== 'normal') return
    reply(m.id, {})
    process.exitCode = 0
    lines.close()
    process.stdin.destroy()
    return
  }
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentCapabilities: {} })
  if (m.method === 'length') return reply(m.id, m.params.length)
  if (m.method === 'killme') return process.kill(process.pid, 'SIGKILL')
  if (m.method === 'inherited-pipes') {
    const descendant = spawn(
      process.execPath,
      [
        '-e',
        `
      process.send('ready');
      process.on('disconnect', () => setTimeout(() => process.stderr.write('late inherited stderr\\n'), 10));
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(0), 5000);
    `,
      ],
      {
        // The test needs this descendant to survive the parent's exit and hold its pipes.
        detached: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    )
    descendant.once('message', () => {
      reply(m.id, { pid: descendant.pid })
      setTimeout(() => {
        process.stderr.write('parent exiting 3\n')
        process.exit(3)
      }, 30)
    })
    return
  }
  if (m.method === 'crash') {
    process.stderr.write('fatal: crash requested\n')
    process.exitCode = 3
    lines.close()
    process.stdin.destroy()
    return
  }
  if (m.method === 'bad') return process.stdout.write('{nope}\n')
  if (m.method === 'envelope') return process.stdout.write('{"jsonrpc":"2.0"}\n')
  if (m.method === 'utf8') return process.stdout.write(Buffer.from([0xff, 10]))
  if (m.method === 'partial') {
    // Exit after the truncated bytes drain. Ending process.stdout alone does not deliver
    // EOF to the parent on Windows while this process still holds its standard handles.
    process.stdout.write('{"jsonrpc":', () => {
      lines.close()
      process.stdin.destroy()
    })
    return
  }
  if (m.method === 'eof') {
    process.stdout.end()
    return
  }
  if (m.method === 'large') {
    const shell = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '' }).length
    return reply(m.id, 'x'.repeat(m.params.bytes - shell))
  }
  if (m.method === 'stderr') {
    process.stderr.write(`${'漢'.repeat(5000)}TAIL`)
    return reply(m.id, {})
  }
  if (m.method === 'hang') {
    pending = m.id
    return
  }
  if (m.method === 'session/cancel') {
    process.stderr.write('cancel observed\n')
    return reply(pending, { cancelled: true })
  }
  if (m.method === 'split') {
    const b = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '漢🌱' })}\n`)
    for (const v of b) {
      process.stdout.write(Buffer.from([v]))
      await new Promise((r) => setTimeout(r, 1))
    }
    return
  }
  reply(m.id, {
    echo: m.params,
    cwd: process.cwd(),
    env: process.env.AGNES_STDIO_TEST_VALUE,
    inherited: process.env.AGNES_STDIO_INHERITED,
  })
})
lines.on('close', () => {
  process.stderr.write('EOF observed\n')
  if (mode === 'eof') process.exitCode = 0
})
