// Research driver: public Node SDK and production CLI only. Not part of the installed package.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { resolve } from 'node:path'
const require = createRequire(new URL('../examples/demos/package.json', import.meta.url))
const { createClient, memoryJournal } = await import(require.resolve('@agnes/sdk'))
const pointer = '/tmp/agh-acme-whitelabel-state.json'
const command = process.argv[2] ?? 'setup'
let state
if (command === 'setup') {
  const root = await mkdtemp('/tmp/agh-acme-')
  state = { root, home: `${root}/home`, workspace: `${root}/workspace` }
  await mkdir(state.workspace)
  const bootstrapEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: '/tmp', AGH_HOME: state.home, AGNES_PROFILE: 'local-dev' }
  for (const action of ['start', 'stop']) execFileSync(process.execPath, [resolve('packages/cli/dist/local/agnes.mjs'), 'daemon', action, '--profile', 'local-dev', '--workspace', state.workspace], { env: bootstrapEnv, timeout: 60000 })
  await mkdir(`${state.home}/profiles/local-dev`, { recursive: true })
  const profile = await readFile(new URL('./acme-maintenance-profile.json', import.meta.url), 'utf8')
  await writeFile(`${state.home}/profiles/local-dev/profile.yaml`, profile)
  await writeFile(pointer, JSON.stringify(state))
} else state = JSON.parse(await readFile(pointer, 'utf8'))
const env = { PATH: process.env.PATH, HOME: state.root, TMPDIR: '/tmp', AGH_HOME: state.home, AGNES_PROFILE: 'local-dev', ...(state.port ? { AGNES_WEB_ORIGIN: `http://127.0.0.1:${state.port}` } : {}) }
const entry = resolve('packages/cli/dist/local/agnes.mjs')
function cli(args) { return execFileSync(process.execPath, [entry, ...args, '--profile', 'local-dev', '--workspace', state.workspace], { env, encoding: 'utf8', timeout: 60000 }) }
if (command === 'stop') { cli(['daemon', 'stop']); process.exit(0) }
if (command === 'web') {
  cli(['daemon', 'stop'])
  const server = net.createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  state.port ??= server.address().port
  await new Promise((done) => server.close(done))
  await writeFile(pointer, JSON.stringify(state))
  const child = spawn(process.execPath, [entry, 'serve', '--port', String(state.port), '--profile', 'local-dev', '--cwd', state.workspace], { env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((done) => child.once('exit', done))
  process.exit()
}
cli(['daemon', 'start'])
const owner = JSON.parse(await readFile(`${state.home}/daemon/owner.json`, 'utf8'))
const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, auth: { kind: 'local' }, journal: memoryJournal() })
await client.initialize()
async function complete(receipt) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const operation = await client.packages.operation.get({ profile: 'local-dev', operationId: receipt.operationId })
    if (operation.state === 'completed') return operation
    if (['failed', 'cancelled', 'rolled-back'].includes(operation.state)) throw new Error(JSON.stringify(operation))
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('Package publication timed out')
}
async function cmd() { return { profile: 'local-dev', clientId: await client.clientId(), commandId: randomUUID() } }
const id = 'acme-maintenance'
try {
  if (command === 'setup') await client.workspace.add(state.workspace)
  if (['install', 'update'].includes(command)) {
    const source = { type: 'file', ref: `file:${resolve(process.argv[3] ?? 'spikes/acme-maintenance')}` }
    const { preview } = await complete(await client.packages.inspect({ ...await cmd(), source }))
    assert.deepEqual(preview.blockers, [])
    console.log(JSON.stringify({ stage: 'inspect', id: preview.id, version: preview.version, blockers: preview.blockers, integrity: preview.integrity, capabilityHash: preview.capabilityHash }))
    if (command === 'install') await complete(await client.packages.install({ ...await cmd(), source, expectedIntegrity: preview.integrity }))
    else {
      const old = (await client.packages.list({ profile: 'local-dev' })).packages.find((p) => p.id === id)
      await complete(await client.packages.update({ ...await cmd(), id, source, expectedIntegrity: preview.integrity, activation: { expectedInstalledIntegrity: old.integrity, expectedActiveIntegrity: old.actualIntegrity, trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash } } }))
    }
    await complete(await client.packages.trust({ ...await cmd(), id, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash }))
    await complete(await client.packages.enable({ ...await cmd(), id }))
  }
  if (['disable', 'enable'].includes(command)) await complete(await client.packages[command]({ ...await cmd(), id }))
  if (command === 'uninstall') await complete(await client.packages.remove({ ...await cmd(), id }))
  if (command === 'status' || ['install', 'update', 'disable', 'enable', 'uninstall'].includes(command)) {
    console.log(JSON.stringify({ packages: (await client.packages.list({ profile: 'local-dev' })).packages.filter((p) => p.id === id), roster: (await client.clientModules.list('local-dev')).rows.filter((r) => r.packageId === id) }, null, 2))
  }
  if (command === 'resume') {
    const session = await client.session.load(process.argv[3])
    await session.attach()
    const result = await session.prompt('Repeat synthetic inspection')
    const view = await session.projectUI(undefined, { surface: 'web' })
    console.log(JSON.stringify({ sessionId: session.id, result, runtime: await client.session.runtime(session.id), tools: view.nodes.filter(n => n.kind === 'tool') }, null, 2))
  }
  if (command === 'roster') console.log(JSON.stringify(await client.clientModules.list('local-dev'), null, 2))
  if (command === 'session') {
    const sessions = await client.session.list()
    for (const row of sessions.items) console.log(JSON.stringify({ row, runtime: await client.session.runtime(row.sessionId), timeline: await (await client.session.load(row.sessionId)).projectUI(undefined, {surface:'web'}) }))
  }
  console.log(JSON.stringify({ command, home: state.home, workspace: state.workspace, port: state.port }))
} finally { await client.close() }
