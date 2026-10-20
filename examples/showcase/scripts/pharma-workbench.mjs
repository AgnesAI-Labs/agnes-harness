/** Scripted, isolated browser acceptance of the declared application workbench. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { runtime, toolResult, until } from '../pharma-gmp/scripts/runtime.mjs'
import { testOperatorSignatures } from './signatures.mjs'

if (!process.env.AGH_SHOWCASE_SKIP_BUILD)
  execFileSync(process.execPath, ['tools/toolchain/run.mjs', '--filter', '@agnes/cli', 'build:local'], {
    stdio: 'inherit',
    timeout: 300000,
  })
const descriptor = JSON.parse(
  await readFile(new URL('../pharma-gmp/client/agnes.client.json', import.meta.url), 'utf8'),
)
const brandModes = descriptor.skins[0].tokens['--agnes-brand-primary']
let rt
const output = resolve(process.env.AGH_SHOWCASE_SHOTS ?? 'outputs/pharma-workbench')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const evidence = {
  roots: [],
  node: process.version,
  model: 'demo-model',
  usd: 0,
  screenshots: [],
  sessions: [],
  sessionBudgets: [],
  errors: [],
  networkFailures: [],
  navigationChecks: [],
  passed: false,
}
console.log(JSON.stringify({ roots: [], output }))
const packageId = '@agnes-showcase/pharma-gmp'
let active, activeTurn
async function shot(page, label, locale, theme) {
  await page.locator('.sidebar-head').waitFor({ state: 'attached', timeout: 30000 })
  if (!['01-gallery', '02-install-review', '03-adoption-consent'].includes(label))
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--agnes-brand-primary')
          .trim()
          .toLowerCase() === expected,
      brandModes[theme].toLowerCase(),
      { timeout: 45000 },
    )
  await page.evaluate(() => document.fonts.ready)
  if (await page.locator('.task-heading').isVisible())
    assert.ok(!(await page.locator('.task-heading').innerText()).includes('applicationId'))
  const file = `${label}-${locale}-${theme}.png`
  await page.mouse.move(1598, 1098)
  await page.locator('[role="tooltip"]:visible').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(output, file), fullPage: true, animations: 'disabled' })
  evidence.screenshots.push(file)
}
async function launch(page, button) {
  const previousSession = new URL(page.url()).searchParams.get('session')
  await button.click()
  await until(
    async () => {
      const error = page.locator('.agh-banner[data-tone=error]:visible').first()
      if (await error.isVisible()) throw new Error(`Launch review failed: ${await error.innerText()}`)
      return page.getByTestId('agent-launch-review').isVisible()
    },
    Boolean,
    'launch review',
    45000,
  )
  await page.getByTestId('agent-launch-confirm').click()
  await page.waitForURL(
    (url) => {
      const id = url.searchParams.get('session')
      return Boolean(id && id !== previousSession)
    },
    { timeout: 45000 },
  )
  const id = new URL(page.url()).searchParams.get('session')
  assert.ok(id)
  const session = await rt.client.session.load(id, {
    onPermissionRequest: async (request) => ({
      optionId: request.options.find((option) => option.kind === 'allow_once').optionId,
    }),
  })
  await session.attach()
  await session.setModel({ slot: 'primary', route: 'demo', model: 'demo-model' })
  evidence.sessions.push(id)
  active = session
  await page.locator('#view-chat').click()
  return session
}
async function selectTab(page, id, title, zh) {
  const tab = page.getByTestId(`workbench-tab-application.${id}`)
  if (await tab.isVisible()) await tab.click()
  else {
    await page
      .locator('#workbench-right')
      .getByRole('button', { name: zh ? '更多' : 'More', exact: true })
      .click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
}
async function checkAlignment(page) {
  const boxes = await page.evaluate(() =>
    ['#composer', '.application-work-actions'].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, width: rect.width }
    }),
  )
  assert.ok(Math.abs(boxes[0].x - boxes[1].x) < 2, JSON.stringify(boxes))
  assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 2, JSON.stringify(boxes))
  assert.ok(!(await page.locator('#prompt').inputValue()).includes('applicationId'))
}
async function call(session, name, input) {
  const result = await session.prompt(`call ${name} ${JSON.stringify(input)}`, {
    signal: AbortSignal.timeout(90000),
  })
  assert.equal(result.reason, 'completed')
  return toolResult(session, name)
}
try {
  for (const [locale, theme] of [
    ['zh-CN', 'light'],
    ['en', 'dark'],
  ]) {
    const zh = locale === 'zh-CN'
    const sessionOffset = evidence.sessions.length
    rt = await runtime(false, 'pharma-gmp', { demoModel: true })
    evidence.roots.push(rt.root)
    console.log(JSON.stringify({ root: rt.root, locale }))
    const other = await rt.install('packages/cli/dist/local/bundled-examples/showcase/aerospace-quality')
    assert.equal(other.id, '@agnes-showcase/aerospace-quality')
    await rt.startWeb()
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
      locale,
      colorScheme: theme,
    })
    await context.addInitScript(
      ({ locale, theme }) => {
        if (window === window.top) {
          localStorage.setItem('agnes-locale', locale)
          localStorage.setItem('agnes-theme', theme)
        }
      },
      { locale, theme },
    )
    const page = await context.newPage()
    page.on('pageerror', (error) => evidence.errors.push(error.message))
    page.on('requestfailed', (request) =>
      evidence.networkFailures.push({
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      }),
    )
    page.setDefaultTimeout(30000)
    page.setDefaultNavigationTimeout(45000)
    await page.goto(rt.url + '/?page=agents')
    const card = page.locator(`[data-application="${packageId}"]`)
    await card.waitFor({ timeout: 45000 })
    await page
      .getByTestId('general-agent')
      .locator('.ant-select-content-has-value')
      .waitFor({ timeout: 45000 })
    assert.equal(await card.locator('.application-scenarios li').count(), 3)
    await shot(page, '01-gallery', locale, theme)
    await card.getByRole('button', { name: zh ? '安装并采用' : 'Install and adopt', exact: true }).click()
    await page.getByTestId('install-review').waitFor({ timeout: 45000 })
    await shot(page, '02-install-review', locale, theme)
    await page
      .getByRole('button', { name: zh ? '安装、信任并启用' : 'Install, trust and enable', exact: true })
      .click()
    await page.getByTestId('consent-summary').waitFor({ timeout: 120000 })
    await shot(page, '03-adoption-consent', locale, theme)
    await page.getByRole('button', { name: zh ? '采用此预览' : 'Adopt this preview', exact: true }).click()
    await page.locator('[data-pharma-page="home"] h1').waitFor({ timeout: 45000 })
    await page.locator('.ph-kpi').first().waitFor({ timeout: 45000 })
    await page.getByTestId('home-entry-pharma-tasks').waitFor({ timeout: 30000 })
    assert.equal(await page.getByTestId('home-entry-pharma-batches').isVisible(), false)
    assert.equal(await page.getByTestId('home-entry-aero-home').count(), 0)
    assert.equal(await page.getByTestId('home-entry-aero-tasks').count(), 0)
    await shot(page, '04-slim-overview', locale, theme)
    const navigation = await rt.client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
    assert.equal(navigation.selection.packageId, packageId)
    assert.ok(navigation.candidates.some((app) => app.packageId === other.id && app.available))
    evidence.navigationChecks.push({
      locale,
      selected: navigation.selection.packageId,
      installed: navigation.candidates,
      sidebar: await page.getByTestId('home-entries').innerText(),
    })
    await page.goto(rt.url + '/?page=plugins')
    await page.locator('#plugin-search').fill('@agnes-showcase/')
    await page.locator(`.plugin-row[data-plugin-id="${other.id}"]`).waitFor()
    await page.locator(`.plugin-row[data-plugin-id="${packageId}"]`).waitFor()
    assert.equal(await page.getByTestId('home-entry-aero-home').count(), 0)
    await shot(page, '04b-two-installed-one-adopted', locale, theme)
    await page.getByTestId('home-entry-pharma-home').click()
    await page.locator('.ph-kpi').first().waitFor({ timeout: 45000 })
    const investigation = await launch(
      page,
      page
        .locator('[data-pharma-page="home"]')
        .getByRole('button', {
          name: zh ? '调查偏差' : 'Investigate deviation',
          exact: true,
        })
        .first(),
    )
    await page.getByTestId('pharma-object-dossier').waitFor({ timeout: 45000 })
    assert.equal(
      await page.getByTestId('workbench-tab-application.current-object').getAttribute('aria-selected'),
      'true',
    )
    assert.ok(
      (await page.locator('#composer [data-testid=application-work-chip]').innerText()).includes(
        'DEV-2410-017',
      ),
    )
    await checkAlignment(page)
    await shot(page, '05-object-conversation', locale, theme)
    await page.locator('#send').click()
    await until(
      async () => (await investigation.projectUI(undefined, { surface: 'web' })).opState,
      (value) => value === null,
      'submitted request',
    )
    await page
      .locator('.process-identity [data-testid=application-attribution]')
      .first()
      .waitFor({ timeout: 45000 })
    const signing = testOperatorSignatures(rt.client, investigation, { locale })
    try {
      await call(investigation, 'pharma_record', {
        action: 'investigate',
        batch: 'B-2410-017',
        expectedRevision: 0,
      })
    } finally {
      await signing.stop()
    }
    await page
      .getByTestId('pharma-object-dossier')
      .getByText(zh ? '调查中' : 'Investigation', { exact: true })
      .waitFor({ timeout: 45000 })
    await shot(page, '07-live-tool-write', locale, theme)
    const restored = await context.newPage()
    await restored.goto(`${rt.url}/?session=${investigation.id}`)
    await restored.locator('#view-chat').click()
    await restored.getByTestId('pharma-object-dossier').waitFor({ timeout: 45000 })
    assert.ok(
      (
        await restored.locator('#transcript [data-testid=application-work-chip]').first().innerText()
      ).includes('DEV-2410-017'),
    )
    assert.ok(!(await restored.locator('#transcript').innerText()).includes('applicationId'))
    await shot(restored, '05b-restored-object', locale, theme)
    await restored.close()
    const capa = await launch(
      page,
      page
        .locator('.application-work-actions')
        .getByRole('button', { name: zh ? '起草 CAPA' : 'Draft CAPA', exact: true }),
    )
    await page.getByTestId('pharma-object-dossier').waitFor({ timeout: 45000 })
    await shot(page, '06-quick-action', locale, theme)
    await page
      .locator('#workbench-right')
      .getByRole('button', { name: zh ? '关闭此停靠面板' : 'Close this dock', exact: true })
      .click()
    await page.setViewportSize({ width: 760, height: 1100 })
    await checkAlignment(page)
    await shot(page, '06b-narrow-actions', locale, theme)
    await page.setViewportSize({ width: 400, height: 900 })
    await checkAlignment(page)
    await shot(page, '06c-mobile-actions', locale, theme)
    await page.setViewportSize({ width: 1600, height: 1100 })
    const advanceSigner = testOperatorSignatures(rt.client, capa, { locale })
    try {
      for (const [i, detail] of [
        'SIM-CAL-017: synthetic as-found T02 +4.1 C and as-left calibration reviewed; retrospective 016/017/018 impact assessment',
        'SIM-REPROCESS-017: approved synthetic reprocessing protocol, independent LOD 1.9%, QC, cleaning and EM identification/resampling reviewed',
        'SIM-EFFECT-017: three synthetic verification batches and overdue escalation effectiveness confirmed',
      ].entries())
        await call(capa, 'pharma_record', {
          action: 'advance',
          batch: 'B-2410-017',
          expectedRevision: i + 1,
          evidence: detail,
        })
    } finally {
      await advanceSigner.stop()
    }
    const review = await launch(
      page,
      page
        .locator('.application-work-actions')
        .getByRole('button', { name: zh ? '批记录复核' : 'Review batch record', exact: true }),
    )
    const reviewSigner = testOperatorSignatures(rt.client, review, { locale })
    try {
      await call(review, 'pharma_record', { action: 'review', batch: 'B-2410-017', expectedRevision: 4 })
    } finally {
      await reviewSigner.stop()
    }
    const qa = await launch(
      page,
      page
        .locator('.application-work-actions')
        .getByRole('button', { name: zh ? '发起 QA 放行' : 'Request QA release', exact: true }),
    )
    await page.getByTestId('pharma-object-dossier').waitFor({ timeout: 45000 })
    const signable = await call(qa, 'pharma_dossier', { batch: 'B-2410-017' })
    assert.equal(signable.ready, true)
    const pending = qa.prompt(
      `call pharma_release ${JSON.stringify({
        batch: 'B-2410-017',
        expectedRevision: 5,
        meaning:
          'I approve this batch for release after reviewing the complete quality dossier. / 我已审核完整质量档案，批准本批放行。',
      })}`,
      { signal: AbortSignal.timeout(90000) },
    )
    activeTurn = pending
    await until(
      async () =>
        (await rt.client.approval.list(qa.id)).decisions.find(
          (d) => d.request.spec.purpose === 'business.confirm' && !d.result && !d.invalidation,
        ),
      Boolean,
      'QA business signature',
    )
    await selectTab(page, 'signatures', zh ? '待签署' : 'Pending signatures', zh)
    const signature = page.locator('#workbench-approval-content')
    await signature.locator('[data-approval-action="durable:allowed-once"]').waitFor({ timeout: 45000 })
    await shot(page, '08-sign-in-place', locale, theme)
    await signature.locator('[data-approval-action="durable:allowed-once"]').click()
    assert.equal((await pending).reason, 'completed')
    activeTurn = undefined
    const signed = await toolResult(qa, 'pharma_release')
    assert.ok(signed.dossier.certificate)
    await selectTab(page, 'current-object', zh ? '当前对象' : 'Current object', zh)
    await page
      .getByTestId('pharma-object-dossier')
      .getByText(signed.dossier.certificate.id, { exact: true })
      .waitFor({ timeout: 45000 })
    await page
      .getByTestId('pharma-object-dossier')
      .getByText(signed.dossier.certificate.id, { exact: true })
      .scrollIntoViewIfNeeded()
    await shot(page, '08b-release-certificate', locale, theme)
    await call(qa, 'pharma_report', { kind: 'dossier', batch: 'B-2410-017', locale })
    await selectTab(page, 'evidence', zh ? '证据与报告' : 'Evidence & reports', zh)
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).waitFor({ timeout: 30000 })
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).scrollIntoViewIfNeeded()
    await shot(page, '09-evidence-reports', locale, theme)
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).click()
    await page.getByTestId('file-view-preview').click()
    await page.frameLocator('[data-document-preview="html"] iframe').locator('h1').waitFor({ timeout: 30000 })
    await shot(page, '10-report-preview', locale, theme)
    for (const id of evidence.sessions.slice(sessionOffset)) {
      const budget = await rt.client.sessions.get(id).budget()
      assert.equal(budget.state.creditsUsed, 0)
      evidence.sessionBudgets.push({ id, creditsUsed: budget.state.creditsUsed })
    }
    await context.close()
    await rt.dispose()
    rt = undefined
  }
  assert.deepEqual(evidence.errors, [])
  evidence.passed = true
} catch (error) {
  evidence.failure = String(error.stack ?? error)
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page.screenshot({ path: join(output, 'diagnostic-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2).replaceAll(homedir(), '~'))
  await browser.close()
  if (activeTurn) {
    await active?.cancel().catch(() => {})
    await activeTurn.catch(() => {})
  }
  await rt?.dispose()
}
