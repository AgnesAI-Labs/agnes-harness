import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createClient, memoryJournal } from '@agnes/sdk'

export const pause = (ms) => new Promise((done) => setTimeout(done, ms))
export async function realRuntime(label, existingRoot) {
  if (!existingRoot)
    assert.ok(process.env.AGH_DEMO_API_KEY, 'Inject AGH_DEMO_API_KEY through secret handling')
  const base = join(homedir(), 'agh-real-eval')
  const root = existingRoot ? resolve(existingRoot) : join(base, `${Date.now().toString(36)}-${label}`)
  const child = relative(base, root)
  assert.ok(
    child && !child.startsWith('..') && !child.includes(sep),
    'Only a direct isolated evaluation directory is accepted',
  )
  const home = join(root, 'h'),
    workspace = join(root, 'w')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const temp = join(root, 'tmp')
  await mkdir(temp, { recursive: true, mode: 0o700 })
  const listener = createServer()
  await new Promise((done) => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise((done) => listener.close(done))
  assert.ok(port !== 4177 && port !== 4178)
  const url = `http://127.0.0.1:${port}`
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: url,
  }
  const entry = resolve('packages/cli/dist/local/agnes.mjs')
  const redact = (value) =>
    process.env.AGH_DEMO_API_KEY
      ? String(value).replaceAll(process.env.AGH_DEMO_API_KEY, '[REDACTED]')
      : String(value)
  const cli = (args) =>
    new Promise((done, reject) => {
      const child = execFile(
        process.execPath,
        [entry, ...args],
        { env, cwd: workspace, timeout: 60000, maxBuffer: 2 ** 22, windowsHide: true },
        (error, stdout, stderr) =>
          error ? reject(new Error(redact(stderr || stdout))) : done(redact(stdout)),
      )
      child.stdin.end()
    })
  let client, web
  let log = ''
  const stopWeb = async () => {
    if (web && web.exitCode === null && web.signalCode === null) {
      const exited = new Promise((done) => web.once('exit', done))
      web.kill('SIGTERM')
      const timer = setTimeout(() => web.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    web = undefined
  }
  const rt = {
    root,
    home,
    workspace,
    url,
    cli,
    redact,
    get client() {
      return client
    },
    async connect(startDaemon = true) {
      if (startDaemon) await cli(['daemon', 'start'])
      const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
      client = createClient({
        timeouts: { request: 120000 },
        transport: {
          kind: 'unix',
          path: owner.socketPath,
          ...(owner.socketPath.startsWith('\\\\.\\pipe\\')
            ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
            : {}),
        },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      await client.initialize()
      await client.workspace.add(workspace)
    },
    async configure() {
      const [providerId, ...parts] = (process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash').split('/')
      await client.config.save({
        providerId,
        model: parts.join('/'),
        apiKey: process.env.AGH_DEMO_API_KEY,
        accountId: 'real-eval',
        label: 'Isolated real evaluation',
        makeDefault: true,
        expectedRevision: (await client.config.get()).revision,
        ...(process.env.AGH_DEMO_BASE_URL ? { baseUrl: process.env.AGH_DEMO_BASE_URL } : {}),
      })
    },
    async session() {
      const s = await client.session.new({
        sessionKey: randomUUID(),
        cwd: workspace,
        preset: 'full-access',
        bundles: [],
      })
      s.onPermissionRequest(async (r) => {
        const option = r.options.find((o) => o.kind === 'allow_once')
        assert.ok(option, 'No one-time approval offered')
        return { optionId: option.optionId }
      })
      await s.attach()
      const model = (process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash').split('/').slice(1).join('/')
      await s.setModel({ slot: 'primary', route: 'account-real-eval', model })
      return s
    },
    async startWeb() {
      web = spawn(process.execPath, [entry, 'serve', '--port', String(port)], {
        env,
        cwd: workspace,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const stream of [web.stdout, web.stderr])
        stream.on('data', (data) => {
          log += redact(data)
        })
      for (let i = 0; i < 300; i++) {
        if (web.exitCode !== null) throw new Error(log)
        try {
          if ((await fetch(url)).ok) return
        } catch {
          /* starting */
        }
        await pause(100)
      }
      throw new Error(`Web start timeout: ${log}`)
    },
    async restart() {
      await stopWeb()
      await client.close()
      await cli(['daemon', 'stop'])
      await rt.connect()
    },
    async save(name, value) {
      await writeFile(join(root, name), redact(JSON.stringify(value, null, 2)), { mode: 0o600 })
    },
    async dispose() {
      await stopWeb()
      await client?.close()
      await cli(['daemon', 'stop'])
      await rt.save('serve-log.json', log)
    },
  }
  return rt
}

export async function snapshot(session) {
  const timeline = await session.projectUI(undefined, { surface: 'web' })
  const tools = []
  for (const node of timeline.nodes.filter((n) => n.kind === 'tool')) {
    tools.push({ name: node.name, ...(await session.readToolDetail(node.seq, node.resultSeq)) })
  }
  return { timeline, tools, budget: await session.budget() }
}
