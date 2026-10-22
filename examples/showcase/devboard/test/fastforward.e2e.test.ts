import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { UNIT_TOTAL } from '../fastforward.mjs'

// The shipped sample project is a real app: its tests pass and its server answers over TCP.
const ROOT = fileURLToPath(new URL('../assets/fastforward/', import.meta.url))
// biome-ignore lint/suspicious/noExplicitAny: the handle's fd is not in the public types
type Any = any
const clean = () => {
  const env = { ...process.env }
  delete env.AGH_LOOPBACK_FD
  delete env.AGH_LOOPBACK_URL
  return env
}

const children: ChildProcess[] = []
const servers: Server[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const server of servers.splice(0)) server.close()
})

/** The first stdout line of a started server: the URL it announces. */
const announced = (child: ChildProcess) =>
  new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.includes('\n')) resolve(out.trim())
    })
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)))
  })

describe('the shipped sample project', () => {
  it('passes its own unit tests', () => {
    const run = spawnSync(process.execPath, ['--test'], { cwd: ROOT, env: clean(), encoding: 'utf8' })
    expect(run.stdout).toMatch(new RegExp(`ℹ tests ${UNIT_TOTAL}\\n`))
    expect(run.stdout).toMatch(/ℹ fail 0\n/)
    expect(run.status).toBe(0)
  })

  it('serves its home page on the fallback --port', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise((resolve) => probe.close(resolve))
    const child = spawn(process.execPath, ['server.js', '--port', String(port)], { cwd: ROOT, env: clean() })
    children.push(child)
    const url = await announced(child)
    expect(url).toBe(`http://127.0.0.1:${port}/`)
    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('车门健康监测看板')
    expect((await fetch(`${url}api/ranking?limit=0`)).status).toBe(400)
  })

  // Node cannot inherit listening socket descriptors on Windows; the --port case runs on every OS.
  it.skipIf(process.platform === 'win32')(
    'takes over the listener handed in AGH_LOOPBACK_FD and prints AGH_LOOPBACK_URL',
    async () => {
      const listener = createServer()
      servers.push(listener)
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
      const port = (listener.address() as { port: number }).port
      const fd = (listener as Any)._handle.fd as number
      const env = { ...clean(), AGH_LOOPBACK_FD: '3', AGH_LOOPBACK_URL: `http://127.0.0.1:${port}/` }
      const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe', fd],
      })
      children.push(child)
      expect(await announced(child)).toBe(env.AGH_LOOPBACK_URL)
      const page = await fetch(env.AGH_LOOPBACK_URL)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('车门健康监测看板')
    },
  )
})
