import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { wake } from '../plugin/daemon.js'
import { hub, parseListen, startHub } from '../plugin/hub.js'
import type { Extension, ToolDef } from '../plugin/tools.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-plugin-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const occupy = async (port: number): Promise<Server> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mhs`, 'mhs.v1')
    ws.once('open', () => {
      ws.close()
      resolve(true)
    })
    ws.once('error', () => resolve(false))
  })

it('reads AGNES_HUB_LISTEN as host:port or a bare port on loopback', () => {
  expect(parseListen('0.0.0.0:4180')).toEqual({ host: '0.0.0.0', port: 4180 })
  expect(parseListen('4191')).toEqual({ host: '127.0.0.1', port: 4191 })
  expect(() => parseListen('host:port')).toThrow()
})

it('listens in the background, creates its data directory, and frees the port when the plugin unloads', async () => {
  const port = await freePort()
  const env = { AGNES_HUB_LISTEN: `127.0.0.1:${port}`, AGH_HOME: home }
  const disposers: (() => void | Promise<void>)[] = []
  const previous = { ...process.env }
  Object.assign(process.env, env)
  try {
    hub.apply({ effect: (execute) => disposers.push(execute()) })
  } finally {
    process.env = previous
  }
  expect((await stat(join(home, 'hub'))).isDirectory()).toBe(true)
  for (let i = 0; i < 50 && !(await accepts(port)); i++) await new Promise((r) => setTimeout(r, 20))
  expect(await accepts(port)).toBe(true)
  await disposers[0]?.()
  const again = await occupy(port)
  await new Promise<void>((resolve) => again.close(() => resolve()))
})

it('retries a busy port every second until it is free, then serves the standalone page beside the WebSockets', async () => {
  const port = await freePort()
  const blocker = await occupy(port)
  const page = join(home, 'page')
  await mkdir(page)
  await writeFile(join(page, 'page.js'), 'console.log(1)')
  await writeFile(join(page, 'page.css'), 'body{}')
  const lines: string[] = []
  const instance = startHub(
    { AGNES_HUB_LISTEN: `127.0.0.1:${port}`, AGH_HOME: home },
    (line) => lines.push(line),
    pathToFileURL(`${page}/`),
  )
  await new Promise((r) => setTimeout(r, 300))
  expect(lines.some((line) => line.includes('retrying'))).toBe(true)
  await new Promise<void>((resolve) => blocker.close(() => resolve()))
  await instance.ready
  expect(await accepts(port)).toBe(true)
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`)
  const shell = await get('/?theme=light')
  expect(shell.headers.get('content-type')).toMatch(/^text\/html/)
  expect(await shell.text()).toMatch(/<div id="app"><\/div>.*src="\/dist\/page\.js"/)
  const js = await get('/dist/page.js')
  expect([js.status, js.headers.get('content-type'), await js.text()]).toEqual([
    200,
    'text/javascript; charset=utf-8',
    'console.log(1)',
  ])
  const css = await get('/dist/page.css')
  expect([css.status, css.headers.get('content-type')]).toEqual([200, 'text/css; charset=utf-8'])
  expect((await get('/dist/hub.mjs')).status).toBe(404)
  expect((await get('/elsewhere')).status).toBe(404)
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/hub`)
  await new Promise((resolve, reject) => client.once('open', resolve).once('error', reject))
  client.close()
  await instance.stop()
})

it('registers the seven device tools and a context hook, and wakes sessions through the daemon socket', async () => {
  const port = await freePort()
  // A stand-in for the Agnes daemon: newline-delimited JSON-RPC on a Unix socket named in owner.json.
  const sock = join(home, 'd.sock')
  const received: { method: string; params: Record<string, unknown> }[] = []
  const daemon = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const msg = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        received.push(msg)
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'noise', params: {} })}\n`)
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => daemon.listen(sock, resolve))
  await mkdir(join(home, 'data', 'daemon'), { recursive: true })
  await writeFile(join(home, 'data', 'daemon', 'owner.json'), JSON.stringify({ socketPath: sock }))

  const tools = new Map<string, ToolDef>()
  let context: (() => Promise<{ additionalContext?: string }>) | undefined
  const extension: Extension = {
    registerTool: (def) => {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
    registerHook: (_event, handler) => {
      context = handler
      return () => {
        context = undefined
      }
    },
  }
  const disposers: (() => void | Promise<void>)[] = []
  const previous = { ...process.env }
  Object.assign(process.env, { AGNES_HUB_LISTEN: `127.0.0.1:${port}`, AGH_HOME: home })
  try {
    hub.apply({ effect: (execute) => disposers.push(execute()), extension: () => extension })
  } finally {
    process.env = previous
  }
  try {
    expect([...tools.keys()]).toEqual([
      'list_devices',
      'read_device',
      'call_device',
      'set_device',
      'stop_device',
      'watch_device',
      'unwatch_device',
    ])
    // Only read_device returns camera pictures, so only it declares them.
    expect([...tools.values()].filter((t) => t.meta.returnsImages).map((t) => t.name)).toEqual([
      'read_device',
    ])
    expect((await context?.())?.additionalContext).toMatch(/No devices are connected right now\.$/)
    const call = {
      signal: new AbortController().signal,
      session: { key: 's1', toolUseId: 'tu1' },
      artifacts: { put: async () => ({ sha256: '', size: 0, mime: '' }) },
    }
    const listed = await tools.get('list_devices')?.execute({}, call)
    expect(listed).toEqual({
      content: [{ type: 'text', text: 'No devices are connected to AgnesHub.' }],
      structured: { devices: [] },
    })

    await wake(home, 's1', 'robot-01: moved 1 m.')
    expect(received.map((m) => m.method)).toEqual(['initialize', '_agnes/v1/jobs.enqueue'])
    expect(received[1]?.params).toMatchObject({
      sessionKey: 's1',
      payload: { prompt: 'robot-01: moved 1 m.', delivery: 'steer' },
      schedule: { kind: 'once' },
    })
  } finally {
    for (const dispose of disposers) await dispose()
    await new Promise<void>((resolve) => daemon.close(() => resolve()))
  }
  expect(tools.size).toBe(0)
})
