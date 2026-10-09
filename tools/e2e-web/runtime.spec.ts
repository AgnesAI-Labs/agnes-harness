import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { command, complete, install, prompt, toolResult } from './sdk.js'
import { preferences } from './ui.js'

test('Linux L1 admits a fresh workspace, hides secrets and anchors .agh against rename', async ({
  runtime,
}) => {
  test.skip(process.platform !== 'linux', 'Real bubblewrap namespace regression') // guards-allow-platform: actual Linux kernel boundary.
  const client = await runtime.connect()
  const cwd = join(runtime.workspace, 'fresh-l1')
  await mkdir(cwd)
  await expect(lstat(join(cwd, AGH_DIR))).rejects.toMatchObject({ code: 'ENOENT' })
  await client.workspace.add(cwd)
  const session = await client.session.new({ sessionKey: randomUUID(), cwd, preset: 'standard' })
  expect((await lstat(join(cwd, AGH_DIR))).isDirectory()).toBe(true)
  await mkdir(join(cwd, AGH_DIR, 'secrets'), { recursive: true })
  await writeFile(join(cwd, AGH_DIR, 'secrets', 'key'), 'SYNTHETIC_ANCESTOR_SECRET')
  await session.attach()
  session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  const shell =
    'if cat .agh/secrets/key; then exit 1; fi; if mv .agh moved; then exit 1; fi; printf ANCESTOR_HIDDEN'
  await prompt(session, `call shell ${JSON.stringify({ command: shell })}`)
  const result = JSON.stringify((await toolResult(session, 'shell'))?.content)
  expect(result).toContain('ANCESTOR_HIDDEN')
  expect(result).not.toContain('SYNTHETIC_ANCESTOR_SECRET')
  expect(await readFile(join(cwd, AGH_DIR, 'secrets', 'key'), 'utf8')).toBe('SYNTHETIC_ANCESTOR_SECRET')
  await expect(lstat(join(cwd, 'moved'))).rejects.toMatchObject({ code: 'ENOENT' })
  const unsafe = join(runtime.workspace, 'unsafe-l1')
  await mkdir(unsafe)
  await symlink(join(cwd, AGH_DIR), join(unsafe, AGH_DIR))
  await client.workspace.add(unsafe)
  await expect(
    client.session.new({ sessionKey: randomUUID(), cwd: unsafe, preset: 'standard' }),
  ).rejects.toMatchObject({
    data: { code: 'E_SANDBOX_WORKSPACE', reason: 'workspace-ancestor-not-directory' },
  })
})

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
    expect(saved.effect).toBe('new-sessions')
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
    // Match the SDK sessions above: this credential test explicitly uses full-access.
    // A restricted Linux container must not need a working L1 command sandbox to save an account.
    const cli = await runtime.cli([
      '-p',
      '--preset',
      'full-access',
      '--cwd',
      runtime.workspace,
      'Confirm CLI uses the saved account',
    ])
    expect(cli).toContain('E2E_SAVED_CREDENTIAL_OK')
    await info.attach('first-run-projection.json', {
      body: JSON.stringify(await resumed.projectUI()),
      contentType: 'application/json',
    })
  } finally {
    await provider.close()
  }
})

test('stored credential rejection offers account repair and recovers without restart', async ({
  page,
  runtime,
}, info) => {
  await preferences(page, 'en', 'light')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]!.id
  const provider = await startProviderFixture('CREDENTIAL_RECOVERED', undefined, model)
  try {
    const accountId = 'revoked-account'
    const input = {
      providerId: 'deepseek',
      accountId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      label: 'Revoked fixture account',
      makeDefault: true,
    }
    await client.config.test({
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
    })
    await client.config.save({ ...input, expectedRevision: (await client.config.get()).revision })
    const session = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'full-access',
    })
    await session.attach()
    await prompt(session, 'Before revocation')
    provider.rotateKey()
    await expect(session.prompt('Rejected after revocation')).rejects.toMatchObject({
      data: {
        code: 'CONFIG_CREDENTIAL_REJECTED',
        messageKey: 'appServer.errors.credentialRejected',
        retryable: false,
        modelRoute: 'account-' + accountId,
      },
    })
    // 401 is permanent: only one upstream inference request is sent for this failed turn.
    expect(provider.rejectedInferenceRequests).toBe(1)
    await page.goto(runtime.url + '?session=' + encodeURIComponent(session.id))
    const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
    await expect(composer).toBeEnabled()
    await composer.fill('Show the rejected account hint')
    await composer.press('Enter')
    const repair = page.getByTestId('credential-repair')
    await expect(repair).toHaveText('Fix model account')
    await expect(page.locator('#notice')).toContainText('credentials have expired or were rejected')
    expect(provider.rejectedInferenceRequests).toBe(2)
    await page.screenshot({ path: info.outputPath('credential-repair-en-light.png') })
    await repair.click()
    await expect(page.getByRole('dialog', { name: 'Account details', exact: true })).toBeVisible()
    await expect(page.locator('#config-account-name')).toHaveValue('Revoked fixture account')
    await page.locator('#config-api-key').fill(provider.apiKey)
    await page.locator('#config-test').click()
    await expect(page.locator('#config-save')).toBeEnabled()
    const revision = (await client.config.get()).revision
    await page.locator('#config-save').click()
    await expect.poll(async () => (await client.config.get()).revision).not.toBe(revision)
    // The revision commits before model publication; wait for the save RPC and UI completion.
    await expect(page.getByRole('dialog', { name: 'Account details', exact: true })).toBeHidden()
    await prompt(session, 'After credential correction')
    const recovered = await session.projectUI()
    expect(recovered.turns.at(-1)?.status).toBe('completed')
    expect(JSON.stringify(recovered)).toContain('CREDENTIAL_RECOVERED')
    expect(provider.rejectedInferenceRequests).toBe(2)
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

test('local hot reload preserves old/new session generations through daemon restart', async ({
  runtime,
}, info) => {
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
})

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
    '--sandbox-profile',
    'off-with-warning',
    '--yes',
  ])
  const revision = async () => {
    const stored = await runtime.cli(['mcp', 'get', 'e2e'])
    expect(stored).toContain('sandbox=off-with-warning')
    const value = /revision=([a-f0-9]{64})/.exec(stored)?.[1]
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
