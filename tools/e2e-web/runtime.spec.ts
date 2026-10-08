import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { command, complete, install, prompt, toolResult } from './sdk.js'

test('fresh first run, keyless demo, SDK account save and credential persistence', async ({
  runtime,
}, info) => {
  const client = await runtime.connect()
  expect((await client.config.get()).configured).toBe(false)
  expect((await client.session.list()).items).toEqual([])
  const webClient = await runtime.connect('web')
  const session = await webClient.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await session.attach()
  await prompt(session, 'Hello offline E2E')
  expect(JSON.stringify(await session.projectUI())).toContain('This teaching model performs no reasoning.')
  await prompt(session, 'call read {"path":"report.md"}')
  expect(JSON.stringify((await toolResult(session, 'read'))?.content)).toContain('Synthetic delivery')
  const catalog = await client.config.test({ providerId: 'deepseek' })
  const model = catalog.models[0]?.id
  if (!model) throw new Error('DeepSeek must have a model in the installed catalog')
  const provider = await startProviderFixture('E2E_SAVED_CREDENTIAL_OK', undefined, model)
  try {
    const initial = await client.config.get()
    const input = { providerId: 'deepseek', baseUrl: provider.baseUrl, apiKey: provider.apiKey }
    const tested = await client.config.test(input)
    expect(tested.verified).toBe(true)
    expect(tested.models.some((item) => item.id === model)).toBe(true)
    const saved = await client.config.save({
      ...input,
      model,
      accountId: 'e2e-account',
      label: 'Offline E2E account',
      expectedRevision: initial.revision,
      makeDefault: true,
    })
    expect(saved.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'e2e-account',
          label: 'Offline E2E account',
          credentialConfigured: true,
        }),
      ]),
    )
    expect(JSON.stringify(saved)).not.toContain(provider.apiKey)
    expect(saved.effect).toBe('restart-required')
    await runtime.restart()
    const configured = await runtime.connect()
    const real = await configured.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'full-access',
    })
    expect(real.id).not.toBe(session.id)
    await real.attach()
    await prompt(real, 'Confirm the stored synthetic credential works')
    expect(JSON.stringify(await real.projectUI())).toContain('E2E_SAVED_CREDENTIAL_OK')
    await runtime.restart()
    const restarted = await runtime.connect()
    expect((await restarted.config.get()).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'e2e-account', credentialConfigured: true }),
      ]),
    )
    const resumed = await restarted.session.load(real.id, { cwd: runtime.workspace })
    await resumed.attach()
    await prompt(resumed, 'Confirm the credential still works after restart')
    expect(JSON.stringify(await resumed.projectUI())).toContain('E2E_SAVED_CREDENTIAL_OK')
    const cli = await runtime.cli(['-p', '--cwd', runtime.workspace, 'Confirm CLI uses the saved account'])
    expect(cli).toContain('E2E_SAVED_CREDENTIAL_OK')
    await info.attach('first-run-projection.json', {
      body: JSON.stringify(await resumed.projectUI()),
      contentType: 'application/json',
    })
  } finally {
    await provider.close()
  }
})

test('folder capability review, explicit trust/enable, tool invocation and disable', async ({
  runtime,
}, info) => {
  const client = await runtime.connect()
  const preview = await install(client, 'examples/packages/hot-tool-plugin')
  expect(preview.integrity).toMatch(/^sha256-/)
  const row = (await client.packages.list({ profile: 'local-dev' })).packages.find(
    (row) => row.id === preview.id,
  )
  expect(row).toMatchObject({ desired: 'enabled', trusted: true, actual: 'running' })
  const loop = (await client.sessionSelection.loops()).find((loop) => loop.id === 'agnes.default')
  if (!loop) throw new Error('The default Agent loop must be available')
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
    loop,
  })
  await session.attach()
  await prompt(session, 'call demo_text_stats {"text":"hello world"}')
  expect((await toolResult(session, 'demo_text_stats'))?.structured).toEqual({ characters: 11, words: 2 })
  await complete(client, await client.packages.disable({ ...(await command(client)), id: preview.id }))
  const fresh = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
    loop,
  })
  expect((await fresh.tools()).tools.some((tool) => tool.name === 'demo_text_stats')).toBe(false)
  await prompt(session, 'call demo_text_stats {"text":"old sessions retain their binding"}')
  expect((await toolResult(session, 'demo_text_stats'))?.structured).toMatchObject({ words: 5 })
  await info.attach('review.json', { body: JSON.stringify(preview), contentType: 'application/json' })
})

test(
  'local hot reload preserves old/new session generations through daemon restart',
  { tag: '@flaky' },
  async ({ runtime }, info) => {
    const client = await runtime.connect()
    await runtime.localTool(1)
    await client.call('_agnes/v1/sessionSelection.reloadLocal', {})
    const loop = (await client.sessionSelection.loops()).find((loop) => loop.id === 'agnes.default')
    if (!loop) throw new Error('The default Agent loop must be available')
    const old = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'full-access',
      loop,
    })
    await old.attach()
    await prompt(old, 'call e2e_version {"text":"old"}')
    expect((await toolResult(old, 'e2e_version'))?.structured).toMatchObject({ version: 1 })
    await runtime.localTool(2)
    await client.call('_agnes/v1/sessionSelection.reloadLocal', {})
    const fresh = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'full-access',
      loop,
    })
    expect(fresh.id).not.toBe(old.id)
    await fresh.attach()
    await prompt(fresh, 'call e2e_version {"text":"new"}')
    expect((await toolResult(fresh, 'e2e_version'))?.structured).toMatchObject({ version: 2 })
    await prompt(old, 'call e2e_version {"text":"still old"}')
    expect((await toolResult(old, 'e2e_version'))?.structured).toMatchObject({ version: 1 })
    await runtime.restart()
    const restarted = await runtime.connect()
    for (const [id, version] of [
      [old.id, 1],
      [fresh.id, 2],
    ] as const) {
      const restored = await restarted.session.load(id, { cwd: runtime.workspace })
      await restored.attach()
      await prompt(restored, 'call e2e_version {"text":"persisted"}')
      expect((await toolResult(restored, 'e2e_version'))?.structured).toMatchObject({ version })
    }
    await info.attach('generations.json', {
      body: JSON.stringify(await restarted.packages.generations({ profile: 'local-dev' })),
      contentType: 'application/json',
    })
  },
)

test('CLI MCP stdio fixture runs through the SDK and workspace skills are discovered', async ({
  runtime,
}) => {
  await runtime.cli([
    'mcp',
    'add',
    'e2e',
    '--name',
    'e2e',
    '--stdio',
    'node',
    '--arg',
    resolve('tools/e2e-web/fixtures/mcp.mjs'),
    '--yes',
  ])
  const revision = async () => {
    const value = /revision=([a-f0-9]{64})/.exec(await runtime.cli(['mcp', 'get', 'e2e']))?.[1]
    if (!value) throw new Error('MCP get must return its reviewed revision')
    return value
  }
  await runtime.cli(['mcp', 'trust', 'e2e', '--expected-revision', await revision(), '--yes'])
  await runtime.cli(['mcp', 'enable', 'e2e', '--expected-revision', await revision(), '--yes'])
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
  })
  await session.attach()
  await prompt(session, 'call mcp__e2e__echo {"text":"E2E_MCP_STDIO"}')
  expect((await toolResult(session, 'mcp__e2e__echo'))?.content).toEqual([
    { type: 'text', text: 'E2E_MCP_STDIO' },
  ])
  const workspace = await client.workspace.add(runtime.workspace)
  const workspaceId = workspace.workspace.workspaceId
  if (!workspaceId) throw new Error('Workspace registration must return a durable id')
  const skills = await runtime.cli(['skills', 'list', '--workspace-id', workspaceId])
  expect(skills).toContain('e2e-playbook')
  expect(skills).toContain('trust=trusted')
  expect(skills).toContain('actual=ready')
  await prompt(session, 'call skill_read {"name":"e2e-playbook"}')
  expect(JSON.stringify(await toolResult(session, 'skill_read'))).toContain('E2E_SKILL_LOADED')
})

test('FDE bundle installs and runs its source-backed local workflow', async ({ runtime }, info) => {
  const client = await runtime.connect()
  await install(client, 'examples/fde/knowledge-qa')
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'full-access',
    bundles: ['@agnes-fde/knowledge-qa#knowledge-qa'],
  })
  await session.attach()
  expect(await session.capabilities()).toMatchObject({
    loop: { value: { id: 'fde.knowledge-qa', version: '3.0.0' } },
    bundles: ['@agnes-fde/knowledge-qa#knowledge-qa'],
  })
  await prompt(session, 'What is the refund window and who reviews refund requests?')
  const present = await toolResult(session, 'present')
  expect(JSON.stringify(present)).toContain('report.md')
  const output = await session.projectUI(undefined, { surface: 'web' })
  expect(JSON.stringify(output)).toContain('knowledge-qa')
  const read = await toolResult(session, 'write')
  expect(JSON.stringify(read)).toContain('fde-output/knowledge-qa/')
  const write = output.nodes.findLast((node) => node.kind === 'tool' && node.name === 'write')
  if (write?.kind !== 'tool') throw new Error('FDE must write its deliverable')
  const detail = await session.readToolDetail(write.seq, write.resultSeq)
  const args = detail.call.args
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string')
    throw new Error('FDE write must have a persisted output path')
  expect(await readFile(join(runtime.workspace, args.path), 'utf8')).toContain('Source-backed answer')
  await info.attach('fde-projection.json', { body: JSON.stringify(output), contentType: 'application/json' })
  await runtime.restart()
  const restarted = await runtime.connect()
  const restored = await restarted.session.load(session.id, { cwd: runtime.workspace })
  await restored.attach()
  expect(await restored.capabilities()).toMatchObject({
    loop: { value: { id: 'fde.knowledge-qa', version: '3.0.0' } },
    bundles: ['@agnes-fde/knowledge-qa#knowledge-qa'],
  })
  await prompt(restored, 'Who reviews refund requests?')
  expect(JSON.stringify(await toolResult(restored, 'present'))).toContain('report.md')
  expect(JSON.stringify(await restored.projectUI(undefined, { surface: 'web' }))).toContain('knowledge-qa')
})
