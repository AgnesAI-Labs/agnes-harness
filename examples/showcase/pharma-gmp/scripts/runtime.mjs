import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, memoryJournal } from '@agnes/sdk'

export const pause = (ms) => new Promise((done) => setTimeout(done, ms))
export async function until(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await pause(150)
  }
  throw new Error(`Timed out: ${label}`)
}
export async function runtime(real, application = 'pharma-gmp') {
  const root = join(
    homedir(),
    'agh-real-eval',
    `${Date.now().toString(36)}-${application}-${real ? 'real' : 'demo'}`,
  )
  const home = join(root, 'h'),
    workspace = join(root, 'w')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const listener = createServer()
  await new Promise((done) => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise((done) => listener.close(done))
  assert.ok(![4177, 4178].includes(port))
  const url = `http://127.0.0.1:${port}`,
    entry = resolve('packages/cli/dist/local/agnes.mjs')
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: url,
    TMPDIR: root,
  }
  const redact = (s) =>
    process.env.AGH_DEMO_API_KEY
      ? String(s).replaceAll(process.env.AGH_DEMO_API_KEY, '[REDACTED]')
      : String(s)
  const cli = (args) =>
    new Promise((done, fail) => {
      const p = execFile(
        process.execPath,
        [entry, ...args, '--workspace', workspace],
        { cwd: workspace, env, timeout: 120000, maxBuffer: 2 ** 22 },
        (e, stdout, stderr) => (e ? fail(new Error(redact(stderr || stdout))) : done(redact(stdout))),
      )
      p.stdin.end()
    })
  // Use dollar-denominated credits for isolated real-model accounting.
  // The acceptance runner supplies hard ceilings on its interactive turns.
  // An explicit profile intentionally disables the platform's fresh-home Demo fallback.
  if (real) {
    // Let the normal CLI initialize the versioned empty home before adding configuration.
    await cli(['daemon', 'start'])
    await cli(['daemon', 'stop'])
    await mkdir(join(home, 'profiles/local-dev'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(home, 'profiles/local-dev/profile.yaml'),
      JSON.stringify({ name: 'local-dev', limits: { 'cost.credits_per_usd': 1 } }),
      { mode: 0o600 },
    )
  }
  await cli(['daemon', 'start'])
  let client, web, approvalHook
  async function connect() {
    const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
    client = createClient({
      transport: { kind: 'unix', path: owner.socketPath },
      auth: { kind: 'local' },
      journal: memoryJournal(),
      timeouts: { request: 120000 },
    })
    await client.initialize()
    await client.workspace.add(workspace)
  }
  await connect()
  if (real) {
    assert.ok(process.env.AGH_DEMO_API_KEY, 'Inject key for this command only')
    try {
      await client.config.save({
        providerId: 'deepseek',
        model: 'deepseek-flash',
        apiKey: process.env.AGH_DEMO_API_KEY,
        accountId: 'pharma-eval',
        label: 'Isolated pharma evaluation',
        makeDefault: true,
        expectedRevision: (await client.config.get()).revision,
      })
    } catch (error) {
      await client.close()
      await cli(['daemon', 'stop'])
      throw new Error(redact(error.message))
    }
  }
  const command = async () => ({
    profile: 'local-dev',
    clientId: await client.clientId(),
    commandId: randomUUID(),
  })
  async function completed(receipt) {
    return until(
      async () => {
        const op = await client.packages.operation.get({
          profile: 'local-dev',
          operationId: receipt.operationId,
        })
        if (['failed', 'cancelled', 'rolled-back'].includes(op.state))
          throw new Error(redact(JSON.stringify(op.error)))
        return op
      },
      (v) => v.state === 'completed',
      'package operation',
    )
  }
  async function install(directory) {
    const source = { type: 'file', ref: `file:${resolve(directory)}` }
    const { preview } = await completed(await client.packages.inspect({ ...(await command()), source }))
    assert.deepEqual(preview.blockers, [])
    await completed(
      await client.packages.install({ ...(await command()), source, expectedIntegrity: preview.integrity }),
    )
    await completed(
      await client.packages.trust({
        ...(await command()),
        id: preview.id,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
    await completed(await client.packages.enable({ ...(await command()), id: preview.id }))
    return preview
  }
  async function session(role = 'hub') {
    const ref = `@agnes-showcase/pharma-gmp#${role}`,
      plan = await client.agents.resolve(ref)
    const s = await client.session.new({
      sessionKey: randomUUID(),
      cwd: workspace,
      agent: ref,
      agentDigest: plan.digest,
    })
    s.onPermissionRequest(async (request) => {
      if (approvalHook) await approvalHook(s.id, request)
      const option = request.options.find((o) => o.kind === 'allow_once')
      assert.ok(option)
      return { optionId: option.optionId }
    })
    await s.attach()
    if (real) await s.setModel({ slot: 'primary', route: 'account-pharma-eval', model: 'deepseek-flash' })
    return s
  }
  async function startWeb() {
    web = spawn(process.execPath, [entry, 'serve', '--port', String(port), '--workspace', workspace], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    for (const stream of [web.stdout, web.stderr])
      stream.on('data', (bytes) => {
        log += redact(bytes)
      })
    await until(
      async () => {
        if (web.exitCode !== null) throw new Error(log)
        try {
          return (await fetch(url)).ok
        } catch {
          return false
        }
      },
      Boolean,
      'web server',
    )
  }
  async function stopWeb() {
    if (web?.exitCode === null && web.signalCode === null) {
      const exited = new Promise((done) => web.once('exit', done))
      web.kill('SIGTERM')
      const timer = setTimeout(() => web.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    web = undefined
  }
  return {
    root,
    home,
    workspace,
    url,
    redact,
    cli,
    command,
    completed,
    install,
    session,
    startWeb,
    onApproval(hook) {
      approvalHook = hook
    },
    get client() {
      return client
    },
    save: async (name, data) =>
      writeFile(join(root, name), redact(JSON.stringify(data, null, 2)), { mode: 0o600 }),
    async restart() {
      await stopWeb()
      await client.close()
      await cli(['daemon', 'stop'])
      await cli(['daemon', 'start'])
      await connect()
    },
    async dispose() {
      await stopWeb()
      await client.close()
      await cli(['daemon', 'stop'])
    },
  }
}
export async function toolResult(session, name) {
  const timeline = await session.projectUI(undefined, { surface: 'web' })
  const node = timeline.nodes
    .filter((n) => n.kind === 'tool' && n.name === name && n.resultSeq !== undefined)
    .at(-1)
  assert.ok(node, `No durable ${name} result`)
  const detail = await session.readToolDetail(node.seq, node.resultSeq)
  assert.ok(!detail.result?.isError, JSON.stringify(detail.result))
  return (
    detail.result.structured ??
    JSON.parse(
      detail.result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    )
  )
}
