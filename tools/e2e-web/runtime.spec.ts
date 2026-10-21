import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGH_DIR, SESSION_VERSION_CODES } from '@agnes/protocol'
import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import { command, complete, install, prompt, toolResult } from './sdk.js'
import { preferences } from './ui.js'

test('consented role takeover and host-only recovery hand back the same session without changing its pin', async ({
  page,
  runtime,
}) => {
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  await prompt(session, 'call present {"files":[{"path":"report.md","name":"Recovery evidence"}]}')
  const result = await toolResult(session, 'present')
  const before = await client.session.runtime(session.id)
  expect(before.generation.id).toBeTruthy()
  const application = () => client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
  const id = '@community/deliverables-gallery'
  await install(client, resolve('examples/community/deliverables-gallery'))
  await preferences(page)
  const url = `${runtime.url}/?session=${session.id}`
  await page.goto(url)
  // Installation alone cannot take over a standard product role.
  await expect(page.getByTestId('turn-deliverables')).toContainText('Recovery evidence')
  await expect(page.getByTestId('deliverables-gallery')).toHaveCount(0)
  const preview = await client.request('_agnes/v1/applications.preview', {
    profile: 'local-dev',
    packageId: id,
  })
  await client.request('_agnes/v1/applications.adopt', {
    ...(await command(client)),
    packageId: id,
    expectedRevision: (await application()).revision,
    consentDigest: preview.consentDigest,
  })
  // Also persist an explicit role choice: recovery must clear both kinds of selection.
  const rolePreview = await client.request('_agnes/v1/applications.preview', {
    profile: 'local-dev',
    packageId: id,
    role: 'deliverables',
    targetClientId: 'gallery',
  })
  await client.request('_agnes/v1/applications.adopt', {
    ...(await command(client)),
    packageId: id,
    role: 'deliverables',
    targetClientId: 'gallery',
    expectedRevision: (await application()).revision,
    consentDigest: rolePreview.consentDigest,
  })
  await page.reload()
  await expect(page.getByTestId('deliverables-gallery').first()).toContainText('Recovery evidence')
  await expect(page.getByTestId('turn-deliverables')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Task content', exact: true }).fill('Recovery draft')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  const pluginRequests: string[] = []
  const record = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.startsWith('/plugins/')) pluginRequests.push(request.url())
  }
  page.on('request', record)
  await page.goto(`${runtime.url}/?admin`)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Application recovery', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('main')).toContainText(id)
  await page.getByRole('button', { name: 'Restore official interface', exact: true }).click()
  await expect.poll(async () => (await application()).status).toBe('host')
  const cleared = await application()
  expect(cleared.selection).toBeNull()
  expect(cleared.roleSelections ?? {}).toEqual({})
  expect(pluginRequests).toEqual([])
  page.off('request', record)
  await page.goto(url)
  await expect(page.getByTestId('deliverables-gallery')).toHaveCount(0)
  await expect(page.getByTestId('turn-deliverables')).toContainText('Recovery evidence')
  await page.getByRole('textbox', { name: 'Task content', exact: true }).fill('Handback draft')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  const after = await client.session.runtime(session.id)
  expect(after.generation.id).toBe(before.generation.id)
  expect(after.composition).toEqual(before.composition)
  expect(after.policy).toEqual(before.policy)
  expect(after.loop).toEqual(before.loop)
  expect(after.seams).toEqual(before.seams)
  expect((await toolResult(session, 'present'))?.artifactRefs).toEqual(result?.artifactRefs)
})

test('session admission keeps history readable, drafts editable and sending gated across a stale switch', async ({
  page,
  runtime,
}) => {
  await preferences(page)
  const client = await runtime.connect()
  const a = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  const b = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await prompt(a, 'Admission history A')
  await prompt(b, 'Admission history B')
  await client.session.rename(a.id, 'Admission A')
  await client.session.rename(b.id, 'Admission B')
  const sent: { method?: string; params?: { sessionId?: string; requestId?: string } }[] = []
  let release: (() => void) | undefined
  let hold = true
  await page.routeWebSocket('**', (socket) => {
    const server = socket.connectToServer()
    const pending = new Map<string | number, string>()
    socket.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      sent.push(message)
      if (message.method === '_agnes/v1/session.open' && message.params.sessionId === a.id && hold) {
        pending.set(message.id, a.id)
        hold = false
      }
      server.send(raw)
    })
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      if (pending.has(message.id)) {
        pending.delete(message.id)
        release = () => socket.send(raw)
      } else socket.send(raw)
    })
  })
  await page.goto(`${runtime.url}/?session=${a.id}`)
  await expect(page.getByTestId('conversation-turn')).toContainText('Admission history A')
  await expect.poll(() => typeof release).toBe('function')
  const input = page.getByRole('textbox', { name: 'Task content', exact: true })
  await expect(input).toBeEnabled()
  await input.fill('/plan Local draft A')
  await input.press('Enter')
  await expect(input).toHaveValue('/plan Local draft A')
  await expect(page.locator('#send')).toBeDisabled()
  // The pending recorded history is a read-only preview until admission: the composer says so.
  await expect(input).toHaveAttribute('placeholder', /read-only/i)
  await expect(page.getByTestId('attachment-file-input')).toBeDisabled()
  await page.getByText('Admission B', { exact: true }).first().click()
  await input.fill('Local draft B')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect
    .poll(() =>
      sent.some(
        (m) =>
          m.method === '_agnes/v1/session.loadingCancel' &&
          m.params?.sessionId === a.id &&
          !!m.params.requestId,
      ),
    )
    .toBe(true)
  release?.()
  await expect(input).toHaveValue('Local draft B')
  await expect(page).toHaveURL(new RegExp(`session=${b.id}`))
  await page.getByText('Admission A', { exact: true }).first().click()
  await expect(input).toHaveValue('/plan Local draft A')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(sent.some((m) => m.method === 'session/load' || m.method === 'session/prompt')).toBe(false)
})

// Uses the built CLI/browser payload and a durable synthetic session, without live providers.
test('bundled deliverables survive a cold browser start and repeated reloads', async ({ page, runtime }) => {
  const client = await runtime.connect()
  for (let index = 0; index < 3; index++) {
    const other = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    await other.attach()
    for (let turn = 0; turn < 4; turn++)
      await prompt(other, `History ${index}/${turn}: ` + 'Synthetic long conversation. '.repeat(1000))
    await prompt(other, 'call present {"files":[{"path":"report.md"}]}')
  }
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  for (let turn = 0; turn < 4; turn++)
    await prompt(session, `Target history ${turn}: ` + 'Synthetic long conversation. '.repeat(1000))
  session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  await prompt(session, 'call present {"files":[{"path":"report.md","name":"Cold-start report.md"}]}')
  const saved = await toolResult(session, 'present')
  expect(saved?.artifactRefs).toHaveLength(1)
  await runtime.restart()
  await preferences(page)
  const skip = page.getByTestId('first-run-skip')
  await page.addLocatorHandler(skip, async () => await skip.click(), { times: 1 })
  const url = new URL(runtime.url)
  url.searchParams.set('session', session.id)
  const entries: string[] = []
  page.on('response', (response) => {
    if (/\/plugins\/.*deliverables-ui.*\/client\.js(?:\?|$)/.test(response.url())) {
      expect(response.ok()).toBe(true)
      entries.push(response.url())
    }
  })
  for (let boot = 0; boot < 3; boot++) {
    if (boot === 0) await page.goto(url.href)
    else await page.reload()
    const tail = page.getByTestId('turn-deliverables').filter({ hasText: 'Cold-start report.md' })
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(tail).toHaveCount(1)
    await expect(tail.getByTestId('deliverable-file')).toHaveCount(1)
    await tail.locator('.agh-list-row-title').click()
    await expect(page.getByTestId('workbench-deliverables')).toContainText('Synthetic delivery')
  }
  const restored = await (await runtime.connect()).session.open(session.id, { cwd: runtime.workspace })
  expect((await toolResult(restored, 'present'))?.artifactRefs).toEqual(saved?.artifactRefs)
  // Loading an immutable plugin URL proves this exercised the deployed package rather than source imports.
  expect(entries.length).toBeGreaterThanOrEqual(3)
  expect(new Set(entries.map((entry) => entry.split('?')[0])).size).toBe(1)
  // Unsupported artifacts stay in the transcript and download only after an explicit click.
  await page.getByTestId('workbench-right-toggle').click()
  const bytes = Buffer.from([0, 1, 2, 255])
  await writeFile(join(runtime.workspace, 'attachment.bin'), bytes)
  restored.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  await prompt(restored, 'call present {"files":[{"path":"attachment.bin"}]}')
  const binary = page.getByTestId('turn-deliverables').filter({ hasText: 'attachment.bin' })
  await expect(binary).toBeVisible()
  await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
  const downloaded = page.waitForEvent('download')
  await binary.locator('.agh-list-row-title').click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('attachment.bin')
  const path = await download.path()
  if (!path) throw new Error('Missing downloaded artifact')
  expect(await readFile(path)).toEqual(bytes)
  await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
})

for (const [issue, version, action] of [
  ['newer', 9, 'Reopen after upgrading'],
  ['older', 1, 'Start a new session'],
  ['corrupt', undefined, 'Start a new session'],
  ['missing', undefined, 'Start a new session'],
] as const)
  test(`runtime information and ${issue} session history remain readable across locale changes`, async ({
    page,
    runtime,
  }, info) => {
    await preferences(page)
    const client = await runtime.connect()
    const session = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    await session.attach()
    await prompt(session, 'Historical browser regression conversation')
    const descriptor = await client.session.runtime(session.id)
    expect(descriptor.loaded).toBe(true)
    if (!descriptor.loop) throw new Error('A loaded session must describe its selected Loop')
    await page.goto(`${runtime.url}/?session=${session.id}`)
    await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toBeEnabled()
    const trigger = page.locator(`[data-session-action-id="${session.id}"]`)
    await page.locator('.session-row').filter({ has: trigger }).hover()
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Runtime info', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Runtime info', exact: true })
    await expect(dialog).toContainText(descriptor.generation.id!)
    await expect(dialog).toContainText(descriptor.loop.id)
    const language = async (value: string) =>
      page.evaluate((locale) => {
        localStorage.setItem('agnes-locale', locale)
        window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: locale }))
      }, value)
    await language('zh-CN')
    const localizedDialog = page.getByRole('dialog', { name: '运行信息', exact: true })
    await expect(localizedDialog).toBeVisible()
    await expect(localizedDialog).toContainText('关闭')
    await page.keyboard.press('Escape')
    await expect(localizedDialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await language('en')
    // Damage only the isolated fixture's closed generation, preserving its readable ledger.
    await page.goto('about:blank')
    await client.close()
    await runtime.cli(['daemon', 'stop'])
    const file = join(
      runtime.home,
      'profiles/local-dev/.runtime-generations',
      descriptor.generation.id!,
      'generation.json',
    )
    const generation = JSON.parse(await readFile(file, 'utf8'))
    if (version !== undefined) generation.version = version
    if (issue === 'older') delete generation.seams
    if (issue === 'corrupt') generation.compatibility = 42
    if (issue === 'missing') await rm(file)
    else await writeFile(file, JSON.stringify(generation))
    await runtime.restart()
    const restarted = await runtime.connect()
    await expect(restarted.session.load(session.id, { cwd: runtime.workspace })).rejects.toMatchObject({
      data: { code: SESSION_VERSION_CODES[issue === 'missing' ? 'older' : issue] },
    })
    await page.goto(`${runtime.url}/?session=${session.id}`)
    const banner = page.getByTestId('session-read-only')
    await expect(banner).toContainText('Read-only')
    await expect(banner.getByRole('button', { name: action, exact: true })).toBeVisible()
    await expect(page.getByTestId('conversation-turn')).toContainText(
      'Historical browser regression conversation',
    )
    await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toBeDisabled()
    await language('zh-CN')
    await expect(banner).toContainText('只读')
    await expect(
      banner.getByRole('button', { name: issue === 'newer' ? '升级后重新打开' : '新开会话', exact: true }),
    ).toBeVisible()
    await translated(page)
    await accessible(page, info, `read-only-${issue}`)
  })

test('streaming follows the bottom, preserves a reading position and resumes from new content', async ({
  page,
  runtime,
}, info) => {
  const gate = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }
  const reading = gate(),
    following = gate(),
    finished = gate()
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The installed provider must declare a fixture model')
  const provider = await startProviderFixture(
    'Synthetic auxiliary reply',
    undefined,
    model,
    async function* () {
      yield Array.from(
        { length: 80 },
        (_, index) =>
          `Streaming paragraph ${index}: synthetic browser content that makes the transcript scroll.\n\n`,
      ).join('') + 'STREAM_BOTTOM_FIRST\n\n'
      await reading.promise
      yield 'STREAM_WHILE_READING\n\n' + 'Additional synthetic paragraph.\n\n'.repeat(30)
      await following.promise
      yield 'STREAM_FOLLOW_AGAIN\n\n' + 'Final synthetic paragraph.\n\n'.repeat(30)
      await finished.promise
    },
  )
  try {
    await preferences(page)
    const initial = await client.config.get()
    const input = { providerId: 'deepseek', baseUrl: provider.baseUrl, apiKey: provider.apiKey }
    expect((await client.config.test(input)).verified).toBe(true)
    await client.config.save({
      ...input,
      model,
      accountId: 'streaming-fixture',
      label: 'Synthetic streaming fixture',
      expectedRevision: initial.revision,
      makeDefault: true,
    })
    const session = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    await page.goto(`${runtime.url}/?session=${session.id}`)
    await page
      .getByRole('textbox', { name: 'Task content', exact: true })
      .fill('Stream the synthetic conversation')
    await page.locator('#send').click()
    const viewport = page.getByRole('region', { name: 'Conversation', exact: true })
    const distance = () =>
      viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
    await expect(viewport).toContainText('STREAM_BOTTOM_FIRST')
    await expect.poll(distance).toBeLessThanOrEqual(1)
    await viewport.evaluate(async (element) => {
      element.scrollTo({ top: 0, behavior: 'instant' })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)
    reading.release()
    await expect(viewport).toContainText('STREAM_WHILE_READING')
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)
    await page.getByRole('button', { name: 'New content', exact: true }).click()
    await expect.poll(distance).toBeLessThanOrEqual(1)
    following.release()
    await expect(viewport).toContainText('STREAM_FOLLOW_AGAIN')
    await expect.poll(distance).toBeLessThanOrEqual(1)
    finished.release()
    await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toBeEnabled()
    await accessible(page, info, 'streaming-scroll')
  } finally {
    reading.release()
    following.release()
    finished.release()
    await provider.close()
  }
})

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
    preset: 'standard',
    permission: 'full-access',
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
      preset: 'standard',
      permission: 'full-access',
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
      'standard',
      '--permission',
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
      preset: 'standard',
      permission: 'full-access',
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
    await expect(page.locator('#notice')).toContainText(
      'The credential was rejected. Check it and try again.',
    )
    expect(provider.rejectedInferenceRequests).toBe(2)
    await page.screenshot({ path: info.outputPath('credential-repair-en-light.png') })
    await repair.click()
    await expect(page.getByTestId('account-page-edit')).toBeVisible()
    await expect(page.locator('#config-account-name')).toHaveValue('Revoked fixture account')
    await page.locator('#config-api-key').fill(provider.apiKey)
    await expect(page.locator('#config-save')).toHaveText('Save')
    await expect(page.locator('#config-save')).toBeEnabled()
    const revision = (await client.config.get()).revision
    await page.locator('#config-save').click()
    await expect.poll(async () => (await client.config.get()).revision).not.toBe(revision)
    // The revision commits before model publication; wait for the save RPC and UI completion.
    await expect(page.getByTestId('account-page-edit')).toBeHidden()
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
    preset: 'standard',
    permission: 'full-access',
    loop,
  })
  await session.attach()
  await prompt(session, 'call demo_text_stats {"text":"hello world"}')
  expect((await toolResult(session, 'demo_text_stats'))?.structured).toEqual({ characters: 11, words: 2 })
  await complete(client, await client.packages.disable({ ...(await command(client)), id: preview.id }))
  const fresh = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
    loop,
  })
  expect((await fresh.tools()).tools.some((tool) => tool.name === 'demo_text_stats')).toBe(false)
  await prompt(session, 'call demo_text_stats {"text":"old sessions retain their binding"}')
  expect((await toolResult(session, 'demo_text_stats'))?.structured).toMatchObject({ words: 5 })
  await info.attach('review.json', { body: JSON.stringify(preview), contentType: 'application/json' })
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
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  // MCP tools are deferred; discover the schema without bypassing normal tool authorization.
  await prompt(session, 'call tool_describe {"name":"mcp__e2e__echo"}')
  expect(JSON.stringify(await toolResult(session, 'tool_describe'))).toContain('mcp__e2e__echo')
  await prompt(session, 'call mcp__e2e__echo {"text":"E2E_MCP_STDIO"}')
  expect((await toolResult(session, 'mcp__e2e__echo'))?.content).toEqual([
    { type: 'text', text: 'E2E_MCP_STDIO' },
  ])
  const workspace = await client.workspace.add(runtime.workspace)
  const workspaceId = workspace.workspace.workspaceId
  if (!workspaceId) throw new Error('Workspace registration must return a durable id')
  await expect
    .poll(() => runtime.cli(['skills', 'list', '--workspace-id', workspaceId]))
    .toContain('e2e-playbook')
  const skills = await runtime.cli(['skills', 'list', '--workspace-id', workspaceId])
  expect(skills).toContain('e2e-playbook')
  expect(skills).toContain('trust=trusted')
  expect(skills).toContain('actual=ready')
  await prompt(session, 'call skill_read {"name":"e2e-playbook"}')
  expect(JSON.stringify(await toolResult(session, 'skill_read'))).toContain('E2E_SKILL_LOADED')
})
