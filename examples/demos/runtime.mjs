import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { createClient, memoryJournal } from '@agnes/sdk'

export const say = (message) => console.log(message)
export async function waitFor(read, accepts, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${description} timed out: ${JSON.stringify(value)}`)
}
export async function runtime(check) {
  assert.ok(
    existsSync(resolve('packages/cli/dist/local/agnes.mjs')),
    'Run from the repository root after pnpm --filter @agnes/cli build:local',
  )
  const root = await mkdtemp(join(tmpdir(), 'agh-demo-'))
  const home = join(root, 'h'),
    workspace = join(root, 'w')
  await mkdir(workspace)
  // Deliberately do not inherit the operator's home, model credentials or plugin configuration.
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    TEMP: root,
    TMP: root,
    HOME: root,
    TMPDIR: tmpdir(),
    AGH_HOME: home,
    AGNES_PROFILE: 'local-dev',
  }
  const cli = (args) =>
    new Promise((done, reject) => {
      const child = execFile(
        process.execPath,
        [
          resolve('packages/cli/dist/local/agnes.mjs'),
          ...args,
          '--profile',
          'local-dev',
          '--workspace',
          workspace,
        ],
        { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`CLI ${args[0]} failed: ${stderr}`, { cause: error })) : done(stdout),
      )
      child.stdin.end()
    })
  let client
  let configured = false
  const connect = async () => {
    await cli(['daemon', 'start'])
    const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
    client = createClient({
      transport: { kind: 'unix', path: owner.socketPath },
      auth: { kind: 'local' },
      journal: memoryJournal(),
    })
    await client.initialize()
    await client.workspace.add(workspace)
    if (process.env.AGH_DEMO_MODEL && !configured) {
      assert.ok(
        process.env.AGH_DEMO_API_KEY,
        'Provide AGH_DEMO_API_KEY for the explicitly selected real model',
      )
      const [providerId, ...modelParts] = process.env.AGH_DEMO_MODEL.split('/')
      const model = modelParts.join('/')
      assert.ok(providerId && model, 'AGH_DEMO_MODEL must be providerId/model')
      const config = await client.config.get()
      await client.config.save({
        providerId,
        model,
        apiKey: process.env.AGH_DEMO_API_KEY,
        ...(process.env.AGH_DEMO_BASE_URL ? { baseUrl: process.env.AGH_DEMO_BASE_URL } : {}),
        accountId: 'demo-account',
        label: 'Temporary demo account',
        expectedRevision: config.revision,
        makeDefault: true,
      })
      configured = true
    }
    return client
  }
  const confirm = async (summary) => {
    say(`REVIEW: ${summary}`)
    if (check) {
      say('CI: approve this synthetic demonstration once.')
      return true
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await rl.question('Approve this synthetic action? [yes/no] ')).trim() === 'yes'
    } finally {
      rl.close()
    }
  }
  const allow = async (request) => {
    const approved = await confirm(
      request.toolCall.rawInput
        ? `${request.toolCall.title}\n${JSON.stringify(request.toolCall.rawInput)}`
        : request.toolCall.title.split('\n').slice(0, 3).join('\n'),
    )
    const option = request.options.find((option) => option.kind === (approved ? 'allow_once' : 'reject_once'))
    assert.ok(option, 'The backend must offer the selected approval decision')
    return { optionId: option.optionId }
  }
  let closing
  const dispose = () => {
    closing ??= (async () => {
      try {
        await client?.close()
        await cli(['daemon', 'stop'])
      } finally {
        await rm(root, { recursive: true, force: true })
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
      }
    })()
    return closing
  }
  const shutdown = (code) => {
    void dispose().then(
      () => process.exit(code),
      () => process.exit(1),
    )
  }
  const interrupt = () => shutdown(130)
  const terminate = () => shutdown(143)
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  return {
    home,
    workspace,
    confirm,
    allow,
    connect,
    get client() {
      return client
    },
    async session(options = {}) {
      const session = await client.session.new({ sessionKey: randomUUID(), cwd: workspace, ...options })
      session.onPermissionRequest(allow)
      await session.attach()
      if (process.env.AGH_DEMO_MODEL) {
        const model = process.env.AGH_DEMO_MODEL.slice(process.env.AGH_DEMO_MODEL.indexOf('/') + 1)
        await session.setModel({ slot: 'primary', route: 'account-demo-account', model })
      }
      return session
    },
    async restart() {
      await client.close()
      await cli(['daemon', 'stop'])
      return connect()
    },
    dispose,
  }
}
export async function command(client) {
  return { profile: 'local-dev', clientId: await client.clientId(), commandId: randomUUID() }
}
export async function complete(client, receipt) {
  return waitFor(
    async () => {
      const op = await client.packages.operation.get({
        profile: 'local-dev',
        operationId: receipt.operationId,
      })
      if (['failed', 'cancelled', 'rolled-back'].includes(op.state))
        throw new Error(`Package ${op.state}: ${JSON.stringify(op.error)}`)
      return op
    },
    (op) => op.state === 'completed',
    'Package publication',
  )
}
export async function install(rt, directory) {
  const client = rt.client,
    source = { type: 'file', ref: `file:${resolve(directory)}` }
  const { preview } = await complete(
    client,
    await client.packages.inspect({ ...(await command(client)), source }),
  )
  assert.deepEqual(preview.blockers, [])
  assert.ok(
    await rt.confirm(
      `${preview.id}@${preview.version}; capabilities=${JSON.stringify(preview.declaredCapabilities)}; integrity=${preview.integrity}`,
    ),
    'Installation declined',
  )
  const existing = (await client.packages.list({ profile: 'local-dev' })).packages.find(
    (p) => p.id === preview.id,
  )
  await complete(
    client,
    existing
      ? await client.packages.update({
          ...(await command(client)),
          id: preview.id,
          source,
          expectedIntegrity: preview.integrity,
          activation: {
            expectedInstalledIntegrity: existing.integrity,
            expectedActiveIntegrity: existing.actualIntegrity,
            trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
          },
        })
      : await client.packages.install({
          ...(await command(client)),
          source,
          expectedIntegrity: preview.integrity,
        }),
  )
  await complete(
    client,
    await client.packages.trust({
      ...(await command(client)),
      id: preview.id,
      expectedIntegrity: preview.integrity,
      capabilityHash: preview.capabilityHash,
    }),
  )
  await complete(client, await client.packages.enable({ ...(await command(client)), id: preview.id }))
  return preview
}
export async function prompt(session, input, reason = 'completed') {
  const result = await session.prompt(input, { signal: AbortSignal.timeout(60000) })
  assert.equal(result.reason, reason, JSON.stringify(result))
  return result
}
export async function results(session, name) {
  const timeline = await session.projectUI(undefined, { surface: 'web' })
  const nodes = timeline.nodes.filter(
    (node) => node.kind === 'tool' && node.name === name && node.resultSeq !== undefined,
  )
  return Promise.all(
    nodes.map(async (node) => {
      const detail = await session.readToolDetail(node.seq, node.resultSeq)
      assert.equal(detail.result?.isError ?? false, false, JSON.stringify(detail.result))
      return detail.result
    }),
  )
}
export async function result(session, name) {
  const outputs = await results(session, name)
  assert.ok(outputs.length, `No durable ${name} result`)
  const output = outputs.at(-1)
  return (
    output.structured ??
    JSON.parse(
      output.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    )
  )
}
