#!/usr/bin/env node
// Opt-in real-process smoke. Uses only a fresh AGH_HOME, repository fixtures and a loopback provider.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, memoryJournal, wsTransport } from '../../packages/sdk/src/index.node.ts'
import { startProviderFixture } from '../acceptance/provider-fixture.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--entry'))
  throw new Error('Usage: smoke.mjs [--entry PATH_TO_BUILT_AGNES]')
const entry = args[1] ? resolve(args[1]) : resolve(repo, 'packages/cli/dist/local/agnes.mjs')
const root = await mkdtemp('/tmp/agh-pdocs-')
const home = join(root, 'h')
const cwd = join(root, 'w')
await mkdir(join(home, 'profiles/local-dev'), { recursive: true, mode: 0o700 })
await mkdir(cwd)
await writeFile(
  join(home, 'profiles/local-dev/profile.yaml'),
  [
    'name: local-dev',
    'computerUse:',
    '  enabled: false',
    'policy:',
    '  capabilityCeiling: [tools, hooks, slots, events, resources, ui, services, network, network.publicRead, tools.invoke, artifacts, subagent]',
    '',
  ].join('\n'),
)
for (const [source, name] of [
  ['hot-tool-plugin', 'tool'],
  ['client-panel/v1', 'panel'],
  ['client-service-panel/v1', 'service-v1'],
  ['client-service-panel/v2', 'service-v2'],
])
  await cp(join(repo, 'examples/packages', source), join(cwd, name), { recursive: true })

const listener = createServer()
await new Promise((done, reject) => {
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', done)
})
const port = listener.address().port
await new Promise((done) => listener.close(done))
const origin = `http://127.0.0.1:${port}`
// Allow-list child environment so no account credentials or connection overrides are inherited.
const env = {
  PATH: process.env.PATH,
  TMPDIR: '/tmp',
  AGH_HOME: home,
  AGNES_PROFILE: 'local-dev',
  AGNES_WEB_ORIGIN: origin,
}
const run = (args) =>
  new Promise((done, reject) => {
    const child = execFile(
      process.execPath,
      [entry, ...args],
      { cwd, env, timeout: 45000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(`CLI ${args[0]} failed: ${stderr.trim()}`), { cause: error }))
          : done({ stdout, stderr }),
    )
    child.stdin?.end()
  })
const waitUntil = async (fn) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('smoke readiness timeout')
}
let stage = 'help'
let client
let web
let provider
let websocketClient
const passed = []
const pass = (name) => {
  passed.push(name)
  console.log(`PASS ${name}`)
}
try {
  assert.match((await run(['--help'])).stdout, /agh/)
  pass('built CLI help')
  stage = 'sessions startup'
  assert.deepEqual(JSON.parse((await run(['sessions', '--json'])).stdout).items, [])
  assert.match((await run(['daemon', 'status'])).stdout, /running/)
  pass('daemon cold start and sessions list')
  const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
  client = createClient({
    transport: { kind: 'unix', path: owner.socketPath },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  await client.initialize()
  stage = 'provider configuration'
  const catalogue = await client.config.test({ providerId: 'deepseek' })
  const model = catalogue.models[0]?.id
  assert.ok(model, 'installed DeepSeek catalogue must contain a model')
  provider = await startProviderFixture('Public documentation smoke reply.', undefined, model)
  assert.equal((await client.config.get()).configured, false)
  await client.config.save({
    providerId: 'deepseek',
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    expectedRevision: 0,
  })
  pass('save loopback fixture provider (no real account)')
  stage = 'CLI prompt'
  assert.match((await run(['-p', 'Documentation smoke'])).stdout, /Public documentation smoke reply/)
  pass('CLI model loop against deterministic local fixture')
  const page = await client.session.list({})
  const sessionId = page.items[0].sessionId
  assert.ok(sessionId)
  stage = 'default helper tool'
  provider.queueTool({ name: 'mcp_manage', args: { action: 'list' } })
  await run(['-p', '--resume', sessionId, 'List MCP servers connected to AGH'])
  assert.ok(
    provider.requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes('"host":"Agnes Harness"') &&
          message.content.includes('"items":[]'),
      ),
    ),
    'default MCP plugin must execute through the real daemon and return the AGH inventory',
  )
  const helperStatus = (await run(['package', 'status'])).stdout
  for (const name of ['mcp-helper', 'skill-helper', 'plugin-helper'])
    assert.match(
      helperStatus,
      new RegExp(`@agnes/${name}@[^\\n]+desired=enabled actual=running trusted=true`),
    )
  pass('default MCP helper invoked through CLI/daemon/worker without manual installation')
  stage = 'conversation plugin authoring'
  const approvals = []
  const authorSession = await client.session.load(sessionId, {
    onPermissionRequest: async (request) => {
      approvals.push(request)
      return { optionId: request.options.find((option) => option.kind === 'allow_once').optionId }
    },
  })
  await authorSession.attach()
  const latestToolJSON = (matches) => {
    for (const request of [...provider.requests].reverse()) {
      for (const message of [...request.messages].reverse()) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue
        try {
          const data = JSON.parse(message.content)
          if (matches(data)) return data
        } catch {}
      }
    }
    throw new Error(`Missing actual plugin helper result at ${stage}`)
  }
  provider.queueTool({ name: 'plugin_helper_guide', args: { kind: 'tool' } })
  await authorSession.prompt('Read the AGH plugin guide', { signal: AbortSignal.timeout(30000) })
  const guide = latestToolJSON((data) => data.host === 'Agnes Harness' && Array.isArray(data.files))
  assert.equal(guide.apiVersion, '1.4.0')
  stage = 'conversation plugin create'
  provider.queueTool({ name: 'plugin_helper_create', args: { files: guide.files } })
  await authorSession.prompt('Create the sample AGH text statistics plugin', {
    signal: AbortSignal.timeout(30000),
  })
  const prepared = latestToolJSON((data) => data.state === 'prepared' && data.directory)
  assert.equal(
    await readFile(join(prepared.directory, 'index.mjs'), 'utf8'),
    guide.files.find((f) => f.path === 'index.mjs').content,
  )
  assert.ok(
    !(await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === 'my-agh-plugin'),
  )
  stage = 'conversation plugin install/status'
  provider.queueTool({
    name: 'plugin_helper_install',
    args: { action: 'commit', proposalId: prepared.proposalId },
  })
  await authorSession.prompt('Install the prepared plugin into AGH', { signal: AbortSignal.timeout(30000) })
  await waitUntil(async () =>
    (await client.packages.list({ profile: 'local-dev' })).packages.some(
      (p) => p.id === 'my-agh-plugin' && p.actual === 'running' && p.trusted,
    ),
  )
  assert.ok(
    approvals.some((request) => JSON.stringify(request).includes('sha256-')),
    'native prompt must bind exact package contents',
  )
  stage = 'conversation plugin install/status'
  provider.queueTool({
    name: 'plugin_helper_install',
    args: { action: 'status', proposalId: prepared.proposalId },
  })
  await authorSession.prompt('Verify the installed plugin', { signal: AbortSignal.timeout(30000) })
  assert.equal(latestToolJSON((data) => data.proposalId === prepared.proposalId).state, 'ready')
  provider.queueTool({ name: 'my_text_stats', args: { text: 'created in AGH' } })
  await authorSession.prompt('Use the newly created text statistics tool', {
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(latestToolJSON((data) => data.characters === 14).words, 3)
  pass(
    'default Plugin Helper: guide/create/native approval/install/actual status/new tool through daemon and worker',
  )
  stage = 'Web launch'
  web = spawn(process.execPath, [entry, 'serve', '--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let webErrors = ''
  web.stderr.on('data', (data) => {
    webErrors += data.toString()
  })
  await waitUntil(async () => {
    if (web.exitCode !== null) throw new Error(`Web exited: ${webErrors}`)
    try {
      const r = await fetch(origin)
      return r.ok && (await r.text()).includes('<html')
    } catch {
      return false
    }
  })
  pass('serve loopback HTML over HTTP')
  stage = 'WebSocket session path'
  const html = await (await fetch(origin)).text()
  const ws = html.match(/data-ws="([^"]+)"/)?.[1]
  assert.ok(ws, 'served page must contain its daemon WebSocket URL')
  websocketClient = createClient({
    transport: { kind: 'ws', url: ws, protocols: ['agnes-v1'] },
    transportFactories: {
      ws: (options) => wsTransport({ ...options, url: ws, headers: { Origin: origin } }),
    },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  await websocketClient.initialize()
  const webSession = await websocketClient.session.load(sessionId, { cwd })
  assert.ok(
    JSON.stringify(await webSession.projectUI(undefined, { surface: 'web' })).includes(
      'Public documentation smoke reply.',
    ),
  )
  pass('page-advertised WebSocket connects directly to daemon and reads session projection')
  const common = { profile: 'local-dev', clientId: await client.clientId() }
  const op = async (kind, params) => {
    const receipt = await client.packages[kind]({ ...common, commandId: `docs-${randomUUID()}`, ...params })
    return waitUntil(async () => {
      const result = await client.packages.operation.get({
        profile: common.profile,
        operationId: receipt.operationId,
      })
      if (result.state === 'failed' || result.state === 'cancelled')
        throw new Error(`${kind}: ${result.error?.code ?? result.state}`)
      return ['completed', 'rolled-back'].includes(result.state) ? result : undefined
    })
  }
  for (const [name, id] of [
    ['tool', '@agnes-examples/hot-tool-plugin'],
    ['panel', '@agnes-examples/client-panel'],
    ['service-v1', '@agnes-examples/client-service-panel'],
  ]) {
    stage = `install ${name}`
    const source = { type: 'file', ref: `file:./${name}` }
    const { preview } = await op('inspect', { source })
    assert.ok(preview)
    assert.deepEqual(preview.blockers, [])
    await op('install', { source, expectedIntegrity: preview.integrity })
    await op('trust', { id, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
    await op('enable', { id })
    pass(`${name}: inspect/install/trust/enable`)
  }
  stage = 'backend tool'
  provider.queueTool({ name: 'demo_text_stats', args: { text: 'hello world' } })
  await run(['-p', '--resume', sessionId, 'Count hello world with demo_text_stats'])
  assert.ok(
    provider.requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes('"characters":11') &&
          message.content.includes('"words":2'),
      ),
    ),
    'provider must receive the actual tool result',
  )
  pass('installed backend tool invoked through CLI/daemon/worker')
  stage = 'client roster'
  const roster = await waitUntil(async () => {
    const value = await client.clientModules.list('local-dev')
    return value.modules.length >= 2 ? value : undefined
  })
  assert.ok(roster.modules.some((row) => row.packageId === '@agnes-examples/client-panel'))
  assert.ok(roster.modules.some((row) => row.packageId === '@agnes-examples/client-service-panel'))
  pass('frontend and linked service packages projected to client roster')
  stage = 'linked service'
  const serviceId = '@agnes-examples/client-service-panel'
  const callVersion = () =>
    client.clientModules.callService({
      profile: 'local-dev',
      rowId: `web:${serviceId}`,
      sessionId,
      service: 'panel.version',
      input: {},
    })
  assert.deepEqual((await callVersion()).output, { version: '1.0.0' })
  pass('linked query through daemon/worker/Host (no browser)')
  const serviceBody = JSON.stringify({
    rowId: `web:${serviceId}`,
    sessionId,
    service: 'panel.version',
    input: {},
  })
  const bff = (requestOrigin) =>
    fetch(`${origin}/api/client-modules/service`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: requestOrigin },
      body: serviceBody,
    })
  assert.equal((await bff('http://untrusted.invalid')).status, 403)
  const response = await bff(origin)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).output, { version: '1.0.0' })
  pass('real HTTP BFF query and wrong-Origin refusal')
  stage = 'service update'
  const source = { type: 'file', ref: 'file:./service-v2' }
  const { preview } = await op('inspect', { source })
  assert.ok(preview)
  await op('update', { id: serviceId, source, expectedIntegrity: preview.integrity })
  await op('trust', {
    id: serviceId,
    expectedIntegrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  await op('enable', { id: serviceId })
  assert.deepEqual((await callVersion()).output, { version: '2.0.0' })
  pass('linked service update v1 → v2')
  stage = 'service rollback'
  await op('rollback', { id: serviceId })
  await assert.rejects(callVersion(), /CAPABILITY_DENIED/)
  const { preview: previous } = await op('inspect', { source: { type: 'file', ref: 'file:./service-v1' } })
  await op('trust', {
    id: serviceId,
    expectedIntegrity: previous.integrity,
    capabilityHash: previous.capabilityHash,
  })
  await op('enable', { id: serviceId })
  assert.deepEqual((await callVersion()).output, { version: '1.0.0' })
  pass('rollback denies calls until explicit trust/enable restores v1')
  stage = 'disable/remove'
  for (const id of [
    '@agnes-examples/hot-tool-plugin',
    '@agnes-examples/client-panel',
    '@agnes-examples/client-service-panel',
  ]) {
    await op('disable', { id })
    await op('remove', { id })
  }
  assert.equal((await client.clientModules.list('local-dev')).modules.length, 0)
  await assert.rejects(callVersion(), /CAPABILITY_DENIED/)
  pass('disable/remove clears roster and denies stale service calls')
} catch (error) {
  // This harness owns every request and secret; still print only bounded code/message, not data/headers.
  console.error(`FAIL ${stage}: ${error.name}: ${error.message}`)
  if (/^CONFIG_[A-Z_]+$/.test(error.data?.reason ?? '')) console.error(`safe reason: ${error.data.reason}`)
  process.exitCode = 1
} finally {
  if (web && web.exitCode === null) {
    const exit = new Promise((done) => web.once('exit', done))
    web.kill('SIGTERM')
    const timer = setTimeout(() => web.kill('SIGKILL'), 5000)
    await exit
    clearTimeout(timer)
  }
  await websocketClient?.close()
  await client?.close()
  try {
    await run(['daemon', 'stop'])
    pass('isolated daemon stopped')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
  await provider?.close()
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ stage, passed, ok: !process.exitCode }, null, 2),
  )
  console.log(
    `Evidence retained at ${root}; no files removed. No browser or paid model verification claimed.`,
  )
}
