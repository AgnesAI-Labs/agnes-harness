import type { DecisionSnapshot } from '@agnes/protocol'
import { installDeveloperExample } from './developer-example.js'
import { expect, test } from './fixtures.js'
import { command, install, prompt, toolResult } from './sdk.js'
import { chooseWorkspace, expandActivityGroups, preferences, turn } from './ui.js'

test('showcase full access business signature records the human principal without a pending card', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  // The showcase ships compiled: install the payload build:local packages, not the TypeScript source.
  await install(client, 'packages/cli/dist/local/bundled-examples/showcase/pharma-gmp')
  const session = await client.session.new({
    cwd: runtime.workspace,
    sessionKey: crypto.randomUUID(),
    bundles: ['@agnes-showcase/pharma-gmp#investigator'],
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  await preferences(page)
  await page.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
  await page.evaluate(() => {
    const state = window as typeof window & { businessPrompts?: number }
    state.businessPrompts = 0
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"]')) state.businessPrompts!++
    }).observe(document.body, { childList: true, subtree: true })
  })
  // The pending inbox excludes consumed decisions; the public ledger stream keeps their proof.
  const proof = new Map<string, DecisionSnapshot>()
  const events = session.events()[Symbol.asyncIterator]()
  const collecting = (async () => {
    for (;;) {
      const next = await events.next()
      if (next.done) return
      if (next.value.type === 'decision/state') {
        const snapshot = next.value.data as unknown as DecisionSnapshot
        proof.set(snapshot.handle.id, snapshot)
      }
    }
  })()
  let receipt: Awaited<ReturnType<typeof toolResult>>
  try {
    // No answer handler: this real showcase tool must complete on the Host's automatic signature.
    await prompt(
      session,
      'call pharma_record {"action":"investigate","batch":"B-2410-017","expectedRevision":0}',
    )
    receipt = await toolResult(session, 'pharma_record')
    expect(receipt?.structured).toMatchObject({
      signature: {
        signer: expect.any(String),
        confirmationMode: 'auto-confirmed under full access',
        reviewedRevision: 0,
      },
    })
    await expect
      .poll(() =>
        [...proof.values()].some((d) => d.request.spec.purpose === 'business.confirm' && !!d.consumption),
      )
      .toBe(true)
  } finally {
    await events.return?.()
    await collecting
  }
  const decisions = [...proof.values()]
  const signature = decisions.find((d) => d.request.spec.purpose === 'business.confirm')
  expect((await client.approval.list(session.id)).decisions).toEqual([])
  expect(signature).toMatchObject({
    result: {
      reason: 'answered',
      code: 'full-access',
      response: { value: 'I attest to this synthetic quality record.' },
      answeredBy: { attrs: { confirmationMode: 'auto-confirmed under full access' } },
    },
    consumption: { operationId: expect.any(String) },
    answerCommand: null,
  })
  if (signature?.result?.reason !== 'answered') throw new Error('Missing signature')
  expect(['system', 'agent']).not.toContain(signature.result.answeredBy.role)
  expect(receipt?.structured).toMatchObject({ signature: { signer: signature.result.answeredBy.id } })
  await info.attach('business-signature-proof.json', {
    body: Buffer.from(JSON.stringify({ receipt, decisions }, null, 2)),
    contentType: 'application/json',
  })
  expect(decisions.filter((d) => !d.result && !d.invalidation)).toEqual([])
  expect(
    await page.evaluate(() => (window as typeof window & { businessPrompts?: number }).businessPrompts),
  ).toBe(0)
  for (const locale of ['en', 'zh-CN']) {
    const localized = await page.context().newPage()
    const errors: string[] = []
    localized.on('pageerror', (error) => errors.push(error.message))
    try {
      await preferences(localized, locale)
      await localized.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
      const current = localized.getByTestId('conversation-turn').last()
      const toggle = current.getByTestId('turn-process-toggle')
      await expect(toggle).toBeVisible()
      if (!(await toggle.evaluate((el) => el.parentElement?.getAttribute('data-open') === 'true')))
        await toggle.click()
      await expandActivityGroups(current)
      await expect(
        localized
          .getByTestId('approval-step')
          .filter({ hasText: locale === 'en' ? 'auto-confirmed under full access' : '完全访问下自动确认' }),
      ).toContainText(signature.result.answeredBy.id)
      const recordedLabel =
        locale === 'en'
          ? `Auto-confirmed under full access (principal ${signature.result.answeredBy.id})`
          : `完全访问下自动确认（主体 ${signature.result.answeredBy.id}）`
      const evidence = localized.locator('.ph-evidence-card [data-business-confirmation]')
      await expect(evidence).toHaveText(`${recordedLabel} · r0`)
      await expect(localized.locator('.ph-evidence-card')).not.toContainText(
        locale === 'en' ? 'Signed by' : '已由真人签署',
      )
      await expect(localized.getByTestId('approval-card')).toHaveCount(0)
      await localized.screenshot({
        path: info.outputPath(`business-full-access-${locale}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      await localized.goto(
        `${runtime.url}/?page=pharma-audit&pagePackage=${encodeURIComponent('@agnes-showcase/pharma-gmp')}`,
      )
      await expect(localized.locator('[data-pharma-page="audit"]')).toContainText(recordedLabel)
      await expect(localized.locator('[data-pharma-page="audit"]')).not.toContainText(
        locale === 'en'
          ? `Signed by ${signature.result.answeredBy.id}`
          : `已由真人签署: ${signature.result.answeredBy.id}`,
      )
      await expect(localized.locator('[data-pharma-page="audit"]')).toContainText(
        signature.result.answeredBy.id,
      )
      await localized.screenshot({
        path: info.outputPath(`business-audit-${locale}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      await localized.goto(
        `${runtime.url}/?page=pharma-release&pagePackage=${encodeURIComponent('@agnes-showcase/pharma-gmp')}`,
      )
      await expect(localized.locator('[data-pharma-page="release"] [data-business-confirmation]')).toHaveText(
        recordedLabel,
      )
      await localized.screenshot({
        path: info.outputPath(`business-release-${locale}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      expect(errors).toEqual([])
    } finally {
      await localized.close()
    }
  }
})

test('fresh gallery hides teaching examples until deliberately installed, then reviews their agent launch', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(90_000)
  const client = await runtime.connect()
  expect((await client.config.get()).configured).toBe(false)
  expect((await client.session.list()).items).toHaveLength(0)
  await preferences(page)
  await page.goto(runtime.url)
  const guide = page.getByTestId('first-run-guide')
  await page.getByTestId('first-run-demo').click()
  await page.getByTestId('first-run-next').click()
  await guide
    .getByRole('button', { name: 'Enter a folder if the picker is unavailable', exact: true })
    .click()
  await guide.getByRole('textbox', { name: 'Folder path', exact: true }).fill(runtime.workspace)
  await guide.getByRole('button', { name: 'Use folder', exact: true }).click()
  await page.getByTestId('first-run-next').click()
  await page.getByTestId('first-run-next').click()
  await expect(guide).toBeHidden()
  for (const name of ['plugins', 'automation', 'agents']) {
    await page.getByTestId(`home-entry-${name}`).click()
    await expect(page.getByTestId(`home-page-${name}`)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('page')).toBe(name)
  }
  const card = page.locator('[data-agent-ref="@agnes-fde/knowledge-qa#knowledge-qa"]')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('general-agent')).toBeVisible()
  await expect(
    page.getByTestId('general-agent').getByRole('button', { name: 'Start conversation', exact: true }),
  ).toBeEnabled()
  await page.screenshot({ path: info.outputPath('gallery-fresh.png'), animations: 'disabled' })
  expect((await client.packages.list({ profile: 'local-dev' })).packages.map((row) => row.id)).not.toContain(
    '@agnes-fde/knowledge-qa',
  )
  await installDeveloperExample(page, 'examples/fde/knowledge-qa')
  await page.getByTestId('home-entry-agents').click()
  await expect(card).toContainText('Knowledge answer example')
  await page.screenshot({ path: info.outputPath('gallery-installed-teaching.png'), animations: 'disabled' })
  await card.getByRole('button', { name: 'Start now', exact: true }).click()
  const confirm = page.getByTestId('agent-start-confirm')
  await expect(confirm.or(page.getByTestId('agent-launch-review'))).toBeVisible()
  if (await confirm.isVisible()) await confirm.click()
  await expect(page.getByTestId('agent-launch-review')).toContainText('refund')
  await page.getByTestId('agent-launch-confirm').click()
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(composer).toHaveValue(/refund/)
  expect(new URL(page.url()).searchParams.get('session')).toBeTruthy()
  await expect(page.getByTestId('conversation-turn')).toHaveCount(0)
  const clientBeforeSend = await runtime.connect()
  const startedId = new URL(page.url()).searchParams.get('session')!
  const beforeSend = await clientBeforeSend.session.load(startedId, { cwd: runtime.workspace })
  expect((await beforeSend.projectUI()).turns).toHaveLength(0)
  await turn(page, await composer.inputValue())
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The FDE first turn must create a durable session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  const descriptor = await client.session.runtime(id)
  expect(descriptor.loop?.id).toBe('fde.knowledge-qa')
  expect(descriptor.preset?.bundles).toEqual(['@agnes-fde/knowledge-qa#knowledge-qa'])
  expect(descriptor.policy?.toolPolicy).toBe('fde.knowledge-qa')
  expect((await session.capabilities())?.modelRoutes.value?.primary).toEqual({
    route: 'demo',
    model: 'demo-model',
  })
  expect((await toolResult(session, 'fde_knowledge_retrieve'))?.structured).toMatchObject({
    sources: expect.arrayContaining([
      expect.objectContaining({
        citation: expect.stringContaining('fixtures/docs/'),
        quote: expect.stringContaining('refund'),
      }),
    ]),
  })
  expect((await toolResult(session, 'present'))?.isError).not.toBe(true)
  expect((await client.config.get()).accounts).toHaveLength(0)
})

test('application permission switch governs a package-fixed role launched by a quick action', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  await preferences(page, 'zh-CN')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'zh-CN')
  await install(client, 'tools/e2e-web/fixtures/confirmation-app')
  const packageId = '@fixture/confirmation-app'
  const preview = await client.request('_agnes/v1/applications.preview', { profile: 'local-dev', packageId })
  const state = await client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
  await client.request('_agnes/v1/applications.adopt', {
    ...(await command(client)),
    packageId,
    expectedRevision: state.revision,
    consentDigest: preview.consentDigest,
  })
  await page.reload()
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await page.getByRole('button', { name: '签署模拟记录', exact: true }).click()
  // Adoption already covers this unchanged role and launch configuration.
  await expect(page.getByTestId('agent-launch-review')).toHaveCount(0)
  await expect(page).toHaveURL(/session=/)
  const id = new URL(page.url()).searchParams.get('session')!
  const session = await client.session.load(id, { cwd: runtime.workspace })
  await session.attach()
  const descriptor = await client.session.runtime(id)
  expect(descriptor.preset?.bundles).toEqual(['@fixture/confirmation-app#desk'])
  await page.locator('#composer-permission').click()
  await page.locator('#permission-picker-popover [data-permission="full"]').click()
  await expect(page.locator('#composer-permission')).toContainText('完全访问')
  await page.evaluate(() => {
    const w = window as typeof window & { signaturePrompts?: number }
    w.signaturePrompts = 0
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"]')) w.signaturePrompts!++
    }).observe(document.body, { childList: true, subtree: true })
  })
  const composer = page.getByRole('textbox', { name: '任务内容', exact: true })
  await composer.fill('call acme_status synthetic')
  await composer.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 15_000,
  })
  const automatic = await toolResult(session, 'acme_status')
  expect(automatic?.structured).toMatchObject({
    confirmationMode: 'auto-confirmed under full access',
    signer: expect.any(String),
    signedMeaning: 'I confirm this synthetic record.',
  })
  expect(
    await page.evaluate(() => (window as typeof window & { signaturePrompts?: number }).signaturePrompts),
  ).toBe(0)
  const record = automatic?.structured
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.signer !== 'string')
    throw new Error('Missing signature principal')
  const active = await client.session.runtime(id)
  expect(active.policy?.permission).toEqual({ policy: 'full-access', principal: record.signer })
  const current = page.getByTestId('conversation-turn').last()
  const toggle = current.getByTestId('turn-process-toggle')
  if (!(await toggle.evaluate((el) => el.parentElement?.getAttribute('data-open') === 'true')))
    await toggle.click()
  await expandActivityGroups(current)
  await expect(page.getByTestId('approval-step').filter({ hasText: '完全访问下自动确认' })).toContainText(
    record.signer,
  )
  await page.screenshot({
    path: info.outputPath('app-full-access.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.locator('#composer-permission').click()
  await page.locator('#permission-picker-popover [data-permission="workspace"]').click()
  await composer.fill('call acme_status synthetic')
  await composer.press('Enter')
  const approval = page.getByTestId('approval-card')
  await expect(approval).toContainText('Synthetic signature')
  await expect(approval.getByRole('button', { name: '仅允许这次', exact: true })).toBeEnabled()
  await page.screenshot({
    path: info.outputPath('app-standard-prompt.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await approval.getByRole('button', { name: '仅允许这次', exact: true }).click()
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed')
  const manual = await toolResult(session, 'acme_status')
  expect(manual?.structured).toMatchObject({ confirmationMode: 'manual' })
  expect(manual?.toolUseId).not.toBe(automatic?.toolUseId)
  await info.attach('app-receipts.json', {
    body: Buffer.from(JSON.stringify({ automatic, manual, descriptor, active }, null, 2)),
    contentType: 'application/json',
  })
})
